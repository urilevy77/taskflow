#!/usr/bin/env node
// @ts-check
// scan-all.mjs — one entry point for the WHOLE intake, not just the ATS boards.
//
// WHY THIS EXISTS: `scan.mjs` merges *provider*-hook plugins only, so an
// `ingest`-hook source (WhatsApp, Gmail) is invisible to it no matter how
// enabled it is in config/plugins.yml. That split is correct internally —
// providers are pulled synchronously per board, ingest queues drain on their
// own clock — but it means "did I scan everything?" has no single answer.
// This wraps both halves so it does.
//
// Order matters: ingest queues drain FIRST, so their leads are already in
// data/pipeline.md when scan.mjs takes the pipeline lock and dedups. Reversing
// it would still work (the engine dedups either way) but would split one
// logical intake across two lock acquisitions for no reason.
//
//   node scan-all.mjs                  — WhatsApp backfill (since last scan, max 4d) + drain, then scan
//   node scan-all.mjs --days=2         — fixed WhatsApp window (still capped at 4d)
//   node scan-all.mjs --no-whatsapp    — boards only (same as plain scan.mjs)
//   node scan-all.mjs --no-scan        — ingest only, skip the board sweep
//   node scan-all.mjs --live           — skip backfill; assumes a watcher is running
//
// Any other flag is passed through to scan.mjs untouched (--resume, --limit, …).
//
// A failing step is REPORTED, never fatal: WhatsApp Web breaks on its own
// schedule (session expiry, pinned-version drift) and that must not cost you
// the board sweep, which is the zero-token half that always works.

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';

const ROOT = process.cwd();
const PLUGINS_CONFIG = path.join(ROOT, 'config', 'plugins.yml');
const WHATSAPP_WATCH = path.join(ROOT, 'plugins.local', 'whatsapp', 'watch.mjs');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flagValue = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const OWN_FLAGS = ['--no-whatsapp', '--no-scan', '--live'];
// Everything we don't consume ourselves belongs to scan.mjs.
const passThrough = argv.filter(
  (a) => !OWN_FLAGS.includes(a) && !a.startsWith('--days='),
);

// No --days → the watcher resumes from its last completed scan (max 4 days back).
// An explicit --days is still honoured, but the watcher caps it at 4.
const days = flagValue('days', 'auto');
const runWhatsapp = !has('--no-whatsapp');
const runScan = !has('--no-scan');
const backfill = !has('--live');

// A hung WhatsApp session (getChats never answering) used to hold the whole run: the daily task's 40-minute
// scan ceiling expired inside this step and the job boards — which cost nothing — never got scanned (09-29,
// and again 09-30). The backfill gets a hard limit; past it the step is skipped and the boards still run.
const WHATSAPP_BACKFILL_TIMEOUT_MS = 10 * 60_000;

/** Run a child to completion. Resolves with its exit code (124 = timed out); never rejects. */
function run(label, args, timeoutMs = 0) {
  return new Promise((resolve) => {
    console.log(`\n━━ ${label} ━━`);
    const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
    let timer;
    let timedOut = false;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        console.error(`⚠️  ${label}: no result after ${Math.round(timeoutMs / 60_000)} min — stopping it so the rest of the run can go ahead`);
        // The watcher drives a headless browser; on Windows /T takes its whole process tree down with it.
        if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      }, timeoutMs);
    }
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve(timedOut ? 124 : (code ?? 1));
    });
    child.on('error', (err) => {
      console.error(`⚠️  ${label}: could not start — ${err.message}`);
      resolve(1);
    });
  });
}

/** Enabled ingest-hook plugin ids, read from the user's own plugins.yml. */
function enabledIngestPlugins() {
  if (!existsSync(PLUGINS_CONFIG)) return [];
  try {
    const cfg = /** @type {any} */ (yaml.load(readFileSync(PLUGINS_CONFIG, 'utf-8')));
    return Object.entries(cfg?.plugins ?? {})
      .filter(([, v]) => /** @type {any} */ (v)?.enabled === true)
      .map(([id]) => id);
  } catch (err) {
    console.error(`⚠️  could not read ${PLUGINS_CONFIG}: ${/** @type {Error} */ (err).message}`);
    return [];
  }
}

const results = [];

if (runWhatsapp) {
  if (!enabledIngestPlugins().includes('whatsapp')) {
    console.log('\n━━ WhatsApp ━━\nskipped — not enabled in config/plugins.yml');
  } else if (!existsSync(WHATSAPP_WATCH)) {
    console.log(`\n━━ WhatsApp ━━\nskipped — ${WHATSAPP_WATCH} not found`);
  } else {
    if (backfill) {
      const code = await run(
        days === 'auto' ? 'WhatsApp backfill (since last scan, max 4d)' : `WhatsApp backfill (last ${days}d, max 4d)`,
        [WHATSAPP_WATCH, `--backfill=${days}`],
        WHATSAPP_BACKFILL_TIMEOUT_MS,
      );
      results.push(['whatsapp backfill', code]);
      if (code !== 0) {
        console.error(
          '⚠️  backfill failed — the session may have expired. Re-pair with:\n' +
          '    node plugins.local/whatsapp/watch.mjs\n' +
          '    (scan the QR from WhatsApp > Settings > Linked Devices)',
        );
      }
    }
    // Drain regardless: a failed backfill can still leave earlier leads queued.
    const code = await run('WhatsApp → pipeline', [path.join(ROOT, 'plugins.mjs'), 'run', 'whatsapp']);
    results.push(['whatsapp drain', code]);
  }
}

if (runScan) {
  const code = await run('Portal scan', [path.join(ROOT, 'scan.mjs'), ...passThrough]);
  results.push(['portal scan', code]);
}

console.log('\n━━ scan-all summary ━━');
for (const [label, code] of results) {
  console.log(`  ${code === 0 ? '✓' : '✗'} ${label}${code === 0 ? '' : ` (exit ${code})`}`);
}
console.log('\nNext: node stats.mjs --summary  ·  then triage / pipeline mode.');

// Exit non-zero only if EVERY step failed — a partial intake is still an intake.
process.exit(results.length && results.every(([, c]) => c !== 0) ? 1 : 0);
