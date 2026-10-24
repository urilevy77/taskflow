#!/usr/bin/env node
// @ts-check
// experience-gate.mjs — the free junior-only filter of the daily run (zero LLM tokens).
//
// Uri's rule (2026-10-24): junior roles only, at most MAX_YEARS (2) years asked. The title filter in
// portals.yml drops "Senior/Lead/…" titles, but a plain "Data Engineer" title can still ask for 5
// years — only the JD says so. This reads the JD of every new pending row in data/pipeline.md and
// closes the ones that ask for more, BEFORE the LLM triage spends tokens on them:
//
//   asks > 2 years  → `- [x] … | exp: 4y | triage: FAIL 0.0/5 — Asks 4+ years (max 2): "…"`
//                     (shown on the site's Filtered page, where "Move to Pass" still overrides it)
//   asks ≤ 2 years  → `| exp: ok`        kept for triage
//   no years stated → `| exp: unstated`  kept — many junior postings never say
//   JD unreadable   → `| exp: unread`    kept — triage (which can fetch more) decides
//
// The JD text it fetches is saved under jds/ with triage-run.mjs's naming, so triage reuses it instead
// of fetching again. Rows that already carry `exp:` or `triage:` are never re-read, except with
// --include-triaged, which re-checks pending PASS/MARGINAL rows triaged before this gate existed.
//
// Usage:
//   node autopilot/experience-gate.mjs                    # gate new rows, write pipeline.md
//   node autopilot/experience-gate.mjs --dry-run          # fetch + decide, print, write nothing
//   node autopilot/experience-gate.mjs --include-triaged  # also re-check pending PASS/MARGINAL rows
//   node autopilot/experience-gate.mjs --limit 50         # cap JD fetches this run (default 200)
//   node autopilot/experience-gate.mjs --self-test

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';
import { flagValue, hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { fetchJdViaKnownApi, jdHtmlToText } from '../browser-extract.mjs';
import { formatTriageSegment } from './triage-run.mjs';
import { classifyLinkedInUrl, findSkipReason, extractHost } from './enrich-leads.mjs';
import { juniorVerdict, MAX_YEARS } from './experience.mjs';

const ROOT = getCareerOpsRoot();
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const JDS_DIR = join(ROOT, 'jds');

const DEFAULT_LIMIT = 200;
const FETCH_TIMEOUT_MS = 10_000;
const SPACING_MS = 250;
const LINKEDIN_SPACING_MS = 1_000; // the guest endpoint is rate-limit sensitive (same reason as enrich-leads.mjs)
const MIN_JD_CHARS = 300; // less than this is a nav/footer shell, not a JD
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Row selection + rewriting (pure)
// ---------------------------------------------------------------------------

const EXP_SEG_RE = /\|\s*exp:\s/;
const TRIAGE_SEG_RE = /\|\s*triage:\s*(PASS|MARGINAL|FAIL|SKIP)\b/i;

/** Pending rows the gate should read. Pure. */
export function selectGateRows(text, { includeTriaged = false } = {}) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('- [ ] ') || EXP_SEG_RE.test(line) || /\|\s*dup-of:/.test(line)) continue;
    const t = line.match(TRIAGE_SEG_RE);
    if (t && !(includeTriaged && /PASS|MARGINAL/i.test(t[1]))) continue;
    if (/moved to PASS by you/.test(line)) continue; // your override stands
    const cells = line.slice(6).split(' | ').map((c) => c.trim());
    out.push({ raw: line, url: cells[0] ?? '', company: cells[1] ?? '', title: cells[2] ?? '', triaged: Boolean(t) });
  }
  return out;
}

/**
 * The new text of one row for a gate decision. An untriaged row gets `exp:` (+ a FAIL verdict when
 * dropped); a triaged row being re-checked gets `exp:` inserted before its triage segment, and on a
 * drop that verdict is replaced, keeping the old one in the reason. Pure.
 */
