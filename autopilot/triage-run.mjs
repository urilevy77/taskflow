#!/usr/bin/env node
// @ts-check
// triage-run.mjs — the missing consumer of modes/triage.md's `TRIAGE:` contract
// (design/autopilot-plan.md, Layer 2 stage 5). The mode has existed since
// before this script and is invoked interactively all the time; nothing in
// the repo drives it unattended and parses its output. This does that, plus
// the deterministic HOST LANE routing that decides what gets sent to the LLM
// at all — see the plan's "Stage 3 is not the filter I first assumed it was"
// for why lanes exist instead of a location/title regex.
//
// Two responsibilities, always in this order, always one pipeline.md write:
//   1. LANE every un-lane-tagged pending row (cheap, deterministic, always
//      runs to completion regardless of budget — it's what /autopilot/runs
//      renders as "Pending by lane").
//   2. TRIAGE up to --budget eligible rows (il-source/api-jd/agent-fetch
//      only — `manual` rows are marked SKIP immediately, never sent to a
//      model, because portals.yml already documents they 302 to a login
//      wall and can only ever resolve to SKIP).
//
// Reuses rank-pipeline.mjs's parsePendingEntries/selectBatch/detectCli and
// scan.mjs's sanitizeMarkdownField — both SYSTEM_PATHS files, imported not
// edited. Never writes reports/ or the tracker; that's batch-runner.sh's job
// (daily.mjs stage 6), fed by this script's PASS verdicts.
//
// Usage:
//   node autopilot/triage-run.mjs                  # triage up to the default budget
//   node autopilot/triage-run.mjs --budget 30
//   node autopilot/triage-run.mjs --cli codex
//   node autopilot/triage-run.mjs --dry-run         # print what would be written
//   node autopilot/triage-run.mjs --self-test       # in-memory suite; spawns no subprocess

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';
import { parsePendingEntries, selectBatch, detectCli, resolveBin, LIMIT_CEILING } from '../rank-pipeline.mjs';
import { sanitizeMarkdownField } from '../scan.mjs';
import { resolveAtsApi, JD_TEXT_API_ATS } from '../liveness-api.mjs';
import { fetchJdViaKnownApi } from '../browser-extract.mjs';
import { flagValue, hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = getCareerOpsRoot();
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const TRIAGE_MODE_PATH = join(ROOT, 'modes', 'triage.md');
const BRIEF_PATH = join(ROOT, 'modes', '_brief.md');
const JDS_DIR = join(ROOT, 'jds');

const DEFAULT_BUDGET = 40;
const CLI_BATCH_SIZE = 5; // each job costs a WebFetch round trip — smaller than rank-pipeline's title-only batches
const MAX_CONSECUTIVE_FAILURES = 3; // circuit breaker: an exhausted quota fails identically forever
const CLI_ERROR_MAX_CHARS = 200;
const LANE_LABEL = '| lane: ';
const TRIAGE_LABEL = '| triage: ';

const USAGE = `
  triage-run.mjs — lane routing + modes/triage.md driver (annotates pipeline.md)

  node autopilot/triage-run.mjs [--budget N] [--cli <name>] [--model <name>] [--dry-run]

    --budget N    max rows to send to the LLM this run (default ${DEFAULT_BUDGET}, ceiling ${LIMIT_CEILING})
    --lane a,b    only spend the budget on these lanes (il-source/api-jd/agent-fetch);
                  lane routing still runs over every row, so excluded rows keep
                  their lane tag and stay eligible for the next run
    --cli <name>  force a CLI instead of auto-detecting
    --model <n>   passed through to the CLI when it accepts one
    --dry-run     still calls the CLI (same cost) but skips writing pipeline.md — matches rank-pipeline.mjs's own --dry-run semantics
    --self-test   run the in-memory suite (no subprocess, no network)
`;

// ---------------------------------------------------------------------------
// Lane routing
// ---------------------------------------------------------------------------

// Hosts that are Israel-based by construction even though scan.mjs's
// location_filter can't see it in a structured field (empty-location rows
// pass by design — see portals.yml's documented "don't penalize missing
// data" rule). `.il` TLD covers civi.co.il / director.org.il for free.
const IL_EXTRA_HOSTS = new Set(['comeet.com', 'referally.link']);

// portals.yml:3141 (SecretHunter.io audit note, verified 2026-09-23): every
// row URL 302s to a signin wall behind reCAPTCHA — no automation, ours or a
// model's WebFetch, can ever read the JD. Sending these to triage can only
// ever produce SKIP, at real token cost. Add hosts here only with the same
// kind of documented, verified evidence — this is a hard exclusion from the
// LLM entirely, not a scoring signal.
const MANUAL_HOSTS = new Set(['secrethunter.io']);

/** @returns {'il-source'|'api-jd'|'agent-fetch'|'manual'} */
export function classifyLane(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'agent-fetch';
  }
  if (MANUAL_HOSTS.has(host)) return 'manual';
  if (host.endsWith('.il') || IL_EXTRA_HOSTS.has(host)) return 'il-source';
  const resolved = resolveAtsApi(url);
  if (resolved && JD_TEXT_API_ATS.has(resolved.ats)) return 'api-jd';
  return 'agent-fetch';
}

