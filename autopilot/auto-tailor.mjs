#!/usr/bin/env node
// @ts-check
// auto-tailor.mjs — the daily run's stage 5b (design/daily-task-design.md §9).
//
// For READY jobs that have no CV yet, gets each one a CV — library first:
//   reuse              a fresh CV for the same role family exists in CVs/  → copy it (no LLM call)
//   reuse-with-edits   a related role's CV exists                          → 1 LLM call
//   tailor             nothing fits / cv.md changed                        → 1 LLM call
// A new tailor is fact-checked, rendered to one page and saved back to CVs/<Role>/ by tailor.mjs.
//
// Budgets (hard): at most --max-jobs jobs per run (5) and at most --max-llm LLM calls per run (3).
// Jobs over budget stay `pending` and are picked up in the next run (best score first).
// Three LLM failures in a row stop the stage (quota / outage) — the rest stay pending.
//
// Only READY jobs are touched; CHECK / BLOCKED / MARGINAL never are. Nothing is submitted.
//
//   node autopilot/auto-tailor.mjs [--max-jobs 5] [--max-llm 3] [--cli claude] [--dry-run]
//   node autopilot/auto-tailor.mjs --self-test

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { flagValue, hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { lookup } from './cv-library.mjs';
import { tailor } from './tailor.mjs';

const ROOT = getCareerOpsRoot();
const OUT = join(ROOT, 'output');
const RUNS_DIR = join(ROOT, 'data', 'runs');

export const MAX_JOBS = 5;
export const MAX_LLM = 3;
export const MAX_CONSECUTIVE_LLM_FAILURES = 3;

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return fallback; } };
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf-8') : '');

/** READY bundles with no CV yet, best score first. `bundles` = [{dir, state}]. Pure. */
export function selectCandidates(bundles, { maxJobs = MAX_JOBS } = {}) {
  return bundles
    .filter(({ state }) => state.label === 'READY' && state.gate !== 'blocked' && !Object.keys(state.stages ?? {}).some((k) => k.startsWith('cv:')))
    .sort((a, b) => (Number(b.state.score) || 0) - (Number(a.state.score) || 0) || String(a.state.report_num).localeCompare(String(b.state.report_num)))
    .slice(0, maxJobs);
}

/** Whether one more job may run given what's been spent. Reuse is always free. Pure. */
export function withinBudget({ needsLlm, llmUsed, maxLlm = MAX_LLM, consecutiveFailures = 0 }) {
  if (!needsLlm) return { ok: true };
  if (consecutiveFailures >= MAX_CONSECUTIVE_LLM_FAILURES) return { ok: false, why: 'stopped: 3 LLM failures in a row (quota / outage suspected)' };
  if (llmUsed >= maxLlm) return { ok: false, why: `daily tailor cap reached (${maxLlm})` };
  return { ok: true };
}

/** Bundles under output/ that have a state.json. */
export function loadBundles(outDir = OUT) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{3,}-/.test(d.name))
    .map((d) => ({ dir: join(outDir, d.name), rel: `output/${d.name}`, state: readJson(join(outDir, d.name, 'state.json'), null) }))
    .filter((b) => b.state);
}

/**
 * @param {{ maxJobs?: number, maxLlm?: number, cliName?: string, dryRun?: boolean, bundles?: any[], lookupFn?: Function, tailorFn?: Function }} [opts]
 * @returns {Promise<{results: any[], llmUsed: number, summary: string}>}
 */