export function gatedLine(line, decision) {
  const tag = decision.verdict === 'drop' ? `exp: ${decision.minYears}y` : `exp: ${decision.verdict}`;
  const idx = line.search(/ \|\s*triage:/);
  const head = idx >= 0 ? line.slice(0, idx) : line;
  const oldTriage = idx >= 0 ? line.slice(idx).replace(/^ \|\s*triage:\s*/, '') : '';
  if (decision.verdict !== 'drop') return idx >= 0 ? `${head} | ${tag}${line.slice(idx)}` : `${line} | ${tag}`;
  const why = `Asks ${decision.minYears}+ years (max ${MAX_YEARS}): "${decision.worst?.snippet ?? ''}"${oldTriage ? ` (was ${oldTriage.slice(0, 60)})` : ''}`;
  return `- [x] ${head.slice(6)} | ${tag} | ${formatTriageSegment('FAIL', 0, why)}`;
}

/** Applies {raw → next} rewrites by exact line match, keeping CRLF. Pure. */
export function applyGate(text, rewrites) {
  const map = new Map(rewrites.map((r) => [r.raw, r.next]));
  let written = 0;
  const out = String(text ?? '').split('\n').map((raw) => {
    const cr = raw.endsWith('\r') ? '\r' : '';
    const body = cr ? raw.slice(0, -1) : raw;
    if (!map.has(body)) return raw;
    written += 1;
    const next = map.get(body);
    map.delete(body);
    return next + cr;
  }).join('\n');
  return { text: out, written };
}

