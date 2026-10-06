#!/usr/bin/env node
// @ts-check
// daily.mjs — the scheduled entry point for design/autopilot-plan.md's Layer 2.
//
// Stages, in order (see the plan's stage table):
//   1. goozali-sync.mjs   — Mondays only, REPORT-ONLY by default (never
//                            writes portals.yml unattended unless you pass
//                            --goozali-apply — that's a config-file edit
//                            with no human in the loop otherwise, and
//                            nothing in the agreed plan authorizes it)
//   2. scan-all.mjs       — WhatsApp drain + board scan → data/pipeline.md
//   2b. enrich-leads.mjs  — resolve Company/Title/Location for bare intake
//                            rows BEFORE triage sees them (zero-token HTTP)
//   3-5. triage-run.mjs   — lane routing + modes/triage.md, budgeted
//   8. db-build.mjs       — rebuild the derived index
//   9. health             — verify-pipeline.mjs + check-jd-archive.mjs
//
// Stage 6 (full evaluation via batch-runner.sh) is DELIBERATELY ABSENT —
// not stubbed, not flagged off. Decided 2026-09-25: evaluations stay a
// separate, manual step (existing /career-ops pipeline or batch-runner.sh)
// until explicitly folded in later. Two reasons converged on this: (a) the
// user asked for evaluations not to run as part of this build, and (b)
// batch/batch-input.tsv already has a pre-existing, unrelated 94-row
// pending backlog (WhatsApp-sourced, predates this work) that a naive
// batch-runner.sh invocation would fully evaluate — real cost, no triage
// gate. Isolating a future stage 6 from that backlog is straightforward
// (batch-runner.sh's own --start-from flag, once a high-water-mark id is
// recorded) but is out of scope until stage 6 is actually built.
// Stage 7 (Gmail sync) is Phase 3 and agent-side (needs the Gmail MCP,
// which a headless subprocess cannot hold) — not part of this script either.
//
// Each stage is independently reported: a failing stage never costs the
// stages before it, the same discipline scan-all.mjs already applies to its
// own two halves. Results land in data/careerops.db's `runs` table (read by
// /autopilot/runs) and are mirrored to data/runs/{date}.json.
//
// Usage:
//   node autopilot/daily.mjs                    # full run, default budgets
//   node autopilot/daily.mjs --budget-triage 60
//   node autopilot/daily.mjs --skip-goozali --skip-scan
//   node autopilot/daily.mjs --goozali-apply     # let goozali-sync write portals.yml
//   node autopilot/daily.mjs --dry-run           # print the stage plan, run nothing
//   node autopilot/daily.mjs --self-test         # in-memory suite; spawns no subprocess


