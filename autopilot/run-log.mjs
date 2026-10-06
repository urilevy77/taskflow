#!/usr/bin/env node
// @ts-check
// run-log.mjs — append-only tracking ledger for autopilot runs.
//
// WHY THIS EXISTS, beyond the two sinks daily.mjs already had:
//
//   • data/careerops.db `runs` table — keyed by run_id, keeps every run, but
//     it is a DERIVED index: db-build.mjs is free to drop and rebuild, and
//     the whole point of the plan's Layer 1 is that losing the DB costs
//     nothing. History must not live only there.
//   • data/runs/{date}.json — keyed by DATE, so a second run on the same day
//     OVERWRITES the first. Measured 2026-09-25: three runs happened, the DB
//     kept all three, the JSON mirror kept only the last — silently losing
//     the one run that had actually failed a stage. That file stays useful as
//     "latest run today", but it is not history.
//
// So this is the durable one: append-only TSV, one row per run, never
// rewritten, mirroring the `data/scan-runs.tsv` convention scan.mjs writes
// and stats.mjs reads (AGENTS.md's Main Files table). Same reasons that file
// is a TSV apply here — greppable, diffable, awk-able, and readable by every
// existing tool without a SQLite dependency.
//
// Deliberately NOT a transcript log. Console output is for watching a run in
// flight; this is for answering "how is the pipeline trending" — how many
// rows triaged per day, how much backlog remains, which stage keeps failing.
//
// Usage:
//   node autopilot/run-log.mjs --summary      # human table of recent runs
//   node autopilot/run-log.mjs --json         # machine-readable
//   node autopilot/run-log.mjs --self-test    # in-memory suite, touches no files

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = getCareerOpsRoot();
export const RUN_LOG_PATH = join(ROOT, 'data', 'autopilot-runs.tsv');

// Column order is append-only by contract: NEW COLUMNS GO ON THE END, never
// inserted or reordered, so an older row stays readable by a newer parser
// (the same discipline data/scan-runs.tsv and data/status-log.tsv follow —
// see DATA_CONTRACT.md before changing this line).
export const RUN_LOG_COLUMNS = [
  'timestamp',
  'run_id',
  'outcome',           // ok | partial | failed
  'stages_ok',
  'stages_total',
  'failed_stages',     // comma-joined names, or '-'
  'scan_seconds',
  'triage_seconds',
  'triaged',           // rows actually triaged this run
  'lane_routed',       // rows lane-tagged this run
  'remaining',         // eligible rows left untriaged (the backlog signal)
  'jobs',              // db-build counts, i.e. index size after the run
  'reports',
  'applications',
];

export const RUN_LOG_HEADER = RUN_LOG_COLUMNS.join('\t');

const SENTINEL = '-';

/** A literal tab/newline would split one row into extra fields or rows. */
function cell(value) {
  if (value === null || value === undefined || value === '') return SENTINEL;
  return String(value).replace(/[\t\r\n]+/g, ' ').trim() || SENTINEL;
}

/**
 * Pull structured counts out of triage-run.mjs's human summary lines.
 * Returns nulls (not zeros) for anything absent — a skipped stage genuinely
 * has no count, and recording that as 0 would make "skipped" and "found
 * nothing" indistinguishable in the trend data.
 */
export function parseTriageSummary(text) {
  const s = String(text ?? '');
  const triaged = s.match(/Triaged\s+(\d+)\s+of\s+(\d+)/i);
  const laneRouted = s.match(/Lane-routed\s+(\d+)\s+row/i);
  const remaining = s.match(/(\d+)\s+eligible entr\(ies\) not triaged/i);
  return {
    triaged: triaged ? Number(triaged[1]) : null,
    selected: triaged ? Number(triaged[2]) : null,
    laneRouted: laneRouted ? Number(laneRouted[1]) : null,
    remaining: remaining ? Number(remaining[1]) : null,
  };
}

