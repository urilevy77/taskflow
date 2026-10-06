#!/usr/bin/env node
// @ts-check
// dedup-intake.mjs — stage 3b of the daily run (design/daily-task-design.md §11).
//
// The same job often arrives twice: as a LinkedIn link in a WhatsApp group AND as a Lever/Comeet
// link from the board scan. The scan dedups by URL + company/role against the tracker, but WhatsApp
// intake dedups by exact URL only, and its rows are bare until enrich fills in company + title.
// So after enrich and before triage (which costs an LLM call per row), this stage matches the
// untriaged rows by company + role — with the scanner's own key (`companyRoleDedupKey`, imported,
// not reimplemented) — against:
//   · the tracker                            → dup-of: tracker #N
//   · already-triaged / done pipeline rows   → dup-of: <url>
//   · the other untriaged rows of this batch → the best URL is kept, the rest dup-of it
//
// A duplicate is marked `| dup-of: …` and ticked [x], so it is never triaged. The kept row gets
// `| also-seen: host, host` so no source is lost. Rows with no company or title (still bare after
// enrich) cannot be matched and pass through; prepare's tracker check is the backstop.
//
// Zero tokens. Writes data/pipeline.md only with --write, under the pipeline lock.
//
//   node autopilot/dedup-intake.mjs            # report only
//   node autopilot/dedup-intake.mjs --write
//   node autopilot/dedup-intake.mjs --self-test

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCareerOpsRoot, resolveTrackerPath } from '../path-resolver.mjs';
import { hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { companyRoleDedupKey } from '../scan.mjs';
import { parseTrackerRows } from '../find.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';
import { normalizeUrl } from '../url-key.mjs';
import { parsePipelineRow } from './prepare.mjs';

const ROOT = getCareerOpsRoot();
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const DUP_LABEL = '| dup-of:';
const ALSO_LABEL = '| also-seen:';

// Lower is better: a real ATS link has an API JD and a direct apply form; a social link has neither.
const ATS_HOST = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|comeet\.com|workable\.com|smartrecruiters\.com|recruitee\.com|myworkdayjobs\.com|icims\.com|breezy\.hr|jobs\.eu\.lever\.co)$/;
const SOCIAL_HOST = /(^|\.)(linkedin\.com|facebook\.com|fb\.com|wa\.me|whatsapp\.com|t\.me|youtube\.com|youtu\.be|instagram\.com|x\.com|twitter\.com)$/;

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

export function urlRank(url) {
  const h = hostOf(url);
  if (!h) return 9;
  if (ATS_HOST.test(h)) return 0;
  if (SOCIAL_HOST.test(h)) return h.includes('linkedin') ? 3 : 4;
  return 1; // the company's own careers page
}

// Intake placeholders say nothing about the job: two different WhatsApp links for one company both read
// "Job lead (WhatsApp)", and matching on that would merge different roles.
const PLACEHOLDER_TITLE = /^(job lead|untitled|unknown|n[/]a|-+)(?![a-z])/i;
export const keyOf = (company, title) => {
  const c = String(company ?? '').trim(), t = String(title ?? '').trim();
  return c && t && !PLACEHOLDER_TITLE.test(t) ? companyRoleDedupKey(company, title) : null;
};

/**
 * @param {string} text  pipeline.md contents
 * @param {{company: string, role: string, trackerNum?: string|number}[]} trackerRows
 * @returns {{ text: string, dups: {url: string, dupOf: string, company: string, title: string}[], merged: {url: string, alsoSeen: string[]}[] }}
 */