import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { flagValue, hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { detectCli } from '../rank-pipeline.mjs';
import { TRIAGE_CLI_CANDIDATES } from './triage-run.mjs';
import { appendRunLog } from './run-log.mjs';
import { sendRunReport } from './notify-mail.mjs';
import { publishSite } from './publish-site.mjs';

const ROOT = getCareerOpsRoot();
const DB_PATH = join(ROOT, 'data', 'careerops.db');
const RUNS_DIR = join(ROOT, 'data', 'runs');

const DEFAULT_BUDGET_TRIAGE = 60;
// Measured live 2026-09-25: a real run hit the original 15-minute ceiling
// mid-sweep (ETIMEDOUT at exactly 900.0s), having only reached ~10 of ~300
// tracked companies (many Workday boards, each paginated — see Phase 0's
// audit-portals.mjs finding). scan.mjs walks tracked_companies in a FIXED
// file order with no --resume, so a timeout that hits the same point every
// day would always re-sweep the same early boards while later ones in the
// list rarely or never get reached. scan-all.mjs/scan.mjs cost zero tokens
// regardless of duration, so there's no cost downside to a longer ceiling —
// only a time-budget one. Raised accordingly; if a full sweep still doesn't
// complete within this, the fix is upstream (board order rotation or a real
// --resume in scan.mjs), not a further bump here.
const SCAN_TIMEOUT_MS = 40 * 60_000;
const TRIAGE_STAGE_TIMEOUT_MS = 40 * 60_000; // 60 rows × ~20-30s; bounded by --budget-triage, generous ceiling here
const ENRICH_STAGE_TIMEOUT_MS = 15 * 60_000; // plain HTTP at 250ms spacing; ~200 rows fits comfortably
const PREPARE_STAGE_TIMEOUT_MS = 30 * 60_000; // up to 15 jobs, each a JD fetch + liveness check (zero tokens)
const TAILOR_STAGE_TIMEOUT_MS = 30 * 60_000; // ≤3 LLM tailors (~1-3 min each incl. PDF render) + free reuses
const SHORT_TIMEOUT_MS = 60_000; // also the ceiling for dedup-intake (pure file work)

const USAGE = `
  daily.mjs — the autopilot scheduled entry point (design/autopilot-plan.md)

  node autopilot/daily.mjs [options]

    --budget-triage N   rows sent to the LLM triage stage this run (default ${DEFAULT_BUDGET_TRIAGE})
    --budget-enrich N   cap bare rows resolved by the enrich stage (default: all — it costs no tokens)
    --skip-enrich       don't run enrich-leads.mjs before triage
    --skip-dedup        don't run dedup-intake.mjs (cross-source company+role duplicates) before triage
    --skip-goozali      don't run goozali-sync.mjs even on a Monday
    --goozali-apply     let goozali-sync.mjs write portals.yml (default: report-only)
    --skip-scan         don't run scan-all.mjs
    --skip-triage       don't run triage-run.mjs
    --skip-prepare      don't run prepare-new.mjs (JD archive + READY/CHECK/BLOCKED for new PASS jobs)
    --skip-tailor       don't run auto-tailor.mjs (CVs for READY jobs: CVs/ library first, ≤5 jobs, ≤3 LLM calls)
    --cli <name>        forced CLI for triage-run.mjs
    --model <name>      forced model for triage-run.mjs
    --dry-run           print the stage plan, execute nothing (zero cost, zero writes)
    --self-test         run the in-memory suite (no subprocess, no network)
`;

// ---------------------------------------------------------------------------
// Pure helpers — kept out of main() so they're self-testable without
// spawning anything.
// ---------------------------------------------------------------------------

/** @param {Date} date */
export function isGoozaliDay(date) {
  return date.getDay() === 1; // Monday
}

export function buildStageResult(name, ok, summary, durationMs, extra = {}) {
  return { name, ok, summary, durationMs, ...extra };
}

const DETAIL_MAX_LINES = 20;
const DETAIL_MAX_CHARS = 2000;

/**
 * Last lines of a failed stage's combined output — the part that says WHY. The error
 * message alone is 'Command failed: node <script>' (09-29: triage failed in 0.6s and
 * nothing recorded the cause). Bounded so a chatty scan can't bloat the ledger.
 * @param {unknown} text
 */
export function tailLines(text, maxLines = DETAIL_MAX_LINES, maxChars = DETAIL_MAX_CHARS) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const tail = lines.slice(-maxLines).join('\n');
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

/** Shape written to the `runs` table and mirrored to data/runs/{date}.json. */
export function buildRunDigest(runId, startedAt, finishedAt, stages) {
  return {
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    stages: stages.map(({ name, ok, summary, durationMs, detail }) => ({ name, ok, summary, durationMs, ...(detail ? { detail } : {}) })),
  };
}

export function runIdFor(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

// ---------------------------------------------------------------------------
// Stage runner — every stage goes through this so failures are uniformly
// reported and never abort the rest of the run.
// ---------------------------------------------------------------------------

// Logs live, per stage, as each one starts and finishes — NOT batched to a
// final summary. A real run (2026-09-25) sat silent for ~15 minutes during a
// slow scan stage with nothing printed, leaving no way to tell "still
// working" from "stuck" without externally polling the process list. The
// final digest block still prints a recap at the end; this is what makes a
// live `tail`/log-watch actually useful while a run is in flight.
async function runStage(name, fn) {
  console.log(`▶ ${name} starting...`);
  const started = Date.now();
  try {
    const summary = await fn();
    const durationMs = Date.now() - started;
    console.log(`✓ ${name} done (${(durationMs / 1000).toFixed(1)}s): ${summary}`);
    return buildStageResult(name, true, summary, durationMs);
  } catch (err) {
    const durationMs = Date.now() - started;
    const message = err && err.message ? err.message.slice(0, 300) : String(err);
    console.log(`✗ ${name} FAILED (${(durationMs / 1000).toFixed(1)}s): ${message}`);
    const detail = tailLines(err && err.stdout);
    if (detail) console.log(`  last output of ${name}:\n${detail.split('\n').map((l) => `    ${l}`).join('\n')}`);
    return buildStageResult(name, false, `FAILED: ${message}`, durationMs, detail ? { detail } : {});
  }
}

import { spawn } from 'node:child_process';
function runNode(scriptPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timeoutId;
    if (timeoutMs) {
      timeoutId = setTimeout(() => {
        child.kill('SIGKILL');
        const err = new Error('ETIMEDOUT');
        err.stdout = out; // where it was when the clock ran out (e.g. which board the scan was on)
        reject(err);
      }, timeoutMs);
    }
    child.stdout.on('data', (d) => {
      const s = d.toString('utf-8');
      out += s;
      process.stdout.write(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf-8');
      out += s;
      process.stderr.write(s);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (code !== 0) {
        // Build an error that mimics the old execFileSync Error shape so try/catch blocks still work
        const err = new Error(`Command failed (exit ${code}): node ${scriptPath}`);
        err.stdout = out;
        reject(err);
      } else {
        resolve(out);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

// Stage 0. Cheap checks that turn a mystery failure 0.6s into triage (09-29) into a clear line up front.
// A missing CLI / cv.md / brief fails THIS stage loudly; the rest of the run still goes ahead.
export function preflightProblems({ hasCli, hasCv, hasBrief, needCli }) {
  const problems = [];
  if (needCli && !hasCli) problems.push('no agent CLI on PATH (claude/codex/…) — triage and tailoring cannot run');
  if (!hasCv) problems.push('cv.md is missing');
  if (!hasBrief) problems.push('modes/_brief.md is missing — triage cannot run');
  return problems;
}

async function stagePreflight(needCli, cliName) {
  const cli = cliName ? { bin: cliName } : detectCli(TRIAGE_CLI_CANDIDATES);
  const problems = preflightProblems({
    hasCli: Boolean(cli),
    hasCv: existsSync(join(ROOT, 'cv.md')),
    hasBrief: existsSync(join(ROOT, 'modes', '_brief.md')),
    needCli,
  });
  const whatsapp = existsSync(join(ROOT, 'data', 'whatsapp-session')) ? 'WhatsApp session present' : 'no WhatsApp session — boards only';
  if (problems.length) throw new Error(problems.join('; '));
  return `ok (CLI: ${cli ? cli.bin : 'n/a'}; ${whatsapp})`;
}

async function stageGoozali(applyWrites) {
  const args = ['--json'];
  if (applyWrites) args.push('--apply');
  const out = await runNode(join(ROOT, 'goozali-sync.mjs'), args, SHORT_TIMEOUT_MS);
  try {
    const parsed = JSON.parse(out);
    const n = Array.isArray(parsed.pending ?? parsed.companies) ? (parsed.pending ?? parsed.companies).length : undefined;
    return applyWrites
      ? `applied${n !== undefined ? ` (${n} companies)` : ''}`
      : `report-only${n !== undefined ? ` (${n} new companies found, not written — pass --goozali-apply)` : ''}`;
  } catch {
    return applyWrites ? 'applied (unparsed output)' : 'report-only (unparsed output)';
  }
}

async function stageScan() {
  await runNode(join(ROOT, 'scan-all.mjs'), [], SCAN_TIMEOUT_MS);
  return 'scan-all.mjs completed';
}

// Runs BETWEEN scan and triage, and that order is the point. Intake rows from
// WhatsApp arrive as a bare URL with no Company/Title/Location, which makes
// them unreadable to a human scanning the file and invisible to any
// location-based filter — on 2026-09-26 a location prune dropped 216 untriaged
// Israeli WhatsApp leads for exactly that reason. Resolving the fields before
// triage costs zero tokens and keeps a bare row from reading as "not Israel".
async function stageEnrich(budget) {
  const args = ['--write'];
  if (budget) args.push('--limit', String(budget));
  const out = await runNode(join(ROOT, 'autopilot', 'enrich-leads.mjs'), args, ENRICH_STAGE_TIMEOUT_MS);
  const lastLines = out.trim().split('\n').filter(Boolean).slice(-2).join(' / ');
  return lastLines || 'enrich-leads.mjs completed';
}

// After enrich (rows now have company + title), before triage (an LLM call per row): the same job from
// two sources (a WhatsApp LinkedIn link + a Lever link) is marked dup-of and never triaged.
async function stageDedup() {
  const out = await runNode(join(ROOT, 'autopilot', 'dedup-intake.mjs'), ['--write'], SHORT_TIMEOUT_MS);
  return out.trim().split(/\r?\n/).filter(Boolean).pop() || 'dedup-intake.mjs completed';
}

async function stageTriage(budget, cli, model) {
  const args = ['--budget', String(budget)];
  if (cli) args.push('--cli', cli);
  if (model) args.push('--model', model);
  const out = await runNode(join(ROOT, 'autopilot', 'triage-run.mjs'), args, TRIAGE_STAGE_TIMEOUT_MS);
  const lastLines = out.trim().split('\n').filter(Boolean).slice(-3).join(' / ');
  return lastLines || 'triage-run.mjs completed';
}

// Zero tokens: captures the JD, runs the preflight checks, writes the triage-only report and the
// tracker row for every new PASS job. See autopilot/prepare-new.mjs.
async function stagePrepare() {
  const out = await runNode(join(ROOT, 'autopilot', 'prepare-new.mjs'), [], PREPARE_STAGE_TIMEOUT_MS);
  const summary = out.trim().split(/\r?\n/).filter((l) => /prepared:/.test(l)).pop();
  return summary || 'prepare-new.mjs completed';
}

// Library-first CVs for READY jobs: ≤5 jobs, ≤3 LLM calls per run. See autopilot/auto-tailor.mjs.
async function stageTailor(cli) {
  const args = cli ? ['--cli', cli] : [];
  const out = await runNode(join(ROOT, 'autopilot', 'auto-tailor.mjs'), args, TAILOR_STAGE_TIMEOUT_MS);
  const line = out.trim().split(/\r?\n/).filter((l) => l.includes('job(s):')).pop();
  return line || 'auto-tailor.mjs completed';
}

// Per-source funnel (found → PASS → prepared → applied …) → data/runs/sources.json. Free, read-only over your files.
async function stageSources() {
  await runNode(join(ROOT, 'autopilot', 'sources.mjs'), ['--write'], SHORT_TIMEOUT_MS);
  return 'data/runs/sources.json updated';
}

async function stageDbBuild() {
  const out = await runNode(join(ROOT, 'autopilot', 'db-build.mjs'), ['--summary'], SHORT_TIMEOUT_MS);
  return out.trim();
}

async function stageHealth() {
  let verifySummary = 'verify-pipeline.mjs: unavailable';
  try {
    const out = await runNode(join(ROOT, 'verify-pipeline.mjs'), [], SHORT_TIMEOUT_MS);
    const last = out.trim().split('\n').filter(Boolean).pop();
    verifySummary = last || 'verify-pipeline.mjs: no output';
  } catch (err) {
    // verify-pipeline.mjs exits non-zero on errors (not just warnings) — that's
    // signal, not a stage failure in itself; surface its tail, don't rethrow.
    const out = String(err.stdout ?? err.message ?? '');
    verifySummary = out.trim().split('\n').filter(Boolean).pop() || 'verify-pipeline.mjs failed';
  }

  let jdSummary = 'check-jd-archive.mjs: unavailable';
  try {
    const out = await runNode(join(ROOT, 'check-jd-archive.mjs'), ['--summary'], SHORT_TIMEOUT_MS);
    jdSummary = out.trim().split('\n').filter(Boolean).pop() || 'check-jd-archive.mjs: no output';
  } catch (err) {
    jdSummary = 'check-jd-archive.mjs failed';
  }

  return `${verifySummary} | ${jdSummary}`;
}

// ---------------------------------------------------------------------------
// Run digest persistence
// ---------------------------------------------------------------------------

function persistDigest(digest) {
  // 1. The DURABLE history: append-only, never rewritten, one row per run.
  // This is the sink that must survive everything else — the DB is a
  // rebuildable index and the JSON file below is date-keyed. Written FIRST
  // and independently so a failure in either of the other two sinks cannot
  // cost us the ledger row.
  try {
    appendRunLog(digest);
  } catch (err) {
    console.error(`  (run-log append failed: ${err.message})`);
  }

  // 2. Convenience "latest run today", NOT history: this is keyed by date, so
  // a second run on the same day overwrites the first — measured 2026-09-25,
  // when three runs collapsed to one here while the ledger and DB kept all
  // three. Kept because a single pretty-printed digest is handy to open;
  // never read it expecting a full record.
  mkdirSync(RUNS_DIR, { recursive: true });
  const dateStr = digest.started_at.slice(0, 10);
  writeFileSync(join(RUNS_DIR, `${dateStr}.json`), JSON.stringify(digest, null, 2));

  // 3. The derived index the dashboard queries.
  if (!existsSync(DB_PATH)) return; // db-build.mjs hasn't run yet this run somehow — digest still lives in the ledger + JSON mirror
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY, started_at TEXT, finished_at TEXT, stage_json TEXT
    )`);
    db.prepare('INSERT OR REPLACE INTO runs (run_id, started_at, finished_at, stage_json) VALUES (?, ?, ?, ?)')
      .run(digest.run_id, digest.started_at, digest.finished_at, JSON.stringify(digest.stages));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log(USAGE);
    return 0;
  }
  if (hasFlag(argv, '--self-test')) {
    selfTest();
    return 0;
  }

  const dryRun = hasFlag(argv, '--dry-run');
  const budgetTriage = flagValue(argv, '--budget-triage') ?? DEFAULT_BUDGET_TRIAGE;
  const skipGoozali = hasFlag(argv, '--skip-goozali');
  const goozaliApply = hasFlag(argv, '--goozali-apply');
  const skipScan = hasFlag(argv, '--skip-scan');
  const skipEnrich = hasFlag(argv, '--skip-enrich');
  const skipTriage = hasFlag(argv, '--skip-triage');
  const skipDedup = hasFlag(argv, '--skip-dedup');
  const skipPrepare = hasFlag(argv, '--skip-prepare');
  const skipTailor = hasFlag(argv, '--skip-tailor');
  // No default cap: enrichment is zero-token plain HTTP, so the useful default
  // is "resolve everything bare", unlike the LLM triage budget.
  const budgetEnrich = flagValue(argv, '--budget-enrich') ?? 0;
  const cli = flagValue(argv, '--cli');
  const model = flagValue(argv, '--model');

  const now = new Date();
  const runId = runIdFor(now);
  const startedAt = now.toISOString();

  const plan = [
    { name: 'preflight', run: true, detail: 'CLI on PATH, cv.md, modes/_brief.md, WhatsApp session note' },
    { name: 'goozali', run: !skipGoozali && isGoozaliDay(now), detail: skipGoozali ? 'skipped (--skip-goozali)' : isGoozaliDay(now) ? (goozaliApply ? 'report + apply' : 'report-only') : 'skipped (not Monday)' },
    { name: 'scan', run: !skipScan, detail: skipScan ? 'skipped (--skip-scan)' : 'scan-all.mjs (WhatsApp + boards)' },
    { name: 'enrich', run: !skipEnrich, detail: skipEnrich ? 'skipped (--skip-enrich)' : `enrich-leads.mjs --write${budgetEnrich ? ` --limit ${budgetEnrich}` : ' (all bare rows)'}` },
    { name: 'dedup', run: !skipDedup, detail: skipDedup ? 'skipped (--skip-dedup)' : 'dedup-intake.mjs --write — same job from two sources → dup-of, never triaged (free)' },
    { name: 'triage', run: !skipTriage, detail: skipTriage ? 'skipped (--skip-triage)' : `budget ${budgetTriage}` },
    { name: 'prepare', run: !skipPrepare, detail: skipPrepare ? 'skipped (--skip-prepare)' : 'prepare-new.mjs — JD + preflight + tracker row for new PASS jobs (free, max 15)' },
    { name: 'tailor', run: !skipTailor, detail: skipTailor ? 'skipped (--skip-tailor)' : 'auto-tailor.mjs — CVs for READY jobs: CVs/ library first, max 5 jobs, max 3 LLM calls' },
    { name: 'sources', run: true, detail: 'sources.mjs --write — per-source funnel for the email and /autopilot/runs' },
    { name: 'db-build', run: true, detail: 'always runs — cheap, keeps the index honest' },
    { name: 'health', run: true, detail: 'verify-pipeline.mjs + check-jd-archive.mjs' },
  ];

  if (dryRun) {
    console.log(`Run plan (${runId}):`);
    for (const s of plan) console.log(`  ${s.run ? '✓' : '·'} ${s.name}: ${s.detail}`);
    console.log('\n[dry-run] nothing executed.');
    return 0;
  }

  const stages = [];

  stages.push(await runStage('preflight', () => stagePreflight(!skipTriage, cli)));

  if (!skipGoozali && isGoozaliDay(now)) {
    stages.push(await runStage('goozali', () => stageGoozali(goozaliApply)));
  } else {
    stages.push(buildStageResult('goozali', true, skipGoozali ? 'skipped (--skip-goozali)' : 'skipped (not Monday)', 0));
  }

  if (!skipScan) {
    stages.push(await runStage('scan', () => stageScan()));
  } else {
    stages.push(buildStageResult('scan', true, 'skipped (--skip-scan)', 0));
  }

  if (!skipEnrich) {
    stages.push(await runStage('enrich', () => stageEnrich(budgetEnrich)));
  } else {
    stages.push(buildStageResult('enrich', true, 'skipped (--skip-enrich)', 0));
  }

  if (!skipDedup) {
    stages.push(await runStage('dedup', () => stageDedup()));
  } else {
    stages.push(buildStageResult('dedup', true, 'skipped (--skip-dedup)', 0));
  }

  if (!skipTriage) {
    stages.push(await runStage('triage', () => stageTriage(budgetTriage, cli, model)));
  } else {
    stages.push(buildStageResult('triage', true, 'skipped (--skip-triage)', 0));
  }

  if (!skipPrepare) {
    stages.push(await runStage('prepare', () => stagePrepare()));
  } else {
    stages.push(buildStageResult('prepare', true, 'skipped (--skip-prepare)', 0));
  }

  if (!skipTailor) {
    stages.push(await runStage('tailor', () => stageTailor(cli)));
  } else {
    stages.push(buildStageResult('tailor', true, 'skipped (--skip-tailor)', 0));
  }

  stages.push(await runStage('sources', () => stageSources()));
  stages.push(await runStage('db-build', () => stageDbBuild()));
  stages.push(await runStage('health', () => stageHealth()));

  const finishedAt = new Date().toISOString();
  const digest = buildRunDigest(runId, startedAt, finishedAt, stages);
  persistDigest(digest);

  console.log(`\nRun ${runId} — ${stages.filter((s) => s.ok).length}/${stages.length} stages ok:`);
  for (const s of stages) console.log(`  ${s.ok ? '✓' : '✗'} ${s.name} (${(s.durationMs / 1000).toFixed(1)}s): ${s.summary}`);

  console.log(`  🌐 ${await publishSite()}`); // before the mail, so its link already points at today's page
  console.log(`  ✉ ${await sendRunReport(digest)}`);

  return stages.every((s) => s.ok) ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Self-test — in-memory, touches no real files, spawns no subprocess
// ---------------------------------------------------------------------------

function selfTest() {
  let failures = 0;
  const check = (name, cond) => {
    if (!cond) { console.error(`FAIL: ${name}`); failures += 1; }
    else console.log(`ok: ${name}`);
  };

  check('isGoozaliDay: Monday true', isGoozaliDay(new Date('2026-09-28T09:00:00'))); // a Monday
  check('isGoozaliDay: Tuesday false', !isGoozaliDay(new Date('2026-09-29T09:00:00')));
  check('isGoozaliDay: Sunday false', !isGoozaliDay(new Date('2026-09-27T09:00:00')));

  const result = buildStageResult('scan', true, 'ok summary', 1234);
  check('buildStageResult shape', result.name === 'scan' && result.ok === true && result.durationMs === 1234);

  const digest = buildRunDigest('run-1', '2026-09-25T07:30:00Z', '2026-09-25T07:35:00Z', [
    buildStageResult('scan', true, 'fine', 100),
    buildStageResult('triage', false, 'FAILED: timeout', 200),
  ]);
  check('buildRunDigest carries run_id', digest.run_id === 'run-1');
  check('buildRunDigest carries all stages', digest.stages.length === 2);
  check('buildRunDigest preserves failure', digest.stages[1].ok === false);
  check('buildRunDigest strips extra fields', Object.keys(digest.stages[0]).sort().join(',') === 'durationMs,name,ok,summary');

  const many = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\r\n');
  const tail = tailLines(many);
  check('tailLines keeps the last 20 lines', tail.split('\n').length === 20 && tail.endsWith('line 50') && tail.startsWith('line 31'));
  check('tailLines caps characters', tailLines('x'.repeat(5000)).length <= 2001);
  check('tailLines survives undefined', tailLines(undefined) === '');
  const withDetail = buildRunDigest('r', 'a', 'b', [buildStageResult('triage', false, 'FAILED: x', 5, { detail: 'boom' })]);
  check('digest keeps a failed stage detail', withDetail.stages[0].detail === 'boom');

  check('preflight: all good', preflightProblems({ hasCli: true, hasCv: true, hasBrief: true, needCli: true }).length === 0);
  check('preflight: no CLI is a problem only when needed', preflightProblems({ hasCli: false, hasCv: true, hasBrief: true, needCli: true }).length === 1 && preflightProblems({ hasCli: false, hasCv: true, hasBrief: true, needCli: false }).length === 0);
  check('preflight: reports every missing file', preflightProblems({ hasCli: true, hasCv: false, hasBrief: false, needCli: true }).length === 2);

  const id1 = runIdFor(new Date('2026-09-25T07:30:00.123Z'));
  check('runIdFor is filesystem-safe (no colons)', !id1.includes(':'));
  check('runIdFor is deterministic', runIdFor(new Date('2026-09-25T07:30:00.123Z')) === id1);

  if (failures > 0) {
    console.error(`\n${failures} self-test failure(s)`);
    process.exitCode = 1;
  } else {
    console.log('\nAll self-tests passed.');
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