/** db-build.mjs --summary emits a single JSON object. */
export function parseDbBuildSummary(text) {
  try {
    const raw = String(text ?? '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return { jobs: null, reports: null, applications: null };
    const j = JSON.parse(raw.slice(start, end + 1));
    return {
      jobs: Number.isFinite(j.jobs) ? j.jobs : null,
      reports: Number.isFinite(j.reports) ? j.reports : null,
      applications: Number.isFinite(j.applications) ? j.applications : null,
    };
  } catch {
    return { jobs: null, reports: null, applications: null };
  }
}

/** ok = every stage passed; failed = every stage failed; partial = mixed. */
export function classifyOutcome(stages) {
  const list = Array.isArray(stages) ? stages : [];
  if (!list.length) return 'failed';
  const okCount = list.filter((s) => s.ok).length;
  if (okCount === list.length) return 'ok';
  if (okCount === 0) return 'failed';
  return 'partial';
}

function stageByName(stages, name) {
  return (Array.isArray(stages) ? stages : []).find((s) => s.name === name);
}

/**
 * Build one TSV row from a daily.mjs run digest.
 * @param {{run_id: string, started_at: string, stages: {name: string, ok: boolean, summary: string, durationMs: number}[]}} digest
 */
export function formatRunLogRow(digest) {
  const stages = digest.stages ?? [];
  const triage = stageByName(stages, 'triage');
  const scan = stageByName(stages, 'scan');
  const dbBuild = stageByName(stages, 'db-build');

  const t = parseTriageSummary(triage?.summary);
  const d = parseDbBuildSummary(dbBuild?.summary);
  const failed = stages.filter((s) => !s.ok).map((s) => s.name);

  const values = [
    digest.started_at,
    digest.run_id,
    classifyOutcome(stages),
    stages.filter((s) => s.ok).length,
    stages.length,
    failed.length ? failed.join(',') : SENTINEL,
    scan ? (scan.durationMs / 1000).toFixed(1) : SENTINEL,
    triage ? (triage.durationMs / 1000).toFixed(1) : SENTINEL,
    t.triaged,
    t.laneRouted,
    t.remaining,
    d.jobs,
    d.reports,
    d.applications,
  ];
  return values.map(cell).join('\t');
}

/** Appends one row, writing the header first if the file is new. */
export function appendRunLog(digest, path = RUN_LOG_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const needsHeader = !existsSync(path) || readFileSync(path, 'utf-8').trim() === '';
  const row = formatRunLogRow(digest);
  appendFileSync(path, `${needsHeader ? `${RUN_LOG_HEADER}\n` : ''}${row}\n`);
  return row;
}

/** Parse the ledger back into objects, tolerant of appended-later columns. */
export function readRunLog(path = RUN_LOG_PATH) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const row = {};
    header.forEach((key, i) => { row[key] = cells[i] ?? SENTINEL; });
    return row;
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printSummary(rows) {
  if (!rows.length) {
    console.log('No autopilot runs logged yet. data/autopilot-runs.tsv is written by autopilot/daily.mjs.');
    return;
  }
  const recent = rows.slice(-15);
  console.log('');
  console.log('  date/time            outcome  stages  triaged  routed  remaining  jobs   failed');
  console.log('  ' + '-'.repeat(88));
  for (const r of recent) {
    const when = String(r.timestamp).slice(0, 19).replace('T', ' ');
    console.log(
      `  ${when.padEnd(20)} ${String(r.outcome).padEnd(8)} ${`${r.stages_ok}/${r.stages_total}`.padEnd(7)} ` +
      `${String(r.triaged).padEnd(8)} ${String(r.lane_routed).padEnd(7)} ${String(r.remaining).padEnd(10)} ` +
      `${String(r.jobs).padEnd(6)} ${r.failed_stages}`,
    );
  }
  const triagedTotal = rows.reduce((sum, r) => sum + (Number(r.triaged) || 0), 0);
  const failedRuns = rows.filter((r) => r.outcome !== 'ok').length;
  console.log('');
  console.log(`  ${rows.length} run(s) logged | ${triagedTotal} row(s) triaged lifetime | ${failedRuns} run(s) with a failed stage`);
  const last = rows[rows.length - 1];
  if (last.remaining && last.remaining !== SENTINEL) {
    console.log(`  Backlog after last run: ${last.remaining} eligible row(s) awaiting triage`);
  }
  console.log('');
}

function selfTest() {
  let failures = 0;
  const check = (name, cond) => {
    if (!cond) { console.error(`FAIL: ${name}`); failures += 1; }
    else console.log(`ok: ${name}`);
  };

  // Real triage-run.mjs output, verbatim from the 2026-09-25 live run.
  const realTriage = '  Triaged 10 of 10 selected entr(ies) in 2 CLI call(s) via claude. /   Lane-routed 203 row(s) total this run. /   283 eligible entr(ies) not triaged this run (--budget 10). Re-run to continue.';
  const t = parseTriageSummary(realTriage);
  check('parses triaged count from real output', t.triaged === 10 && t.selected === 10);
  check('parses lane-routed from real output', t.laneRouted === 203);
  check('parses remaining backlog from real output', t.remaining === 283);

  const skipped = parseTriageSummary('skipped (--skip-triage)');
  check('skipped triage yields nulls, not zeros', skipped.triaged === null && skipped.laneRouted === null);

  const d = parseDbBuildSummary('{"jobs":1532,"reports":76,"applications":58,"status_events":2}');
  check('parses db-build counts', d.jobs === 1532 && d.reports === 76 && d.applications === 58);
  check('db-build garbage yields nulls', parseDbBuildSummary('not json').jobs === null);

  check('classifyOutcome all ok', classifyOutcome([{ ok: true }, { ok: true }]) === 'ok');
  check('classifyOutcome mixed is partial', classifyOutcome([{ ok: true }, { ok: false }]) === 'partial');
  check('classifyOutcome none ok is failed', classifyOutcome([{ ok: false }]) === 'failed');
  check('classifyOutcome empty is failed', classifyOutcome([]) === 'failed');

  // The real 2026-09-25 run that the JSON mirror lost: scan failed, rest ok.
  const digest = {
    run_id: '2026-09-25T20-37-49-772Z',
    started_at: '2026-09-25T20:37:49.772Z',
    stages: [
      { name: 'goozali', ok: true, summary: 'skipped (not Monday)', durationMs: 0 },
      { name: 'scan', ok: false, summary: 'FAILED: spawnSync node ETIMEDOUT', durationMs: 900000 },
      { name: 'triage', ok: true, summary: realTriage, durationMs: 175900 },
      { name: 'db-build', ok: true, summary: '{"jobs":1532,"reports":76,"applications":58}', durationMs: 4800 },
      { name: 'health', ok: true, summary: 'ok', durationMs: 700 },
    ],
  };
  const row = formatRunLogRow(digest);
  const cells = row.split('\t');
  check('row has exactly the declared column count', cells.length === RUN_LOG_COLUMNS.length);
  check('row outcome is partial', cells[RUN_LOG_COLUMNS.indexOf('outcome')] === 'partial');
  check('row names the failed stage', cells[RUN_LOG_COLUMNS.indexOf('failed_stages')] === 'scan');
  check('row records scan seconds', cells[RUN_LOG_COLUMNS.indexOf('scan_seconds')] === '900.0');
  check('row records triaged', cells[RUN_LOG_COLUMNS.indexOf('triaged')] === '10');
  check('row records remaining backlog', cells[RUN_LOG_COLUMNS.indexOf('remaining')] === '283');
  check('row contains no newline', !row.includes('\n'));

  // A tab or newline smuggled in via a stage summary must not add fields.
  const nasty = {
    run_id: 'r', started_at: 't',
    stages: [{ name: 'scan', ok: false, summary: 'FAILED: bad\tthing\nsecond line', durationMs: 1 }],
  };
  check('sanitizes tabs/newlines out of cells', formatRunLogRow(nasty).split('\t').length === RUN_LOG_COLUMNS.length);

  const parsedBack = (() => {
    const header = RUN_LOG_HEADER;
    const text = `${header}\n${row}\n`;
    const lines = text.split('\n').filter((l) => l.trim());
    const h = lines[0].split('\t');
    const c = lines[1].split('\t');
    const o = {};
    h.forEach((k, i) => { o[k] = c[i]; });
    return o;
  })();
  check('round-trips through header parse', parsedBack.run_id === '2026-09-25T20-37-49-772Z' && parsedBack.triaged === '10');

  if (failures > 0) {
    console.error(`\n${failures} self-test failure(s)`);
    process.exitCode = 1;
  } else {
    console.log('\nAll self-tests passed.');
  }
}

function main(argv) {
  if (hasFlag(argv, '--self-test')) return selfTest();
  const rows = readRunLog();
  if (hasFlag(argv, '--json')) {
    console.log(JSON.stringify({ path: RUN_LOG_PATH, runs: rows }, null, 2));
    return;
  }
  printSummary(rows);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