export function dedupPipelineText(text, trackerRows = []) {
  const lines = String(text ?? '').split('\n');
  const rows = lines.map((l) => parsePipelineRow(l.replace(/\r$/, '')));

  /** @type {Map<string, string>} key → label of what it duplicates */
  const reference = new Map();
  for (const t of trackerRows) {
    const k = keyOf(t.company, t.role);
    if (k && !reference.has(k)) reference.set(k, `tracker #${t.trackerNum ?? '?'}`);
  }
  const isCandidate = (r, line) => r && !r.done && !r.triage && !line.includes(DUP_LABEL) && keyOf(r.company, r.title);
  rows.forEach((r, i) => {
    if (!r || isCandidate(r, lines[i])) return;
    const k = keyOf(r.company, r.title);
    if (k && !reference.has(k) && (r.triage || r.done) && !lines[i].includes(DUP_LABEL)) reference.set(k, r.url);
  });

  /** @type {Map<string, number[]>} */
  const groups = new Map();
  rows.forEach((r, i) => {
    if (!isCandidate(r, lines[i])) return;
    const k = /** @type {string} */ (keyOf(r.company, r.title));
    groups.set(k, [...(groups.get(k) ?? []), i]);
  });

  const dups = [], merged = [];
  const edits = new Map(); // line index → transformed line
  const markDup = (i, dupOf) => {
    const cr = lines[i].endsWith('\r') ? '\r' : '';
    const body = cr ? lines[i].slice(0, -1) : lines[i];
    edits.set(i, `${body.replace(/^- \[ \] /, '- [x] ')} ${DUP_LABEL} ${dupOf}${cr}`);
    dups.push({ url: rows[i].url, dupOf, company: rows[i].company, title: rows[i].title });
  };

  for (const [k, idxs] of groups) {
    if (reference.has(k)) { for (const i of idxs) markDup(i, /** @type {string} */ (reference.get(k))); continue; }
    if (idxs.length < 2) continue;
    // Same URL twice is the scanner's job (and harmless here); only distinct URLs are cross-source duplicates.
    const distinct = new Map(idxs.map((i) => [normalizeUrl(rows[i].url), i]));
    if (distinct.size < 2) continue;
    const ordered = [...idxs].sort((a, b) => urlRank(rows[a].url) - urlRank(rows[b].url) || a - b);
    const keep = ordered[0];
    const others = ordered.slice(1).filter((i) => normalizeUrl(rows[i].url) !== normalizeUrl(rows[keep].url));
    for (const i of others) markDup(i, rows[keep].url);
    const hosts = [...new Set([keep, ...others].map((i) => hostOf(rows[i].url)).filter(Boolean))];
    if (hosts.length > 1 && !lines[keep].includes(ALSO_LABEL)) {
      const cr = lines[keep].endsWith('\r') ? '\r' : '';
      const body = cr ? lines[keep].slice(0, -1) : lines[keep];
      edits.set(keep, `${body} ${ALSO_LABEL} ${hosts.join(', ')}${cr}`);
      merged.push({ url: rows[keep].url, alsoSeen: hosts });
    }
  }

  return { text: lines.map((l, i) => edits.get(i) ?? l).join('\n'), dups, merged };
}

export async function runDedup({ write = false } = {}) {
  if (!existsSync(PIPELINE_PATH)) return { dups: [], merged: [], summary: 'no data/pipeline.md — nothing to dedup' };
  const trackerPath = resolveTrackerPath(ROOT);
  const trackerRows = existsSync(trackerPath) ? parseTrackerRows(readFileSync(trackerPath, 'utf-8')) : [];
  let result = dedupPipelineText(readFileSync(PIPELINE_PATH, 'utf-8'), trackerRows);
  if (write && (result.dups.length || result.merged.length)) {
    await withPipelineLock(PIPELINE_PATH, () => {
      // Re-read and recompute inside the lock: the scan may have appended rows since the first read.
      result = dedupPipelineText(readFileSync(PIPELINE_PATH, 'utf-8'), trackerRows);
      writeFileSync(PIPELINE_PATH, result.text);
    });
  }
  const tail = write ? '' : ' (report only — pass --write)';
  return { ...result, summary: `${result.dups.length} duplicate(s) marked, ${result.merged.length} kept row(s) annotated with also-seen${tail}` };
}

// ---------------------------------------------------------------------------