export async function runAutoTailor({ maxJobs = MAX_JOBS, maxLlm = MAX_LLM, cliName, dryRun = false, bundles = loadBundles(), lookupFn = lookup, tailorFn = tailor } = {}) {
  const candidates = selectCandidates(bundles, { maxJobs });
  const cvMd = read(join(ROOT, 'cv.md'));
  const results = [];
  let llmUsed = 0, consecutiveFailures = 0;

  for (const { dir, rel, state } of candidates) {
    const jd = read(join(dir, 'jd', 'current.md'));
    const hit = lookupFn({ title: state.role, jd, cvMd });
    const needsLlm = hit.decision !== 'reuse';
    const base = { report_num: state.report_num, company: state.company, title: state.role, role_folder: hit.role, decision: hit.decision, reason: hit.reason, bundle: rel };

    const budget = withinBudget({ needsLlm, llmUsed, maxLlm, consecutiveFailures });
    if (!budget.ok) { results.push({ ...base, status: 'pending', note: budget.why }); console.log(`  PENDING  ${state.company} — ${state.role}  (${budget.why})`); continue; }
    if (dryRun) { results.push({ ...base, status: 'dry-run', note: needsLlm ? '1 LLM call' : 'reuse, free' }); console.log(`  DRY-RUN  ${state.company} — ${state.role}  → ${hit.decision} (${hit.reason}) CVs/${hit.entry?.role ?? hit.role}`); continue; }

    if (needsLlm) llmUsed += 1;
    let r;
    try { r = await tailorFn({ query: state.report_num, cliName }); } catch (e) { r = { ok: false, stage: 'error', error: String(e?.message ?? e).split('\n')[0].slice(0, 200) }; }

    if (r.ok) {
      if (needsLlm) consecutiveFailures = 0;
      const status = r.reused ? 'reused' : 'tailored';
      results.push({ ...base, status, library: r.library, pdf: r.pdf });
      console.log(`  ${status.toUpperCase().padEnd(8)} ${state.company} — ${state.role}  → ${r.library}`);
    } else {
      if (needsLlm && (r.stage === 'llm' || r.stage === 'error')) consecutiveFailures += 1; // a fact-gate failure is not an outage
      results.push({ ...base, status: 'failed', stage: r.stage, note: String(r.error ?? '').slice(0, 200) });
      console.log(`  FAILED   ${state.company} — ${state.role}  (${r.stage ?? 'tailor'}: ${String(r.error ?? '').slice(0, 120)})`);
    }
  }

  const count = (s) => results.filter((x) => x.status === s).length;
  const summary = `${results.length} job(s): ${count('reused')} reused from CVs/ · ${count('tailored')} tailored (${llmUsed}/${maxLlm} LLM) · ${count('pending')} pending · ${count('failed')} failed${dryRun ? ` · ${count('dry-run')} dry-run` : ''}`;
  if (!dryRun && results.length) recordResults(results);
  return { results, llmUsed, summary };
}

/** Put each CV outcome on today's prepared record (creating one for a carried-over job), for the email + web. */
function recordResults(results, today = new Date().toISOString().slice(0, 10)) {
  mkdirSync(RUNS_DIR, { recursive: true });
  const file = join(RUNS_DIR, `prepared-${today}.json`);
  const day = readJson(file, { date: today, records: [] });
  for (const res of results) {
    const state = readJson(join(ROOT, res.bundle, 'state.json'), {});
    const cv = { status: res.status, library: res.library ?? null, note: res.note ?? null };
    const rec = day.records.find((x) => x.bundle === res.bundle);
    if (rec) rec.cv = cv;
    else day.records.push({
      url_key: state.url_key, date: today, label: state.label ?? 'READY', company: state.company, title: state.role, location: state.location ?? '', url: state.url,
      score: state.score ?? null, triage_reason: state.triage_reason ?? '', reasons: state.reasons ?? [], gaps: state.gaps ?? [], report: state.report, bundle: res.bundle,
      report_num: state.report_num, tracker_row: null, carried_over: true, cv,
    });
  }
  writeFileSync(file, JSON.stringify(day, null, 2));
}

// ---------------------------------------------------------------------------

