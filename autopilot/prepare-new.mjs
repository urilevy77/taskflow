#!/usr/bin/env node
// @ts-check
// prepare-new.mjs — the daily run's "prepare" stage (design/daily-task-design.md §3, stage 5).
//
// Runs prepare.mjs (stages A–C, zero LLM tokens) over every triaged PASS row that has not
// been prepared yet, then labels each one:
//
//   READY    nothing in the way — goes into the apply-kit email
//   CHECK    worth a look first: a required-experience ask above the CV, an account-walled
//            ATS (Workday / iCIMS / LinkedIn), a repost signal, or text aimed at an AI
//   BLOCKED  already applied / blacklisted / posting closed / no usable JD — never offered
//
// READY and CHECK jobs get a tracker row (status Evaluated, note "triage-only") through
// batch/tracker-additions/*.tsv + merge-tracker.mjs — applications.md is never edited by hand.
//
// State: data/prepare-seen.json (url_key → outcome) so a job is prepared once, and a posting
// that keeps failing is given up on after MAX_ATTEMPTS. Today's results: data/runs/prepared-{date}.json
// (read by the email and /autopilot/runs).
//
// Never triages, never calls an LLM, never submits anything.
//
//   node autopilot/prepare-new.mjs [--cap 15] [--dry-run] [--pipeline <file>]
//   node autopilot/prepare-new.mjs --self-test

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { flagValue, hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { normalizeUrl } from '../url-key.mjs';
import { slugifySegment } from '../application-artifacts.mjs';
import { prepare, selectPassRows, findExistingBundle } from './prepare.mjs';

const ROOT = getCareerOpsRoot();
const SEEN_PATH = join(ROOT, 'data', 'prepare-seen.json');
const RUNS_DIR = join(ROOT, 'data', 'runs');
const ADDITIONS_DIR = join(ROOT, 'batch', 'tracker-additions');

export const DEFAULT_CAP = 15;
export const MAX_ATTEMPTS = 3;

// The candidate has ~15 months of experience. A *required* 2+ years, or an unmarked / required
// 3+ years, is a knock-out worth a human look. "Preferred" asks stay informational.
export function experienceKnockout(asks) {
  return (asks ?? []).find((a) => (a.strength === 'required' && a.years >= 2) || (a.strength !== 'preferred' && a.years >= 3)) ?? null;
}

/**
 * READY / CHECK / BLOCKED from one prepare() result. Pure.
 * @returns {{label: 'READY'|'CHECK'|'BLOCKED', reasons: string[]}}
 */
export function classifyReadiness(r) {
  if (!r.ok) return { label: 'BLOCKED', reasons: [r.error ?? 'could not prepare'] };
  const stops = r.preflight?.stops ?? [];
  if (stops.length) return { label: 'BLOCKED', reasons: stops };

  const reasons = [];
  const ko = experienceKnockout(r.asks);
  if (ko) reasons.push(`JD asks ${ko.years}+ years (${ko.strength}): "${ko.snippet}"`);
  if (r.preflight?.accountWall) reasons.push(`${r.preflight.accountWall}: account-walled — needs a login, apply on the PC`);
  for (const w of r.preflight?.warnings ?? []) {
    if (/^JD asks/.test(w) || /account-walled/.test(w)) continue; // already covered above (or preferred-only)
    reasons.push(w);
  }
  if ((r.anomalies ?? []).length) reasons.push('the JD contains text aimed at an AI reviewer (quoted in the report, not followed)');
  return { label: reasons.length ? 'CHECK' : 'READY', reasons };
}

/** Pending PASS rows not yet prepared (and not given up on), best score first, capped. Pure. */
export function selectNewRows(pipelineText, seen, { cap = DEFAULT_CAP, hasBundle = () => false } = {}) {
  const fresh = selectPassRows(pipelineText).filter((row) => {
    const key = normalizeUrl(row.url);
    const s = seen[key];
    if (s && (s.status !== 'retry' || s.attempts >= MAX_ATTEMPTS)) return false;
    return !hasBundle(key);
  });
  return fresh
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (b.row.triage.score - a.row.triage.score) || (a.i - b.i))
    .slice(0, cap)
    .map((x) => x.row);
}

