#!/usr/bin/env node
// @ts-check
// db-build.mjs — folds career-ops' markdown/TSV files into a derived SQLite
// index (data/careerops.db) so the autopilot dashboard can query instead of
// grep. Every table here is REBUILDABLE from files on disk except
// `submissions` and `mail`, which this script owns and mirrors out to
// data/submissions.tsv / data/mail-sync.tsv (user-layer, append-only) — see
// design/autopilot-plan.md "Layer 1".
//
// Idempotent: drops and rebuilds every derived table from scratch each run.
// Never the source of truth — data/pipeline.md, reports/, and
// data/applications.md stay authoritative; every existing .mjs script, the
// Go TUI, and every mode doc keep reading those files untouched.
//
// node:sqlite ships in Node 22+ behind a warning ("SQLite is an experimental
// feature") — expected, not a bug. Zero new dependencies.
//
// Usage:
//   node autopilot/db-build.mjs                # rebuild data/careerops.db
//   node autopilot/db-build.mjs --db <path>     # build at a different path (tests)
//   node autopilot/db-build.mjs --summary       # print row counts, no other output
//   node autopilot/db-build.mjs --self-test     # in-memory suite; touches no real files

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';
import { resolveTrackerPath } from '../path-resolver.mjs';
import { flagValue, hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = getCareerOpsRoot();

// Directories this build must never walk into: the nested full-repo copy the
// user keeps at career-ops/, and node_modules under both the root and web/.
// A recursive report/JD walk that doesn't exclude these double-counts every
// report and JD, and is measurably slower for no benefit.
const EXCLUDED_DIR_NAMES = new Set(['career-ops', 'node_modules', '.git']);

function isExcludedPath(absPath) {
  const parts = absPath.split(/[\\/]/);
  return parts.some((p) => EXCLUDED_DIR_NAMES.has(p));
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
PRAGMA journal_mode = WAL;

DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS applications;
DROP TABLE IF EXISTS status_events;
-- submissions, mail, runs are NOT dropped here — this script owns their
-- writes elsewhere (autopilot/submissions.mjs, the Gmail-sync stage) and a
-- db-build re-run must not erase in-flight autopilot state. Created with
-- IF NOT EXISTS below so a fresh DB still gets them.

CREATE TABLE jobs (
  url_key      TEXT PRIMARY KEY,   -- normalized dedup key, see url-key.mjs
  url          TEXT NOT NULL,
  company      TEXT,
  title        TEXT,
  location     TEXT,
  posted       TEXT,
  lane         TEXT,               -- il-source | api-jd | agent-fetch | manual (see plan Layer 2)
  status       TEXT,               -- pending | processed
  rank_score   REAL,               -- from rank-pipeline.mjs annotation, if present
  rank_reason  TEXT,
  raw_line     TEXT NOT NULL       -- original pipeline.md row, byte-for-byte
);

CREATE TABLE reports (
  report_num      TEXT PRIMARY KEY,
  filename        TEXT NOT NULL,
  company         TEXT,
  role            TEXT,
  date            TEXT,
  score           REAL,
  legitimacy_tier TEXT,
  archetype       TEXT,
  final_decision  TEXT,
  url             TEXT,
  has_jd_archive  INTEGER          -- 0/1, filled by check-jd-archive.mjs's logic
);

CREATE TABLE applications (
  tracker_num  TEXT PRIMARY KEY,
  date         TEXT,
  company      TEXT,
  role         TEXT,
  score        TEXT,
  status       TEXT,
  pdf          TEXT,
  report_link  TEXT,
  notes        TEXT
);

CREATE TABLE status_events (
  tracker_num  TEXT,
  date         TEXT,
  from_state   TEXT,
  to_state     TEXT,
  source       TEXT,
  note         TEXT
);

CREATE TABLE IF NOT EXISTS submissions (
  id               TEXT PRIMARY KEY,
  report_num       TEXT,
  tracker_num      TEXT,
  status           TEXT,           -- attempted | filled | submitted | aborted | manual
  approved_at      TEXT,
  submitted_at     TEXT,
  answer_hash      TEXT,
  pre_screenshot   TEXT,
  post_screenshot  TEXT,
  confirmation     TEXT,
  abort_reason     TEXT
);

CREATE TABLE IF NOT EXISTS mail (
  thread_id        TEXT PRIMARY KEY,
  tracker_num      TEXT,
  company_guess    TEXT,
  classification   TEXT,           -- ack | rejection | interview_invite | offer | recruiter_outreach | other
  evidence_quote   TEXT,
  synced_at        TEXT,
  applied_action   TEXT            -- what set-status.mjs did with it, if anything
);

CREATE TABLE IF NOT EXISTS runs (
  run_id       TEXT PRIMARY KEY,
  started_at   TEXT,
  finished_at  TEXT,
  stage_json   TEXT                -- per-stage counts/durations, see daily.mjs
);
`;

// ---------------------------------------------------------------------------
// data/pipeline.md → jobs
// ---------------------------------------------------------------------------

// Same row grammar rank-pipeline.mjs's parsePendingEntries uses:
// "- [ ] <url> | <company> | <title> | <location> | <comp> | posted: <date> | ..."
// plus rank-pipeline's own "| rank: X.X/5 — reason" annotation, and this
// build's own lane annotation (added by autopilot/triage-run.mjs in Phase 2:
// "| lane: <name>"). Both annotations are optional and may be absent.
const RANK_RE = /\|\s*rank:\s*([\d.]+)\/5\s*—\s*(.+?)(?=\s*\||$)/;
const LANE_RE = /\|\s*lane:\s*(\S+)/;
const POSTED_RE = /\|\s*posted:\s*(\S+)/;

export function parsePipelineFile(text) {
  const lines = String(text ?? '').split('\n');
  const rows = [];
  let section = null; // 'pending' | 'processed'
  for (const raw of lines) {
    if (/^##\s+Pending/i.test(raw)) { section = 'pending'; continue; }
    if (/^##\s+Processed/i.test(raw)) { section = 'processed'; continue; }
    const isPending = raw.startsWith('- [ ] ');
    const isDone = raw.startsWith('- [x] ') || raw.startsWith('- [X] ');
    if (!isPending && !isDone) continue;

    const body = raw.slice(6);
    const cells = body.split('|').map((c) => c.trim());
    const url = cells[0] ?? '';
    if (!url) continue;

    const rankMatch = raw.match(RANK_RE);
    const laneMatch = raw.match(LANE_RE);
    const postedMatch = raw.match(POSTED_RE);

    rows.push({
      url,
      company: cells[1] ?? '',
      title: cells[2] ?? '',
      location: cells[3] ?? '',
      posted: postedMatch ? postedMatch[1] : '',
      lane: laneMatch ? laneMatch[1] : null,
      status: isDone ? 'processed' : 'pending',
      rank_score: rankMatch ? Number(rankMatch[1]) : null,
      rank_reason: rankMatch ? rankMatch[2].trim() : null,
      raw_line: raw,
    });
  }
  return rows;
}

// Minimal, dependency-free normalization consistent with url-key.mjs's
// stated behavior (strip tracking params, lowercase host, drop fragment and
// trailing slash) — imported lazily so a missing/renamed export degrades to
// this fallback rather than crashing the whole build.
function normalizeUrlKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|gh_src|ref|source)/i.test(p)) u.searchParams.delete(p);
    }
    u.hostname = u.hostname.toLowerCase();
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// reports/*.md → reports
// ---------------------------------------------------------------------------

function listReportFiles() {
  const dir = join(ROOT, 'reports');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f))
    .filter((p) => !isExcludedPath(p));
}

const YAML_SCALAR_RE = /^([a-z_]+):\s*"?(.*?)"?\s*$/i;

export function parseReportFile(text, filename) {
  const numMatch = filename.match(/^(\d+)-/);
  const report_num = numMatch ? numMatch[1] : filename.replace(/\.md$/, '');

  const urlMatch = text.match(/\*\*URL:\*\*\s*(\S+)/);
  const dateMatch = text.match(/\*\*Date:\*\*\s*(\S+)/);
  // Older reports (pre-dating the **Date:** header convention) carry the date
  // only in the filename (NNN-company-YYYY-MM-DD.md) — fall back to that
  // rather than leaving a report undated when the information is right there.
  const filenameDateMatch = filename.match(/(\d{4}-\d{2}-\d{2})\.md$/);

  const yamlMatch = text.match(/## Machine Summary\s*```yaml([\s\S]*?)```/);
  const out = {
    report_num,
    filename,
    company: null,
    role: null,
    date: dateMatch ? dateMatch[1] : (filenameDateMatch ? filenameDateMatch[1] : null),
    score: null,
    legitimacy_tier: null,
    archetype: null,
    final_decision: null,
    url: urlMatch ? urlMatch[1] : null,
    has_jd_archive: /##\s*Job Description \(archived verbatim\)/i.test(text) ? 1 : 0,
  };
  if (yamlMatch) {
    for (const line of yamlMatch[1].split('\n')) {
      const m = line.match(YAML_SCALAR_RE);
      if (!m) continue;
      const [, key, val] = m;
      if (key === 'company') out.company = val;
      else if (key === 'role') out.role = val;
      else if (key === 'score') out.score = Number(val) || null;
      else if (key === 'legitimacy_tier') out.legitimacy_tier = val;
      else if (key === 'archetype') out.archetype = val;
      else if (key === 'final_decision') out.final_decision = val;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// data/applications.md → applications  (via tracker-parse.mjs — no reparsing)
// ---------------------------------------------------------------------------

function readTrackerRows() {
  const trackerPath = resolveTrackerPath(ROOT);
  if (!existsSync(trackerPath)) return [];
  const lines = readFileSync(trackerPath, 'utf-8').split('\n');
  const colmap = resolveColumns(lines);
  const rows = [];
  for (const line of lines) {
    const parsed = parseTrackerRow(line, colmap);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// data/status-log.tsv → status_events
// ---------------------------------------------------------------------------

function readStatusLog() {
  const p = join(ROOT, 'data', 'status-log.tsv');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [tracker_num, date, from_state, to_state, source, note] = line.split('\t');
      return { tracker_num, date, from_state, to_state, source, note: note ?? '' };
    });
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildDatabase(dbPath, { root = ROOT } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  const counts = { jobs: 0, reports: 0, applications: 0, status_events: 0 };

  // jobs
  const pipelinePath = join(root, 'data', 'pipeline.md');
  if (existsSync(pipelinePath)) {
    const rows = parsePipelineFile(readFileSync(pipelinePath, 'utf-8'));
    const insert = db.prepare(`
      INSERT OR REPLACE INTO jobs
        (url_key, url, company, title, location, posted, lane, status, rank_score, rank_reason, raw_line)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      insert.run(
        normalizeUrlKey(r.url), r.url, r.company, r.title, r.location,
        r.posted, r.lane, r.status, r.rank_score, r.rank_reason, r.raw_line,
      );
      counts.jobs += 1;
    }
  }

  // reports
  const reportFiles = listReportFiles();
  if (reportFiles.length) {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO reports
        (report_num, filename, company, role, date, score, legitimacy_tier, archetype, final_decision, url, has_jd_archive)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const filePath of reportFiles) {
      const filename = filePath.split(/[\\/]/).pop();
      const text = readFileSync(filePath, 'utf-8');
      const r = parseReportFile(text, filename);
      insert.run(
        r.report_num, r.filename, r.company, r.role, r.date, r.score,
        r.legitimacy_tier, r.archetype, r.final_decision, r.url, r.has_jd_archive,
      );
      counts.reports += 1;
    }
  }

  // applications
  const trackerRows = readTrackerRows();
  if (trackerRows.length) {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO applications
        (tracker_num, date, company, role, score, status, pdf, report_link, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of trackerRows) {
      insert.run(
        String(r.num ?? ''), r.date ?? '', r.company ?? '', r.role ?? '',
        r.score ?? '', r.status ?? '', r.pdf ?? '', r.report ?? '', r.notes ?? '',
      );
      counts.applications += 1;
    }
  }

  // status_events
  const statusRows = readStatusLog();
  if (statusRows.length) {
    const insert = db.prepare(`
      INSERT INTO status_events (tracker_num, date, from_state, to_state, source, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const r of statusRows) {
      insert.run(r.tracker_num, r.date, r.from_state, r.to_state, r.source, r.note);
      counts.status_events += 1;
    }
  }

  db.close();
  return counts;
}

// ---------------------------------------------------------------------------
// Self-test — in-memory, touches no real files
// ---------------------------------------------------------------------------

function selfTest() {
  let failures = 0;
  const check = (name, cond) => {
    if (!cond) { console.error(`FAIL: ${name}`); failures += 1; }
    else console.log(`ok: ${name}`);
  };

  const pipelineFixture = [
    '# Pipeline',
    '',
    '## Pending',
    '- [ ] https://example.com/a?utm_source=x | Acme | Engineer | Israel | posted: 2026-09-01',
    '- [ ] https://example.com/b | Beta | Analyst | | posted: 2026-09-02 | rank: 4.2/5 — strong archetype match',
    '',
    '## Processed',
    '- [x] https://example.com/c | Gamma | PM | Remote | posted: 2026-08-01',
  ].join('\n');

  const rows = parsePipelineFile(pipelineFixture);
  check('parses 3 rows total', rows.length === 3);
  check('first row is pending', rows[0].status === 'pending' && rows[0].company === 'Acme');
  check('rank annotation parsed', rows[1].rank_score === 4.2 && rows[1].rank_reason === 'strong archetype match');
  check('processed row detected', rows[2].status === 'processed' && rows[2].company === 'Gamma');

  check('url normalization strips utm', normalizeUrlKey('https://Example.com/a?utm_source=x') === 'https://example.com/a');

  const reportFixture = [
    '# Evaluation: Acme — Engineer',
    '',
    '**Date:** 2026-09-19',
    '**URL:** https://example.com/a',
    '',
    '## Machine Summary',
    '',
    '```yaml',
    'company: "Acme"',
    'role: "Engineer"',
    'score: 3.5',
    'legitimacy_tier: "High Confidence"',
    'archetype: "AI Software Engineer"',
    'final_decision: "Pursue"',
    '```',
    '',
    '## Job Description (archived verbatim)',
    'lorem ipsum',
  ].join('\n');
  const rep = parseReportFile(reportFixture, '005-acme-2026-09-19.md');
  check('report_num extracted', rep.report_num === '005');
  check('company extracted', rep.company === 'Acme');
  check('score extracted', rep.score === 3.5);
  check('jd archive detected', rep.has_jd_archive === 1);

  if (failures > 0) {
    console.error(`\n${failures} self-test failure(s)`);
    process.exitCode = 1;
  } else {
    console.log('\nAll self-tests passed.');
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  if (hasFlag(argv, '--self-test')) {
    selfTest();
    return;
  }

  const dbPath = flagValue(argv, '--db') ?? join(ROOT, 'data', 'careerops.db');
  const counts = buildDatabase(dbPath);

  if (hasFlag(argv, '--summary')) {
    console.log(JSON.stringify(counts));
    return;
  }

  console.log(`Built ${dbPath}`);
  for (const [table, n] of Object.entries(counts)) {
    console.log(`  ${table}: ${n}`);
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