async function selfTest() {
  let pass = 0, fail = 0;
  const check = (n, c) => { if (c) pass += 1; else { fail += 1; console.error(`FAIL: ${n}`); } };
  const mk = (num, label, score, stages = { jd: 'd' }, gate = 'gate-1') => ({ dir: `/x/${num}`, rel: `output/${num}`, state: { report_num: num, company: `Co${num}`, role: 'Backend Dev', label, score, gate, stages } });

  const bundles = [mk('101', 'READY', 3.5), mk('102', 'CHECK', 4.9), mk('103', 'READY', 4.4), mk('104', 'READY', 4.0, { jd: 'd', 'cv:v001': 'd' }), mk('105', 'READY', 4.1, { jd: 'd' }, 'blocked'), mk('106', undefined, 4.8), mk('107', 'READY', 3.9), mk('108', 'READY', 3.8), mk('109', 'READY', 3.7), mk('110', 'READY', 3.6)];
  const sel = selectCandidates(bundles);
  check('only READY without a CV and not blocked', sel.every((b) => b.state.label === 'READY') && !sel.some((b) => ['102', '104', '105', '106'].includes(b.state.report_num)));
  check('best score first', sel.map((b) => b.state.report_num).join() === '103,107,108,109,110');
  check('capped at maxJobs', sel.length === 5 && selectCandidates(bundles, { maxJobs: 2 }).length === 2);

  check('reuse is always free', withinBudget({ needsLlm: false, llmUsed: 99 }).ok);
  check('LLM allowed under the cap', withinBudget({ needsLlm: true, llmUsed: 2, maxLlm: 3 }).ok);
  check('LLM blocked at the cap', !withinBudget({ needsLlm: true, llmUsed: 3, maxLlm: 3 }).ok);
  check('3 consecutive failures stop LLM work', !withinBudget({ needsLlm: true, llmUsed: 0, consecutiveFailures: 3 }).ok);
  check('…but not free reuse', withinBudget({ needsLlm: false, llmUsed: 0, consecutiveFailures: 3 }).ok);

  // Loop with injected lookup/tailor: the first tailor fills the library so later same-role jobs reuse it.
  let libraryHasRole = false;
  const lookupFn = () => (libraryHasRole ? { decision: 'reuse', role: 'Software_Engineer', reason: 'role-match', entry: { role: 'Software_Engineer' } } : { decision: 'tailor', role: 'Software_Engineer', reason: 'no-cv-for-role' });
  const calls = [];
  const tailorFn = async ({ query }) => { calls.push(query); if (!libraryHasRole) { libraryHasRole = true; return { ok: true, library: 'saved to CVs/Software_Engineer (v1)', pdf: 'p' }; } return { ok: true, reused: true, library: 'CVs/Software_Engineer', pdf: 'p' }; };
  const run = await runAutoTailor({ bundles, lookupFn, tailorFn, maxJobs: 5, maxLlm: 3 });
  check('first job tailored, the rest reuse', run.results[0].status === 'tailored' && run.results.slice(1).every((x) => x.status === 'reused'));
  check('only one LLM call was spent', run.llmUsed === 1 && calls.length === 5);

  // Cap: every job needs an LLM call (different roles never fill the library).
  const alwaysTailor = () => ({ decision: 'tailor', role: 'X', reason: 'no-cv-for-role' });
  const okTailor = async () => ({ ok: true, library: 'saved', pdf: 'p' });
  const capped = await runAutoTailor({ bundles, lookupFn: alwaysTailor, tailorFn: okTailor, maxJobs: 5, maxLlm: 3, dryRun: false });
  check('cap of 3 LLM tailors holds', capped.llmUsed === 3 && capped.results.filter((x) => x.status === 'tailored').length === 3);
  check('the other 2 are pending, not failed', capped.results.filter((x) => x.status === 'pending').length === 2);

  // Breaker.
  const failTailor = async () => ({ ok: false, stage: 'llm', error: 'usage limit reached' });
  const broke = await runAutoTailor({ bundles, lookupFn: alwaysTailor, tailorFn: failTailor, maxJobs: 5, maxLlm: 5 });
  check('3 LLM failures stop the stage', broke.llmUsed === 3 && broke.results.filter((x) => x.status === 'failed').length === 3 && broke.results.filter((x) => x.status === 'pending').length === 2);

  // A fact-gate failure is not an outage.
  const factFail = async () => ({ ok: false, stage: 'fact-gate', error: 'claim not in cv.md' });
  const fact = await runAutoTailor({ bundles, lookupFn: alwaysTailor, tailorFn: factFail, maxJobs: 5, maxLlm: 5 });
  check('fact-gate failures do not trip the breaker', fact.results.filter((x) => x.status === 'failed').length === 5);

  const dry = await runAutoTailor({ bundles, lookupFn: alwaysTailor, tailorFn: () => { throw new Error('must not be called'); }, dryRun: true });
  check('dry-run calls nothing', dry.results.every((x) => x.status === 'dry-run') && dry.llmUsed === 0);

  console.log(`auto-tailor.mjs self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--self-test')) {
    process.exitCode = (await selfTest()) ? 0 : 1;
  } else {
    const { summary } = await runAutoTailor({
      maxJobs: Number(flagValue(args, '--max-jobs') ?? MAX_JOBS),
      maxLlm: Number(flagValue(args, '--max-llm') ?? MAX_LLM),
      cliName: flagValue(args, '--cli'),
      dryRun: hasFlag(args, '--dry-run'),
    });
    console.log(`\n${summary}`);
  }
}