/** LinkedIn guest HTML → the description text, or ''. Pure. */
export function linkedInDescription(html) {
  const m = /class=["'][^"']*show-more-less-html__markup[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(String(html ?? ''));
  return m ? jdHtmlToText(m[1]) : '';
}

/** The `description` of the first schema.org JobPosting in a page's JSON-LD, as text, or ''. Pure. */
export function jsonLdDescription(html) {
  for (const m of String(html ?? '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let json;
    try { json = JSON.parse(m[1]); } catch { continue; }
    for (const c of [json, ...(Array.isArray(json) ? json : []), ...(Array.isArray(json?.['@graph']) ? json['@graph'] : [])]) {
      const type = c?.['@type'];
      if ((type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) && typeof c.description === 'string') return jdHtmlToText(c.description);
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// JD text (network)
// ---------------------------------------------------------------------------

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/json' }, redirect: 'follow', signal: controller.signal });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const shortHash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'job';

/** An existing jds/ capture for this URL (`*-{sha1(url)[0:10]}.md`, the naming triage-run.mjs uses) → its path, else null. */
function findCapture(url) {
  if (!existsSync(JDS_DIR)) return null;
  const suffix = `-${shortHash(url)}.md`;
  const hit = readdirSync(JDS_DIR).find((f) => f.endsWith(suffix));
  return hit ? join(JDS_DIR, hit) : null;
}

/** @returns {Promise<{text: string, source: string, saved: boolean}>} */
async function jdTextFor(row) {
  const local = findCapture(row.url);
  if (local) {
    try { return { text: readFileSync(local, 'utf-8'), source: 'jds/', saved: true }; } catch { /* fall through */ }
  }
  const host = extractHost(row.url);
  if (!host || findSkipReason(host)) return { text: '', source: 'skip-host', saved: false };

  const api = await fetchJdViaKnownApi(row.url).catch(() => null);
  if (api?.text) return { text: api.text, source: 'ats-api', saved: false };

  if (/(^|\.)linkedin\.com$/.test(host)) {
    const li = classifyLinkedInUrl(row.url);
    if (li.kind !== 'job') return { text: '', source: 'linkedin-not-a-job', saved: false };
    await sleep(LINKEDIN_SPACING_MS);
    const html = await fetchHtml(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${li.id}`);
    return { text: linkedInDescription(html), source: 'linkedin', saved: false };
  }

  await sleep(SPACING_MS);
  const html = await fetchHtml(row.url);
  if (!html) return { text: '', source: 'fetch-failed', saved: false };
  const ldText = jsonLdDescription(html);
  return { text: ldText.length >= MIN_JD_CHARS ? ldText : jdHtmlToText(html), source: ldText ? 'json-ld' : 'page', saved: false };
}

function saveCapture(row, text) {
  mkdirSync(JDS_DIR, { recursive: true });
  const file = `${slug(row.company)}-${slug(row.title)}-${shortHash(row.url)}.md`;
  writeFileSync(join(JDS_DIR, file), `# ${row.company} — ${row.title}\n\nSource: ${row.url}\n\n${text}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runGate({ dryRun = false, includeTriaged = false, limit = DEFAULT_LIMIT } = {}) {
  if (!existsSync(PIPELINE_PATH)) return { summary: 'no data/pipeline.md — nothing to gate', drops: [] };
  const rows = selectGateRows(readFileSync(PIPELINE_PATH, 'utf-8'), { includeTriaged }).slice(0, limit);
  const counts = { ok: 0, unstated: 0, unread: 0, drop: 0 };
  const rewrites = [];
  const drops = [];
  for (const row of rows) {
    const jd = await jdTextFor(row);
    let decision;
    if (jd.text.length < MIN_JD_CHARS) decision = { verdict: 'unread', minYears: null, worst: null };
    else {
      decision = juniorVerdict(jd.text);
      // Only a kept row is worth a capture: triage reads it next instead of fetching again.
      if (!dryRun && !jd.saved && decision.verdict !== 'drop') saveCapture(row, jd.text);
    }
    counts[decision.verdict] += 1;
    if (decision.verdict === 'drop') drops.push({ company: row.company, title: row.title, url: row.url, years: decision.minYears, snippet: decision.worst?.snippet ?? '', triaged: row.triaged });
    rewrites.push({ raw: row.raw, next: gatedLine(row.raw, decision) });
  }

  let written = 0;
  if (!dryRun && rewrites.length) {
    await withPipelineLock(PIPELINE_PATH, () => {
      const r = applyGate(readFileSync(PIPELINE_PATH, 'utf-8'), rewrites);
      written = r.written;
      if (written) writeFileSync(PIPELINE_PATH, r.text);
    });
  }
  const summary = `${rows.length} job(s) checked for years asked · ${counts.drop} dropped (>${MAX_YEARS}y) · ${counts.ok} ok · ${counts.unstated} not stated · ${counts.unread} JD unreadable (kept)${dryRun ? ' · dry-run, nothing written' : ` · ${written} row(s) written`}`;
  return { summary, drops };
}

// ---------------------------------------------------------------------------
// Self-test — pure functions only
// ---------------------------------------------------------------------------

async function selfTest() {
  const { experienceAsks } = await import('./experience.mjs');
  let fail = 0;
  const check = (n, c) => { if (c) console.log(`ok: ${n}`); else { console.error(`FAIL: ${n}`); fail += 1; } };
  const v = (t) => juniorVerdict(t);

  check('0-2 years keeps', v('0-2 years of experience in Python').verdict === 'ok');
  check('2+ years keeps', v('2+ years of experience with SQL').verdict === 'ok');
  check('1-3 years keeps (minimum 1)', v('1-3 years of professional experience').verdict === 'ok');
  check('3+ years preferred drops', v('3+ years experience in backend - preferred').verdict === 'drop');
  check('4 years required drops', v('Requirements: 4 years of hands-on experience (Required)').minYears === 4);
  check('"Experience: 5+ years" drops', v('Experience: 5+ years').verdict === 'drop');
  check('word number drops', v('three years of experience building APIs').minYears === 3);
  check('highest minimum binds', v('1+ years Python experience.\n4+ years backend experience.').minYears === 4);
  check('company age ignored', v('Founded 12 years ago. We have 20 years of experience in the market.').verdict === 'unstated');
  check('no years → unstated', v('Build LLM agents in Python with our team.').verdict === 'unstated');
  check('Hebrew 3 שנות ניסיון drops', v('דרישות: 3 שנות ניסיון בפיתוח').minYears === 3);
  check('Hebrew שנתיים keeps', v('שנתיים ניסיון לפחות בפייתון').verdict === 'ok');
  check('Hebrew ניסיון של 4 שנים drops', v('ניסיון של 4 שנים בפיתוח backend').minYears === 4);
  check('Hebrew יתרון is preferred', experienceAsks('3 שנות ניסיון - יתרון')[0]?.strength === 'preferred');

  const text = [
    '## Pending',
    '- [ ] https://a.com/1 | Acme | Data Engineer | Tel Aviv',
    '- [ ] https://a.com/2 | Beta | AI Engineer | TLV | lane: api-jd | triage: PASS 4.0/5 — fit',
    '- [ ] https://a.com/3 | Gamma | Dev | TLV | exp: ok',
    '- [x] https://a.com/4 | Delta | Dev | TLV | triage: FAIL 1.0/5 — no',
    '- [ ] https://a.com/5 | Eps | Dev | TLV | triage: PASS 2.0/5 — moved to PASS by you (was FAIL: x)',
  ].join('\r\n');
  const sel = selectGateRows(text);
  check('selects only new, untagged, pending rows', sel.length === 1 && sel[0].company === 'Acme');
  check('--include-triaged adds pending PASS, never your override', selectGateRows(text, { includeTriaged: true }).map((r) => r.company).join() === 'Acme,Beta');

  const drop = { verdict: 'drop', minYears: 4, worst: { snippet: '4+ years | of experience' } };
  const dropped = gatedLine(sel[0].raw, drop);
  check('drop closes the row with a FAIL the site can read', /^- \[x\] https:\/\/a\.com\/1 \| Acme \| Data Engineer \| Tel Aviv \| exp: 4y \| triage: FAIL 0\.0\/5 — Asks 4\+ years \(max 2\)/.test(dropped));
  check('drop reason has no stray pipe', !dropped.split('triage:')[1].includes('|'));
  check('keep appends exp tag', gatedLine(sel[0].raw, { verdict: 'unstated' }) === '- [ ] https://a.com/1 | Acme | Data Engineer | Tel Aviv | exp: unstated');
  const beta = '- [ ] https://a.com/2 | Beta | AI Engineer | TLV | lane: api-jd | triage: PASS 4.0/5 — fit';
  check('re-checked keep inserts exp before triage', gatedLine(beta, { verdict: 'ok' }) === '- [ ] https://a.com/2 | Beta | AI Engineer | TLV | lane: api-jd | exp: ok | triage: PASS 4.0/5 — fit');
  check('re-checked drop replaces the verdict, keeps the old one', /exp: 4y \| triage: FAIL 0\.0\/5 — .*\(was PASS 4\.0\/5 — fit\)$/.test(gatedLine(beta, drop)));

  const applied = applyGate(text, [{ raw: sel[0].raw, next: dropped }]);
  check('applyGate writes one row, keeps CRLF', applied.written === 1 && applied.text.includes(`${dropped}\r\n`));
  check('applyGate idempotent', applyGate(applied.text, [{ raw: sel[0].raw, next: dropped }]).written === 0);

  check('JSON-LD description parsed', jsonLdDescription('<script type="application/ld+json">{"@type":"JobPosting","description":"<p>2+ years of experience</p>"}</script>').includes('2+ years'));
  check('LinkedIn description parsed', linkedInDescription('<div class="description__text"><div class="show-more-less-html__markup relative">Need <b>3+ years</b> of experience</div></div>').includes('3+ years'));

  console.log(fail ? `\n${fail} self-test failure(s)` : '\nAll self-tests passed.');
  return fail === 0;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--self-test')) process.exit((await selfTest()) ? 0 : 1);
  const r = await runGate({
    dryRun: hasFlag(args, '--dry-run'),
    includeTriaged: hasFlag(args, '--include-triaged'),
    limit: Number(flagValue(args, '--limit') ?? DEFAULT_LIMIT),
  });
  for (const d of r.drops) console.log(`  drop: ${d.company} — ${d.title} · asks ${d.years}+ years: "${d.snippet}"${d.triaged ? ' (was triaged)' : ''}\n        ${d.url}`);
  console.log(r.summary);
}