// ---------------------------------------------------------------------------
// TRIAGE: line parsing — the contract modes/triage.md defines but nothing
// in the repo previously consumed.
// ---------------------------------------------------------------------------

const TRIAGE_LINE_RE = /^TRIAGE:\s*(PASS|MARGINAL|FAIL|SKIP)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([\d.]+)\/5\s*\|\s*(.+)$/i;

export function parseTriageLine(line) {
  const m = String(line ?? '').trim().match(TRIAGE_LINE_RE);
  if (!m) return null;
  return {
    verdict: m[1].toUpperCase(),
    company: m[2].trim(),
    role: m[3].trim(),
    score: Number(m[4]),
    reason: m[5].trim(),
  };
}

/**
 * A batch prompt asks for exactly N TRIAGE: lines, in order. Extracting ALL
 * matching lines and requiring the count to equal N is deliberately strict —
 * matching results to jobs by ANYTHING other than position (company-name
 * fuzzy matching, say) risks silently attributing job A's verdict to job B.
 * A count mismatch fails the WHOLE batch rather than guessing an alignment;
 * every job in it stays un-annotated and is retried next run. Same "a
 * skipped batch is safe, a clever partial parser is a bug surface" rule
 * rank-pipeline.mjs's parseBatchResponse already applies.
 */