function selfTest() {
  let pass = 0, fail = 0;
  const check = (n, c) => { if (c) pass += 1; else { fail += 1; console.error(`FAIL: ${n}`); } };

  check('ATS beats LinkedIn', urlRank('https://jobs.lever.co/acme/1') < urlRank('https://www.linkedin.com/jobs/view/9'));
  check('careers page beats LinkedIn', urlRank('https://acme.co.il/careers/1') < urlRank('https://www.linkedin.com/jobs/view/9'));
  check('LinkedIn beats social', urlRank('https://www.linkedin.com/jobs/view/9') < urlRank('https://www.facebook.com/x'));

  const li = '- [ ] https://www.linkedin.com/jobs/view/111 | Mobileye | Software Engineer | Jerusalem';
  const lv = '- [ ] https://jobs.lever.co/mobileye/abc | Mobileye | Software Engineer | Jerusalem, Israel';
  const other = '- [ ] https://www.linkedin.com/jobs/view/222 | Acme | Data Engineer | Tel Aviv';
  const bare = '- [ ] https://www.linkedin.com/jobs/view/333';
  const r1 = dedupPipelineText([li, lv, other, bare].join('\r\n'));
  check('LinkedIn copy is marked dup of the Lever row', r1.dups.length === 1 && r1.dups[0].url.includes('linkedin') && r1.dups[0].dupOf === 'https://jobs.lever.co/mobileye/abc');
  check('dup is ticked [x] and labelled', r1.text.includes('- [x] https://www.linkedin.com/jobs/view/111') && r1.text.includes('| dup-of: https://jobs.lever.co/mobileye/abc'));
  check('kept row records also-seen', r1.merged.length === 1 && r1.text.includes('| also-seen: jobs.lever.co, linkedin.com'));
  check('unrelated and bare rows are untouched', r1.text.includes(other) && r1.text.includes(bare));
  check('CRLF preserved', r1.text.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r')));

  const tracker = [{ company: 'Acme', role: 'Data Engineer', trackerNum: 42 }];
  const r2 = dedupPipelineText(other, tracker);
  check('matches the tracker', r2.dups.length === 1 && r2.dups[0].dupOf === 'tracker #42');

  const triaged = '- [x] https://x.com/old | Acme | Data Engineer | TLV | lane: il-source | triage: FAIL 2.0/5 — no';
  const r3 = dedupPipelineText([triaged, other].join('\n'));
  check('matches an already-triaged row', r3.dups.length === 1 && r3.dups[0].dupOf === 'https://x.com/old');

  const r4 = dedupPipelineText([lv, lv].join('\n'));
  check('the same URL twice is left to the scanner', r4.dups.length === 0 && r4.text === [lv, lv].join('\n'));

  const r5 = dedupPipelineText(r1.text.replace(/\r/g, ''));
  check('idempotent (second pass changes nothing)', r5.dups.length === 0 && r5.merged.length === 0);

  const ph1 = '- [ ] https://www.linkedin.com/jobs/view/1 | Mobileye | Job lead (WhatsApp) | IL';
  const ph2 = '- [x] https://jobs.lever.co/mobileye/x | Mobileye | Job lead (WhatsApp) | IL | triage: FAIL 2.0/5 — no';
  check('placeholder titles are never matched', dedupPipelineText(`${ph1}\n${ph2}`).dups.length === 0 && keyOf('Mobileye', 'Job lead (WhatsApp)') === null);

  const nearMiss = '- [ ] https://jobs.lever.co/mobileye/zzz | Mobileye | Senior Software Engineer | Jerusalem';
  check('a different role title is not a duplicate', dedupPipelineText([lv, nearMiss].join('\n')).dups.length === 0);

  console.log(`dedup-intake.mjs self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--self-test')) process.exitCode = selfTest() ? 0 : 1;
  else {
    const res = await runDedup({ write: hasFlag(args, '--write') });
    for (const d of res.dups) console.log(`  dup  ${d.company} — ${d.title}  (${d.url.slice(0, 60)}) → ${d.dupOf.slice(0, 60)}`);
    console.log(res.summary);
  }
}
