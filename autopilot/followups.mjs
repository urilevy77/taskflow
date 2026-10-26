#!/usr/bin/env node
// @ts-check
// followups.mjs — "who should I nudge today", with a ready-to-send message for each.
//
// The cadence maths already exists (followup-cadence.mjs: applied → first nudge after N days, then every
// M days; interview → thank-you; responded → answer them). Nothing showed it to the user. This turns its
// result into a short list for the daily email and the site, and records what the user did about each:
//
//   followed   appends `- <date> · #<n> <company> — <note>` to data/follow-ups.md (a logged follow-up;
//              the clock restarts from that date)
//   retire     appends `- cleared #<n> <date> — <note>` (drops the application out of the cadence; the
//              tracker row keeps its status)
//
// Zero LLM tokens: the drafts are fixed templates over the tracker row and config/profile.yml. Nothing is
// sent anywhere — the user copies the draft into their own mail/LinkedIn. Both writes go through the
// follow-ups lock, the same one followup-seed.mjs uses.
//
//   node autopilot/followups.mjs                  list what is due
//   node autopilot/followups.mjs --followed 135   log a follow-up sent today
//   node autopilot/followups.mjs --retire 135
//   node autopilot/followups.mjs --self-test

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot, resolveTrackerPath } from '../path-resolver.mjs';
import { flagValue, hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { localToday } from '../lib/local-today.mjs';
import { analyzeFromContent, contactLabel } from '../followup-cadence.mjs';
import { withFollowupsLock } from '../followup-seed.mjs';

const ROOT = getCareerOpsRoot();
const read = (p) => { try { return existsSync(p) ? readFileSync(p, 'utf-8') : ''; } catch { return ''; } };

const URGENCY_RANK = { urgent: 0, overdue: 1 };
const KIND = { applied: 'nudge', responded: 'reply', interview: 'thanks' };

/** The candidate's name for the sign-off, from config/profile.yml. '' when unknown. */
export function candidateName(root = ROOT) {
  try { return String(yaml.load(read(join(root, 'config', 'profile.yml')))?.candidate?.full_name ?? '').trim(); } catch { return ''; }
}

/** First name of a contact label ("Nina Knopp" → "Nina"); an e-mail address or nothing → ''. */
const firstName = (contact) => {
  const name = contact?.name && !String(contact.name).includes('@') ? String(contact.name).trim() : '';
  return name.split(/\s+/)[0] ?? '';
};

/** Company names the tracker could not fill in are "?" — never print them as if they were a company. */
const hasCompany = (company) => Boolean(company) && !/^[?\s-]*$/.test(String(company));

/**
 * Pure: the message to copy, by what is due.
 *   nudge   applied, no answer          first or later "any news?"
 *   thanks  interview                   thank-you / check-in
 *   reply   they answered               nothing to template — the user writes this one
 */
export function buildDraft(entry, name = '') {
  const kind = KIND[entry.status] ?? 'nudge';
  if (kind === 'reply') return { kind, text: '' };
  const hello = firstName(entry.contacts?.[0]) ? `Hi ${firstName(entry.contacts[0])},` : 'Hi,';
  const title = String(entry.role ?? '').trim();
  const role = title && !/^job lead/i.test(title) ? `the ${title} role` : 'the position'; // intake rows can carry a placeholder title
  const at = hasCompany(entry.company) ? ` at ${entry.company}` : '';
  const sign = name ? `\n\nBest regards,\n${name}` : '\n\nBest regards';
  if (kind === 'thanks') {
    return { kind, text: `${hello}\n\nThank you for taking the time to speak with me about ${role}${at}. I enjoyed learning more about it and I'm still very interested. Please let me know if there is anything else I can send you.${sign}` };
  }
  const when = entry.daysSinceApplication > 0 ? `${entry.daysSinceApplication} days ago` : 'recently';
  const text = entry.followupCount > 0
    ? `${hello}\n\nI'm following up on my earlier message about ${role}${at}. I'm still very interested and would be glad to hear where things stand, or to send anything that would help.${sign}`
    : `${hello}\n\nI applied for ${role}${at} ${when} and wanted to check in on its status. I'm still very interested and happy to send anything that would help.${sign}`;
  return { kind, text };
}

/**
 * Pure: what is due now. applied / responded / interview rows whose cadence says overdue or urgent,
 * most urgent first, then the longest wait. Cold rows (the follow-up cap is reached) are not "due".
 * → { total, items } with items capped at `cap`.
 */
export function selectDue(analysis, { cap = Infinity, name = '' } = {}) {
  const due = (analysis?.entries ?? [])
    .filter((e) => e.urgency in URGENCY_RANK && e.status in KIND)
    .sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || (a.daysUntilNext ?? 0) - (b.daysUntilNext ?? 0) || a.num - b.num)
    .map((e) => ({
      num: e.num,
      company: hasCompany(e.company) ? e.company : '',
      role: e.role ?? '',
      status: e.status,
      urgency: e.urgency,
      daysSinceApplication: e.daysSinceApplication,
      overdueDays: e.daysUntilNext != null && e.daysUntilNext < 0 ? -e.daysUntilNext : 0,
      followupCount: e.followupCount,
      contact: contactLabel(e.contacts?.[0]) === '-' ? '' : contactLabel(e.contacts?.[0]),
      draft: buildDraft(e, name),
    }));
  return { total: due.length, items: due.slice(0, cap) };
}