export function parseTriageBatchOutput(text, expectedCount) {
  const lines = String(text ?? '')
    .split('\n')
    .filter((l) => /^TRIAGE:/i.test(l.trim()));
  if (lines.length !== expectedCount) return null;
  const parsed = lines.map(parseTriageLine);
  if (parsed.some((p) => p === null)) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * @param {{ref: string, company: string, title: string}[]} jobs - `ref` is
 *   either the raw posting URL, or `local:jds/{file}` for a pre-fetched JD.
 */
export function buildTriagePrompt(jobs) {
  const listing = jobs
    .map((j, i) => `${i + 1}. ${j.ref}${j.company ? ` (listed company: ${j.company}` : ''}${j.title ? `, listed title: ${j.title})` : j.company ? ')' : ''}`)
    .join('\n');
  return [
    'Read modes/triage.md and modes/_brief.md, then run the exact triage process modes/triage.md describes for EACH of the jobs listed below, in order.',
    '',
    'A `local:` reference means the JD text is already saved at that path — read it with the Read tool instead of fetching. A bare URL means fetch it yourself, per modes/triage.md step 1.',
    '',
    `JOBS (${jobs.length}):`,
    listing,
    '',
    `Output EXACTLY ${jobs.length} lines, one TRIAGE: line per job above, in the same order, and nothing else — no headers, no blank lines between them, no commentary before or after.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// JD pre-fetch for the api-jd lane (zero-token, done here rather than inside
// the subprocess so a triage batch never blocks on a slow ATS API call
// happening as a *tool call inside* the model's turn).
// ---------------------------------------------------------------------------

function slugifyForJdFile(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'job';
}

// sha1 without pulling in node:crypto's whole surface just for a short id —
// matches plugins/apify/index.mjs's own {company}-{role}-{sha1(url)[0:10]}.md
// convention (AGENTS.md § "JD captures") so autopilot-written files fit the
// same directory as every other writer.
async function shortHash(input) {
  const { createHash } = await import('node:crypto');
  return createHash('sha1').update(input).digest('hex').slice(0, 10);
}

/**
 * Fetches JD text for an api-jd-lane URL and saves it under jds/, returning
 * the `local:jds/{file}` reference to hand to triage instead of the URL.
 * Returns null on a miss — the caller falls back to the raw URL (the
 * subprocess's own WebFetch is the fallback fetch-jd.mjs's own header
 * documents), never blocks the row.
 */
export async function prefetchJd(url, company, title) {
  const result = await fetchJdViaKnownApi(url).catch(() => null);
  if (!result || !result.text) return null;
  mkdirSync(JDS_DIR, { recursive: true });
  const hash = await shortHash(url);
  const filename = `${slugifyForJdFile(company)}-${slugifyForJdFile(title)}-${hash}.md`;
  const body = `# ${result.title || `${company} — ${title}`}\n\nSource: ${url}\n\n${result.text}`;
  writeFileSync(join(JDS_DIR, filename), body);
  return `local:jds/${filename}`;
}

// ---------------------------------------------------------------------------
// Row rewriting — lane + triage segments, plus the checkbox flip for
// terminal verdicts (FAIL / inaccessible SKIP / manual-lane SKIP never get
// re-triaged; PASS / MARGINAL stay pending for stage 6 / your review).
// ---------------------------------------------------------------------------

export function formatTriageSegment(verdict, score, reason) {
  const clamped = Number.isFinite(Number(score)) ? Math.min(5, Math.max(0, Number(score))).toFixed(1) : '0.0';
  const clean = sanitizeMarkdownField(reason ?? '').trim();
  return `triage: ${verdict} ${clamped}/5 — ${clean || 'no reason given'}`;
}

const TERMINAL_VERDICTS = new Set(['FAIL', 'SKIP']);

/**
 * @param {string} text - current pipeline.md contents
 * @param {{raw: string, lane?: string, triage?: {verdict: string, score: number, reason: string}}[]} updates
 * @returns {{text: string, written: number}}
 */
export function applyRowUpdates(text, updates) {
  const queue = updates.map((u) => ({ ...u, used: false }));
  let written = 0;
  const out = String(text ?? '')
    .split('\n')
    .map((line) => {
      // CRLF files: keep the \r at the end of the row, never in the middle of it.
      const cr = line.endsWith('\r') ? '\r' : '';
      const body = cr ? line.slice(0, -1) : line;
      const hit = queue.find((u) => !u.used && (u.raw === line || u.raw === body));
      if (!hit) return line;
      hit.used = true;
      written += 1;

      let next = body;
      if (hit.lane && !next.includes(LANE_LABEL)) next += ` | lane: ${hit.lane}`;
      if (hit.triage && !next.includes(TRIAGE_LABEL)) {
        next += ` | ${formatTriageSegment(hit.triage.verdict, hit.triage.score, hit.triage.reason)}`;
      }
      if (hit.triage && TERMINAL_VERDICTS.has(hit.triage.verdict) && next.startsWith('- [ ] ')) {
        next = `- [x] ${next.slice(6)}`;
      }
      return next + cr;
    })
    .join('\n');
  return { text: out, written };
}

// ---------------------------------------------------------------------------
// CLI invocation — deliberately NOT rank-pipeline.mjs's CLI_CANDIDATES: that
// table is tuned for a no-tool, title-only ranking task and omits any
// permission-bypass flag on purpose. Triage needs Read (for `local:` JD
// files) and WebFetch (for everything else) to work unattended, so claude
// gets --dangerously-skip-permissions here — the same flag batch-runner.sh
// already uses for exactly this reason (its own header comment says so).
// Still built on detectCli()'s generic probing, just with different candidates.
// ---------------------------------------------------------------------------

export const TRIAGE_CLI_CANDIDATES = [
  { bin: 'claude', args: (p) => ['-p', p, '--dangerously-skip-permissions'] },
  { bin: 'codex', args: (p) => ['exec', p] },
  { bin: 'opencode', args: (p) => ['run', p] },
  { bin: 'copilot', args: (p) => ['-p', p] },
  { bin: 'qwen', args: (p) => ['-p', p] },
  { bin: 'agy', args: (p) => ['-p', p] },
  { bin: 'grok', args: (p) => ['-p', p] },
];

function callCli(cli, prompt, model) {
  const args = cli.args(prompt);
  if (model && cli.bin !== 'codex' && cli.bin !== 'opencode') args.push('--model', model);
  return execFileSync(resolveBin(cli.bin), args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 180_000, // WebFetch round trips push well past rank-pipeline's 120s budget
    cwd: ROOT,
  });
}

/**
 * execFileSync's error message embeds the ENTIRE command line, which for this
 * script is the whole triage prompt with every URL in the batch. Logging it
 * raw once produced a 967-line log from a single 40-row run; unattended on a
 * schedule that is a five-figure log file. Prefer the error code, fall back to
 * the first line of the message, and cap it hard.
 */
/**
 * Parses --lane into a Set of lane names, or null when the flag is absent
 * (meaning "every lane"). Accepts a comma-separated list: --lane api-jd,agent-fetch.
 * @param {string|undefined} value
 * @returns {Set<string>|null}
 */
export function parseLaneFilter(value) {
  if (value == null) return null;
  const lanes = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return lanes.length ? new Set(lanes) : null;
}

export function summarizeCliError(err) {
  if (err?.code) return String(err.code);
  if (err?.signal) return `signal ${err.signal}`;

  const cap = (s) => (s.length > CLI_ERROR_MAX_CHARS ? `${s.slice(0, CLI_ERROR_MAX_CHARS)}… (truncated)` : s);

  // The CLI's own stderr is the diagnostic worth keeping (quota messages land
  // here); it does not contain the prompt.
  const stderr = String(err?.stderr ?? '').trim();
  if (stderr) return cap(stderr.split('\n')[0].trim());

  // Truncation alone is NOT enough: "Command failed: claude -p "<prompt>"" puts
  // the prompt inside the first 200 chars, so a cap still leaks it. When the
  // message is the command-line echo, drop it wholesale.
  const firstLine = String(err?.message ?? 'unknown error').split('\n')[0].trim();
  if (/^Command failed:/i.test(firstLine)) return 'CLI call failed (command line withheld)';
  return cap(firstLine);
}

/**
 * selectBatch (rank-pipeline.mjs) treats a falsy limit as "use its own
 * default (20)", not "zero" — the exact footgun that let a live
 * `--budget 0` run spawn a real CLI call against 20 rows during testing of
 * this script (caught, killed, no file damage, but a real one-time cost).
 * An explicit 0 must mean zero, unconditionally, with no fallback.
 */
export function resolveBudgetSelection(eligible, budget) {
  return Number(budget) === 0 ? [] : selectBatch(eligible, budget);
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
  if (!existsSync(PIPELINE_PATH)) {
    console.log('No data/pipeline.md yet — run a scan first. Nothing to triage.');
    return 0;
  }
  if (!existsSync(BRIEF_PATH)) {
    console.log('modes/_brief.md does not exist yet — triage cannot run without it (see modes/triage.md). Run onboarding first.');
    return 1;
  }

  const dryRun = hasFlag(argv, '--dry-run');
  const budget = flagValue(argv, '--budget') ?? DEFAULT_BUDGET;
  const laneFilter = parseLaneFilter(flagValue(argv, '--lane'));
  const model = flagValue(argv, '--model');
  const forced = flagValue(argv, '--cli');

  const pipelineText = readFileSync(PIPELINE_PATH, 'utf-8');
  const pending = parsePendingEntries(pipelineText).filter((e) => !e.raw.includes(LANE_LABEL));

  // Rows already lane-tagged but not yet triaged (from a prior run's budget
  // spillover) still need triage — separately gathered since they don't
  // match the "un-lane-tagged" filter above.
  const untriagedTagged = String(pipelineText)
    .split('\n')
    .map((raw, index) => ({ raw, index }))
    .filter(({ raw }) => raw.startsWith('- [ ] ') && raw.includes(LANE_LABEL) && !raw.includes(TRIAGE_LABEL))
    .map(({ raw }) => {
      const cells = raw.slice(6).split('|').map((c) => c.trim());
      const laneMatch = raw.match(/\|\s*lane:\s*(\S+)/);
      return { raw, url: cells[0] ?? '', company: cells[1] ?? '', title: cells[2] ?? '', lane: laneMatch ? laneMatch[1] : null };
    });

  const updates = [];

  // 1. Lane-route every un-lane-tagged row, unconditionally — cheap and
  // deterministic, no reason to gate it behind the triage budget.
  const eligible = []; // {raw, url, company, title, lane}
  for (const e of pending) {
    const lane = classifyLane(e.url);
    if (lane === 'manual') {
      updates.push({
        raw: e.raw,
        lane,
        triage: { verdict: 'SKIP', score: 0, reason: 'account-walled source (see portals.yml) — automation cannot reach the JD' },
      });
      continue;
    }
    eligible.push({ raw: e.raw, url: e.url, company: e.company, title: e.title, lane });
  }
  for (const e of untriagedTagged) {
    if (e.lane && e.lane !== 'manual') eligible.push(e);
  }

  if (!eligible.length && !updates.length) {
    console.log('No eligible pending entries. Nothing to do.');
    return 0;
  }

  // --lane narrows only what gets SENT to the LLM. Lane routing above still
  // runs over everything, so an excluded row keeps its lane annotation and
  // stays eligible for the next run — it is a spend filter, not a scope cut.
  const spendable = laneFilter ? eligible.filter((e) => laneFilter.has(e.lane)) : eligible;
  if (laneFilter) {
    console.log(`  --lane ${[...laneFilter].join(',')}: ${spendable.length} of ${eligible.length} eligible row(s) in scope`);
  }

  const selected = resolveBudgetSelection(spendable, budget);

  const cli = forced
    ? TRIAGE_CLI_CANDIDATES.find((c) => c.bin === forced) ?? { bin: forced, args: (p) => ['-p', p] }
    : detectCli(TRIAGE_CLI_CANDIDATES);
  if (!cli && selected.length) {
    console.error('No supported agent CLI found (tried: %s).', TRIAGE_CLI_CANDIDATES.map((c) => c.bin).join(', '));
    console.error('Install one, or pass --cli <name>. See the Headless / Batch Mode table in AGENTS.md.');
    return 1;
  }

  let attemptedCalls = 0;
  let skippedBatches = 0;
  let consecutiveFailures = 0;
  let abortReason = null;
  const triaged = [];

  for (let i = 0; i < selected.length; i += CLI_BATCH_SIZE) {
    // Quota/rate-limit circuit breaker. An exhausted quota fails every
    // subsequent call identically, so continuing past a short run of
    // failures burns the rest of the budget on doomed calls (once: 72 of
    // them). batch/batch-runner.sh treats this as its `rate_limited` state
    // and stops; mirror that rather than inventing a second mechanism.
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      abortReason = `${consecutiveFailures} consecutive batch failures — quota/rate limit suspected`;
      console.error(`  aborting run: ${abortReason}`);
      console.error('  remaining entries left un-annotated; re-run when quota recovers.');
      break;
    }

    const batch = selected.slice(i, i + CLI_BATCH_SIZE);
    const jobs = [];
    for (const e of batch) {
      let ref = e.url;
      if (e.lane === 'api-jd') {
        const local = await prefetchJd(e.url, e.company, e.title).catch(() => null);
        if (local) ref = local;
      }
      jobs.push({ ref, company: e.company, title: e.title });
    }

    attemptedCalls += 1;
    let response;
    try {
      response = callCli(cli, buildTriagePrompt(jobs), model);
    } catch (err) {
      console.error(`  batch ${i / CLI_BATCH_SIZE + 1}: CLI call failed (${summarizeCliError(err)}) — entries left un-annotated`);
      skippedBatches += 1;
      consecutiveFailures += 1;
      continue;
    }
    const results = parseTriageBatchOutput(response, batch.length);
    if (!results) {
      console.error(`  batch ${i / CLI_BATCH_SIZE + 1}: TRIAGE line count mismatch — entries left un-annotated`);
      skippedBatches += 1;
      consecutiveFailures += 1;
      continue;
    }
    consecutiveFailures = 0;
    results.forEach((r, idx) => triaged.push({ raw: batch[idx].raw, lane: batch[idx].lane, triage: r }));
  }

  // Rows lane-tagged this run but past budget: still get their lane
  // annotation written now, just not triaged yet.
  const untriagedButLaned = eligible
    .filter((e) => !selected.includes(e))
    .filter((e) => !e.raw.includes(LANE_LABEL)) // already-tagged spillover rows need no lane write
    .map((e) => ({ raw: e.raw, lane: e.lane }));

  const allUpdates = [...updates, ...triaged, ...untriagedButLaned];

  if (dryRun) {
    for (const u of allUpdates) {
      const laneStr = u.lane ? ` lane:${u.lane}` : '';
      const triageStr = u.triage ? ` ${formatTriageSegment(u.triage.verdict, u.triage.score, u.triage.reason)}` : '';
      console.log(`${u.raw.slice(0, 80)}...${laneStr}${triageStr}`);
    }
    console.log(`\n  [dry-run] would update ${allUpdates.length} row(s): ${triaged.length} triaged, ${allUpdates.length - triaged.length} lane-only.`);
    return 0;
  }

  let written = 0;
  if (allUpdates.length) {
    await withPipelineLock(PIPELINE_PATH, () => {
      const current = readFileSync(PIPELINE_PATH, 'utf-8');
      const result = applyRowUpdates(current, allUpdates);
      written = result.written;
      if (written) writeFileSync(PIPELINE_PATH, result.text);
    });
  }

  console.log(`\n  Triaged ${triaged.length} of ${selected.length} selected entr(ies) in ${attemptedCalls} CLI call(s) via ${cli ? cli.bin : 'n/a'}.`);
  console.log(`  Lane-routed ${written} row(s) total this run.`);
  if (abortReason) console.log(`  ABORTED EARLY: ${abortReason}`);
  if (skippedBatches) console.log(`  ${skippedBatches} batch(es) skipped — those rows are un-annotated, retried next run.`);
  if (eligible.length > selected.length) {
    console.log(`  ${eligible.length - selected.length} eligible entr(ies) not triaged this run (--budget ${selected.length}). Re-run to continue.`);
  }
  return 0;
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

  check('il-source: .co.il', classifyLane('https://jobs.example.co.il/1') === 'il-source');
  check('il-source: comeet.com', classifyLane('https://www.comeet.com/jobs/x/1') === 'il-source');
  check('manual: secrethunter.io', classifyLane('https://secrethunter.io/jobz/1') === 'manual');
  check('api-jd: greenhouse', classifyLane('https://job-boards.greenhouse.io/acme/jobs/123') === 'api-jd');
  check('agent-fetch: linkedin', classifyLane('https://www.linkedin.com/jobs/view/123') === 'agent-fetch');
  check('agent-fetch: malformed url', classifyLane('not-a-url') === 'agent-fetch');

  const line = 'TRIAGE: PASS | Acme Corp | Senior Engineer | 4.3/5 | Remote, comp clears floor';
  const parsed = parseTriageLine(line);
  check('parses TRIAGE line', parsed && parsed.verdict === 'PASS' && parsed.score === 4.3 && parsed.company === 'Acme Corp');

  check('rejects malformed line', parseTriageLine('not a triage line') === null);

  // Defect: execFileSync's message embeds the whole prompt (967-line log from
  // one 40-row run). summarizeCliError must never echo it back.
  const promptEcho = new Error(
    'Command failed: claude -p "You are triaging jobs. https://example.com/a https://example.com/b ' +
      'x'.repeat(5000) +
      '"',
  );
  const summarized = summarizeCliError(promptEcho);
  check('summarizeCliError caps length', summarized.length <= CLI_ERROR_MAX_CHARS + 20);
  check('summarizeCliError drops the echoed prompt tail', !summarized.includes('xxxxxxxxxxxxxxxxxxxx'));
  check('summarizeCliError prefers the error code', summarizeCliError({ code: 'ETIMEDOUT', message: 'a'.repeat(9000) }) === 'ETIMEDOUT');
  check('summarizeCliError reports a signal', summarizeCliError({ signal: 'SIGTERM' }) === 'signal SIGTERM');
  check('summarizeCliError survives a bare throw', typeof summarizeCliError(undefined) === 'string');

  // Defect: an exhausted quota fails every call identically. 72 doomed calls
  // once ran before the outer no-progress guard stopped it.
  check('breaker threshold is small enough to matter', MAX_CONSECUTIVE_FAILURES >= 2 && MAX_CONSECUTIVE_FAILURES <= 5);
  let consecutive = 0;
  let calls = 0;
  for (let i = 0; i < 100; i += 1) {
    if (consecutive >= MAX_CONSECUTIVE_FAILURES) break;
    calls += 1;
    consecutive += 1; // simulate every call failing, as an exhausted quota does
  }
  check('breaker stops after MAX_CONSECUTIVE_FAILURES calls', calls === MAX_CONSECUTIVE_FAILURES);
  let mixed = 0;
  let mixedCalls = 0;
  for (let i = 0; i < 10; i += 1) {
    if (mixed >= MAX_CONSECUTIVE_FAILURES) break;
    mixedCalls += 1;
    mixed = i % 2 === 0 ? mixed + 1 : 0; // a success resets the counter
  }
  check('an intermittent failure does not trip the breaker', mixedCalls === 10);

  const batchOut = [
    'TRIAGE: PASS | A | Role A | 4.0/5 | good fit',
    'TRIAGE: FAIL | B | Role B | 1.0/5 | bad fit',
  ].join('\n');
  const batchParsed = parseTriageBatchOutput(batchOut, 2);
  check('batch parse matches count', batchParsed && batchParsed.length === 2 && batchParsed[1].verdict === 'FAIL');
  check('batch parse rejects count mismatch', parseTriageBatchOutput(batchOut, 3) === null);
  check('batch parse tolerates surrounding prose', parseTriageBatchOutput(`Sure, here you go:\n${batchOut}\nDone.`, 2)?.length === 2);

  check('formatTriageSegment sanitizes pipes', formatTriageSegment('PASS', 4.567, 'has a | pipe').includes('/') && !formatTriageSegment('PASS', 4.567, 'has a | pipe').slice(20).includes('|'));
  check('formatTriageSegment clamps score', formatTriageSegment('PASS', 9.9, 'x').includes('5.0/5'));

  const pipelineFixture = [
    '## Pending',
    '- [ ] https://example.com/a | Acme | Engineer | Israel',
    '- [ ] https://example.com/b | Beta | Analyst | Israel',
  ].join('\n');
  const updates = [
    { raw: '- [ ] https://example.com/a | Acme | Engineer | Israel', lane: 'agent-fetch', triage: { verdict: 'FAIL', score: 1.5, reason: 'no overlap' } },
    { raw: '- [ ] https://example.com/b | Beta | Analyst | Israel', lane: 'agent-fetch' },
  ];
  const applied = applyRowUpdates(pipelineFixture, updates);
  check('applyRowUpdates writes both rows', applied.written === 2);
  check('applyRowUpdates flips checkbox on FAIL', applied.text.includes('- [x] https://example.com/a'));
  check('applyRowUpdates keeps PASS-less row pending', applied.text.includes('- [ ] https://example.com/b'));
  check('applyRowUpdates appends lane on both', (applied.text.match(/\| lane: agent-fetch/g) || []).length === 2);
  check('applyRowUpdates idempotent on second pass', applyRowUpdates(applied.text, updates).written === 0);

  const prompt = buildTriagePrompt([{ ref: 'https://x.com/1', company: 'Acme', title: 'Engineer' }, { ref: 'local:jds/beta.md', company: 'Beta', title: '' }]);
  check('prompt lists both jobs', prompt.includes('https://x.com/1') && prompt.includes('local:jds/beta.md'));
  check('prompt asks for exact line count', prompt.includes('EXACTLY 2 lines'));

  // Regression: a live --budget 0 run once fell through to selectBatch's
  // internal default (20) instead of selecting nothing, spawning a real,
  // unintended CLI call. Locking this down so it can never regress silently.
  const manyEligible = Array.from({ length: 25 }, (_, i) => ({ raw: `row${i}`, url: `https://x.com/${i}`, lane: 'agent-fetch' }));
  check('resolveBudgetSelection(0) selects nothing', resolveBudgetSelection(manyEligible, 0).length === 0);
  check('resolveBudgetSelection(0) is not selectBatch\'s fallback default', resolveBudgetSelection(manyEligible, 0).length !== selectBatch(manyEligible, undefined).length);
  check('resolveBudgetSelection(5) selects exactly 5', resolveBudgetSelection(manyEligible, 5).length === 5);
  check('resolveBudgetSelection(undefined) falls back to selectBatch default', resolveBudgetSelection(manyEligible, undefined).length === selectBatch(manyEligible, undefined).length);

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