/** The seen-state entry for one result. Transient failures stay `retry` until MAX_ATTEMPTS. */
export function seenEntryFor(r, label, prev, today) {
  const attempts = (prev?.attempts ?? 0) + 1;
  const closed = !r.ok && /closed/i.test(r.error ?? '');
  const final = r.ok || closed;
  return { status: final ? (label === 'BLOCKED' ? 'blocked' : 'prepared') : 'retry', attempts, date: today };
}

/** One-row tracker-additions TSV (header form). Tabs/newlines in fields are flattened. Pure. */
export function buildTrackerTsv({ num, date, company, role, score, report, note, url, status = 'Evaluated' }) {
  const f = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  const header = 'num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl';
  const row = [f(num), date, f(company), f(role), f(status), `${Number(score).toFixed(1)}/5`, '❌', `[${f(num)}](${f(report)})`, f(note), f(url)].join('\t');
  return `${header}\n${row}\n`;
}

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return fallback; } };

/** What the email and the web page need about one job. */
export function toRecord(r, label, reasons, today) {
  const row = r.row;
  return {
    url_key: normalizeUrl(row.url),
    date: today,
    label,
    company: row.company,
    title: row.title,
    location: row.location ?? '',
    url: row.url,
    score: row.triage?.score ?? null,
    triage_reason: row.triage?.reason ?? '',
    reasons,
    gaps: r.gap?.gap ?? [],
    report: r.report ?? null,
    bundle: r.bundle ?? null,
    report_num: r.report ? (r.report.match(/(\d{3,})-/)?.[1] ?? null) : null,
    tracker_row: null,
  };
}