/** Reads the tracker + follow-ups.md and returns what is due. Never throws: unreadable → nothing due. */
export function loadDue(root = ROOT, { cap = Infinity } = {}) {
  try {
    const tracker = read(resolveTrackerPath(root));
    if (!tracker) return { total: 0, items: [] };
    const analysis = analyzeFromContent(tracker, read(join(root, 'data', 'follow-ups.md')));
    return analysis.error ? { total: 0, items: [] } : selectDue(analysis, { cap, name: candidateName(root) });
  } catch { return { total: 0, items: [] }; }
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/[|]/g, '/').trim();

/** Pure: the follow-ups.md line for a logged follow-up. */
export const followedLine = (num, company, date, note = 'nudge sent') => `- ${date} · #${num} ${oneLine(company) || '?'} — ${oneLine(note)}`;
/** Pure: the follow-ups.md line that retires an application from the cadence. */
export const clearedLine = (num, date, note = 'retired from the site') => `- cleared #${num} ${date} — ${oneLine(note)}`;

/** Pure: `text` with `line` appended (blank-line safe). Same line twice → unchanged, so a re-synced mark is a no-op. */
export function appendLine(text, line) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines.some((l) => l.trim() === line.trim())) return { text, added: false };
  const body = String(text ?? '').replace(/\s+$/, '');
  return { text: `${body ? `${body}\n` : ''}${line}\n`, added: true };
}

const FU_HEADER = '# Follow-ups\n\n| num | appNum | date | company | role | channel | contact | notes |\n|---|---|---|---|---|---|---|---|\n';

async function writeDirective(line, root) {
  const file = join(root, 'data', 'follow-ups.md');
  return withFollowupsLock(file, async () => {
    const r = appendLine(read(file) || FU_HEADER, line);
    if (r.added) writeFileSync(file, r.text);
    return r.added;
  });
}

/** Log "I sent the follow-up" for tracker row `num`. → one line for the console / sync report. */
export async function recordFollowed(num, { root = ROOT, today = localToday(), company = '' } = {}) {
  const name = company || loadDue(root).items.find((i) => i.num === num)?.company || '';
  return (await writeDirective(followedLine(num, name, today), root)) ? `#${num}: follow-up logged ${today}` : `#${num}: already logged today — left as is`;
}

/** Drop row `num` out of the cadence. */
export async function recordRetired(num, { root = ROOT, today = localToday() } = {}) {
  return (await writeDirective(clearedLine(num, today), root)) ? `#${num}: retired from follow-ups` : `#${num}: already retired — left as is`;
}

/** "135=followed,136=retire" → [{ num, action }]; malformed → null. */
export function parseFollowupMarks(spec) {
  const out = String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((p) => p.match(/^(\d{1,6})=(followed|retire)$/)).map((m) => (m ? { num: Number(m[1]), action: m[2] } : null));
  return out.length && out.every(Boolean) ? /** @type {{num:number, action:string}[]} */ (out) : null;
}

/** Applies marks made on the site's follow-ups page. Only rows that are actually due are touched. */
export async function applyFollowupMarks(marks, { root = ROOT, today = localToday() } = {}) {
  const due = loadDue(root).items;
  const lines = [];
  for (const { num, action } of marks) {
    const item = due.find((i) => i.num === num);
    if (!item) { lines.push(`#${num}: not due any more — skipped`); continue; }
    lines.push(action === 'followed' ? await recordFollowed(num, { root, today, company: item.company }) : await recordRetired(num, { root, today }));
  }
  return lines;
}

// ── self-test ──────────────────────────────────────────────────────────────────────────────────────
async function selfTest() {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  let failed = 0;
  const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++; };

  const base = { num: 7, company: 'Acme', role: 'Backend Engineer', status: 'applied', daysSinceApplication: 9, followupCount: 0, contacts: [] };
  const first = buildDraft(base, 'Uri Levy').text;
  check('placeholder title becomes "the position"', /applied for the position at Acme/.test(buildDraft({ ...base, role: 'Job lead (WhatsApp)' }).text));
  check('first nudge names role, company, days and signs off', /the Backend Engineer role at Acme 9 days ago/.test(first) && first.endsWith('Uri Levy') && first.startsWith('Hi,'));
  check('later nudge refers to the earlier message', /following up on my earlier message/.test(buildDraft({ ...base, followupCount: 1 }).text));
  check('contact first name greets; an e-mail contact does not', buildDraft({ ...base, contacts: [{ name: 'Nina Knopp' }] }).text.startsWith('Hi Nina,') && buildDraft({ ...base, contacts: [{ email: 'a@b.com' }] }).text.startsWith('Hi,'));
  check('unknown company ("?") is left out of the sentence', !/ at \?/.test(buildDraft({ ...base, company: '?' }).text) && /the Backend Engineer role 9 days ago/.test(buildDraft({ ...base, company: '?' }).text));
  check('interview → thank-you; responded → no template', /Thank you for taking the time/.test(buildDraft({ ...base, status: 'interview' }).text) && buildDraft({ ...base, status: 'responded' }).text === '');

  const analysis = { entries: [
    { ...base, num: 1, urgency: 'overdue', daysUntilNext: -3 },
    { ...base, num: 2, urgency: 'overdue', daysUntilNext: -20 },
    { ...base, num: 3, urgency: 'urgent', status: 'responded', daysUntilNext: -1 },
    { ...base, num: 4, urgency: 'cold', daysUntilNext: null },
    { ...base, num: 5, urgency: 'waiting', daysUntilNext: 2 },
  ] };
  const due = selectDue(analysis);
  check('due = urgent first, then longest wait; cold and waiting are not due', due.items.map((i) => i.num).join() === '3,2,1' && due.total === 3);
  check('cap trims the items but not the total', selectDue(analysis, { cap: 1 }).items.length === 1 && selectDue(analysis, { cap: 1 }).total === 3);

  check('appendLine adds once, never twice', appendLine('a\n', '- x').text === 'a\n- x\n' && !appendLine('a\n- x\n', '- x').added);
  check('followed line is one parseable line', followedLine(9, 'A | B', '2026-10-15') === '- 2026-10-15 · #9 A / B — nudge sent');
  check('parseFollowupMarks accepts followed/retire only', parseFollowupMarks('1=followed,2=retire')?.length === 2 && parseFollowupMarks('1=applied') === null && parseFollowupMarks('') === null);

  // End to end on a sandbox: a logged follow-up restarts the clock; a retire drops the row.
  const root = mkdtempSync(join(tmpdir(), 'fu-'));
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    writeFileSync(join(root, 'data', 'applications.md'), `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |\n|---|------|---------|------|-------|--------|-----|--------|-------|-----|\n| 7 | ${d(12)} | Acme | Backend Engineer | 4.0/5 | Applied | ❌ | - | applied via phone | https://acme.example/j |\n| 8 | ${d(12)} | Beta | Data Engineer | 4.0/5 | Applied | ❌ | - | applied via phone | https://beta.example/j |\n`);
    check('sandbox: both rows are due', loadDue(root).items.map((i) => i.num).sort().join() === '7,8');
    const logged = await applyFollowupMarks([{ num: 7, action: 'followed' }, { num: 8, action: 'retire' }, { num: 99, action: 'followed' }], { root, today: d(0) });
    check('marks reported per row', logged.length === 3 && /logged/.test(logged[0]) && /retired/.test(logged[1]) && /not due/.test(logged[2]));
    check('after "followed" and "retire" nothing is due', loadDue(root).total === 0);
    const again = await recordFollowed(7, { root, today: d(0), company: 'Acme' });
    check('the same mark twice is a no-op', /already/.test(again));
    check('follow-ups.md got a header and both lines', /\| num \|/.test(readFileSync(join(root, 'data', 'follow-ups.md'), 'utf-8')) && /cleared #8/.test(readFileSync(join(root, 'data', 'follow-ups.md'), 'utf-8')));
  } finally { rmSync(root, { recursive: true, force: true }); }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--self-test')) await selfTest();
  else if (hasFlag(args, '--followed') || hasFlag(args, '--retire')) {
    const followed = hasFlag(args, '--followed');
    const num = Number(flagValue(args, followed ? '--followed' : '--retire'));
    if (!Number.isInteger(num) || num <= 0) { console.error('Usage: node autopilot/followups.mjs --followed <tracker #> | --retire <tracker #>'); process.exitCode = 1; }
    else console.log(followed ? await recordFollowed(num) : await recordRetired(num));
  } else {
    const { total, items } = loadDue();
    console.log(`${total} follow-up(s) due`);
    for (const i of items) console.log(`  #${i.num} ${i.company || '?'} — ${i.role} · ${i.status} · ${i.urgency}${i.overdueDays ? ` ${i.overdueDays}d` : ''}`);
  }
}