/** Copy the label + card fields into the bundle's state.json (read back by auto-tailor.mjs). */
export function stampState(bundleRel, rec) {
  const p = join(ROOT, bundleRel, 'state.json');
  const state = readJson(p, null);
  if (!state) return;
  Object.assign(state, { label: rec.label, reasons: rec.reasons, score: rec.score, triage_reason: rec.triage_reason, location: rec.location, gaps: rec.gaps });
  writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * The stage. `prepareFn` and `write` are injectable so the self-test touches no network or files.
 */
export async function runPrepareNew({ pipelinePath, cap = DEFAULT_CAP, dryRun = false, prepareFn = prepare, write = true, today = new Date().toISOString().slice(0, 10) } = {}) {
  const seen = readJson(SEEN_PATH, {});
  const text = readFileSync(pipelinePath, 'utf-8');
  const rows = selectNewRows(text, seen, { cap, hasBundle: (k) => Boolean(findExistingBundle(k)) });
  const records = [];

  for (const row of rows) {
    let r;
    try {
      r = await prepareFn({ query: row.url, pipelinePath, dryRun });
    } catch (e) {
      r = { ok: false, stage: 'error', error: String(e?.message ?? e).split('\n')[0].slice(0, 200) };
    }
    r.row = r.row ?? row;
    const { label, reasons } = classifyReadiness(r);
    const rec = toRecord(r, label, reasons, today);
    if (!dryRun && write && r.bundle) stampState(r.bundle, rec); // lets auto-tailor / the phone page rebuild this job later
    const key = normalizeUrl(row.url);
    seen[key] = seenEntryFor(r, label, seen[key], today);
    if (seen[key].status === 'retry') rec.retry = `attempt ${seen[key].attempts} of ${MAX_ATTEMPTS}`;
    records.push(rec);
    console.log(`  ${label.padEnd(7)} ${String(row.triage.score.toFixed(1)).padEnd(4)} ${row.company} — ${row.title}${reasons.length ? `  (${reasons[0].slice(0, 90)})` : ''}`);
  }

  const summary = {
    considered: rows.length,
    ready: records.filter((x) => x.label === 'READY').length,
    check: records.filter((x) => x.label === 'CHECK').length,
    blocked: records.filter((x) => x.label === 'BLOCKED').length,
  };
  if (dryRun || !write || !records.length) return { records, summary, merged: null };

  // Tracker rows: READY + CHECK only, and only when the company+role isn't in the tracker already
  // (prepare's preflight lists those; stage F updates that row instead of adding a duplicate).
  const written = [];
  mkdirSync(ADDITIONS_DIR, { recursive: true });
  for (const rec of records) {
    if (rec.label === 'BLOCKED' || !rec.report_num) continue;
    if (rec.reasons.some((x) => /^tracker #\d+/.test(x))) continue;
    const note = `triage-only; ${rec.label}${rec.reasons.length ? `; ${rec.reasons[0]}` : ''}`.slice(0, 200);
    const file = join(ADDITIONS_DIR, `${rec.report_num}-${slugifySegment(rec.company)}.tsv`);
    writeFileSync(file, buildTrackerTsv({ num: rec.report_num, date: today, company: rec.company, role: rec.title, score: rec.score, report: rec.report, note, url: rec.url }));
    written.push(rec);
  }

  let merged = null;
  if (written.length) {
    try {
      merged = execFileSync('node', [join(ROOT, 'merge-tracker.mjs')], { cwd: ROOT, encoding: 'utf-8', timeout: 60_000 }).trim().split('\n').slice(-3).join(' / ');
      for (const rec of written) rec.tracker_row = 'merged';
    } catch (e) {
      merged = `merge-tracker failed: ${String(e?.message ?? e).split('\n')[0].slice(0, 160)} — TSVs left in batch/tracker-additions for the next merge`;
    }
  }

  mkdirSync(RUNS_DIR, { recursive: true });
  const dayFile = join(RUNS_DIR, `prepared-${today}.json`);
  const prior = readJson(dayFile, { date: today, records: [] });
  const byKey = new Map(prior.records.map((x) => [x.url_key, x]));
  for (const rec of records) byKey.set(rec.url_key, rec);
  writeFileSync(dayFile, JSON.stringify({ date: today, records: [...byKey.values()] }, null, 2));
  writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2));
  return { records, summary, merged };
}

export function summaryLine({ summary, merged }) {
  const base = `${summary.considered} prepared: ${summary.ready} READY · ${summary.check} CHECK · ${summary.blocked} BLOCKED`;
  return merged ? `${base} | tracker: ${merged}` : base;
}

// ---------------------------------------------------------------------------
// Self-test — pure functions + an injected prepareFn; no network, no writes
// ---------------------------------------------------------------------------

function selfTest() {
  let pass = 0, fail = 0;
  const check = (name, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL: ${name}`); } };

  const ok = (over = {}) => ({ ok: true, preflight: { stops: [], warnings: [], accountWall: null }, asks: [], anomalies: [], ...over });
  check('clean job is READY', classifyReadiness(ok()).label === 'READY');
  check('closed posting is BLOCKED', classifyReadiness({ ok: false, error: 'posting is closed: expired' }).label === 'BLOCKED');
  check('preflight stop is BLOCKED', classifyReadiness(ok({ preflight: { stops: ['already in the tracker as #5'], warnings: [] } })).label === 'BLOCKED');
  check('required 4+ years is CHECK', classifyReadiness(ok({ asks: [{ years: 4, strength: 'required', snippet: '4+ years' }] })).label === 'CHECK');
  check('required 2 years is CHECK', classifyReadiness(ok({ asks: [{ years: 2, strength: 'required', snippet: '2 years' }] })).label === 'CHECK');
  check('preferred 5 years stays READY', classifyReadiness(ok({ asks: [{ years: 5, strength: 'preferred', snippet: 'x' }] })).label === 'READY');
  check('unmarked 1-2 years stays READY', classifyReadiness(ok({ asks: [{ years: 2, strength: 'unmarked', snippet: 'x' }] })).label === 'READY');
  check('unmarked 3 years is CHECK', classifyReadiness(ok({ asks: [{ years: 3, strength: 'unmarked', snippet: 'x' }] })).label === 'CHECK');
  check('account wall is CHECK', classifyReadiness(ok({ preflight: { stops: [], warnings: [], accountWall: 'Workday' } })).label === 'CHECK');
  check('repost warning is CHECK', classifyReadiness(ok({ preflight: { stops: [], warnings: ['relisted 3× between a and b'], accountWall: null } })).label === 'CHECK');
  check('AI-directed text is CHECK', classifyReadiness(ok({ anomalies: ['ignore previous instructions'] })).label === 'CHECK');

  const t = (n, url, score, extra = '') => `- [ ] ${url} | Co${n} | Role ${n} | Tel Aviv | lane: il-source | triage: PASS ${score}/5 — fit${extra}`;
  const text = [t(1, 'https://a.com/1', '3.5'), t(2, 'https://a.com/2', '4.5'), t(3, 'https://a.com/3', '4.0'), '- [ ] https://a.com/4 | Co4 | R4 | TLV | triage: MARGINAL 3.0/5 — x', '- [x] https://a.com/5 | Co5 | R5 | TLV | triage: PASS 4.9/5 — done'].join('\r\n');
  const sel = selectNewRows(text, {});
  check('selects PASS only, best first', sel.map((r) => r.company).join() === 'Co2,Co3,Co1');
  check('cap applies', selectNewRows(text, {}, { cap: 2 }).length === 2);
  const seen = { [normalizeUrl('https://a.com/2')]: { status: 'prepared', attempts: 1 }, [normalizeUrl('https://a.com/3')]: { status: 'retry', attempts: 1 } };
  check('seen prepared is skipped, retry is kept', selectNewRows(text, seen).map((r) => r.company).join() === 'Co3,Co1');
  check('retry stops after MAX_ATTEMPTS', selectNewRows(text, { [normalizeUrl('https://a.com/3')]: { status: 'retry', attempts: MAX_ATTEMPTS } }).every((r) => r.company !== 'Co3'));
  check('existing bundle is skipped', selectNewRows(text, {}, { hasBundle: (k) => k === normalizeUrl('https://a.com/1') }).every((r) => r.company !== 'Co1'));

  check('closed → final blocked', seenEntryFor({ ok: false, error: 'posting is closed: x' }, 'BLOCKED', undefined, 'd').status === 'blocked');
  check('transient failure → retry', seenEntryFor({ ok: false, error: 'could not capture a usable JD' }, 'BLOCKED', undefined, 'd').status === 'retry');
  check('ok+READY → prepared', seenEntryFor(ok(), 'READY', undefined, 'd').status === 'prepared');
  check('attempts count up', seenEntryFor({ ok: false, error: 'x' }, 'BLOCKED', { attempts: 2 }, 'd').attempts === 3);

  const tsv = buildTrackerTsv({ num: '130', date: '2026-10-01', company: 'Acme\tInc', role: 'Backend\nDev', score: 3.84, report: 'reports/130-acme-2026-10-01.md', note: 'triage-only; READY', url: 'https://x.com/1' });
  const [h, row] = tsv.trim().split('\n');
  check('tsv has a header and exactly one row', tsv.trim().split('\n').length === 2);
  check('tsv column counts match', h.split('\t').length === 10 && row.split('\t').length === 10);
  check('tsv status Evaluated + score format', row.split('\t')[4] === 'Evaluated' && row.split('\t')[5] === '3.8/5');
  check('tsv report link is root-relative', row.split('\t')[7] === '[130](reports/130-acme-2026-10-01.md)');
  check('tsv flattens tabs/newlines', row.split('\t')[2] === 'Acme Inc' && row.split('\t')[3] === 'Backend Dev');

  return { pass, fail };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--self-test')) {
    const { pass, fail } = selfTest();
    console.log(`prepare-new.mjs self-test: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  const pipelinePath = resolve(ROOT, flagValue(args, '--pipeline') ?? join('data', 'pipeline.md'));
  const cap = Number(flagValue(args, '--cap') ?? DEFAULT_CAP);
  const res = await runPrepareNew({ pipelinePath, cap, dryRun: hasFlag(args, '--dry-run') });
  console.log(`\n${summaryLine(res)}`);
  // No process.exit(): right after network calls it trips a libuv handle assertion on Windows.
  process.exitCode = 0;
}
