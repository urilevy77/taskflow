#!/usr/bin/env node
// @ts-check
// publish-site.mjs — turns the run reports into a static site and uploads it to Cloudflare Pages, so the
// phone can open it anytime (PC on or off). Called by daily.mjs after each run; also runnable by hand.
//
//   data/site/index.html            latest run
//   data/site/run/<date>.html       every run (Pages serves it at /run/<date>)
//
// Scan status is snapshotted per run (data/runs/scan-status-<date>.json) the first time a run is published,
// because scan-sources.json only holds the latest sweep — older pages keep the numbers they had.
//
// Config (.env):
//   AUTOPILOT_SITE_PROJECT   Cloudflare Pages project name (e.g. uri-autopilot → https://uri-autopilot.pages.dev)
//   AUTOPILOT_SITE_URL       public URL used in the email (default https://<project>.pages.dev)
//   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID   optional — otherwise uses `npx wrangler login`'s saved login
// Protect the site with Cloudflare Access (Zero Trust → Access → Applications → <project>.pages.dev).
// Unset project → builds locally, skips the upload with a one-line note, never an error.
//
//   node autopilot/publish-site.mjs              # build + upload
//   node autopilot/publish-site.mjs --build-only # build data/site only
//   node autopilot/publish-site.mjs --self-test

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { renderRunPage, loadScanStatus, listRunDates } from './run-report.mjs';
import { parseOpenTodos } from './notify-mail.mjs';

const ROOT = getCareerOpsRoot();
const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return fb; } };

export const SITE_HEADERS = `/*
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-store
  Referrer-Policy: no-referrer
`;

/** Scan status for a run: the saved snapshot, else computed now (and saved when `save`). */
export function scanStatusFor(digest, date, root = ROOT, save = false) {
  const f = join(root, 'data', 'runs', `scan-status-${date}.json`);
  const snap = readJson(f, null);
  if (snap) return snap;
  const scan = loadScanStatus(digest, root);
  if (save) writeFileSync(f, JSON.stringify(scan, null, 2));
  return scan;
}

/** Builds data/site/. Returns { dir, pages }. */
export function buildSite(root = ROOT) {
  const dir = join(root, 'data', 'site');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'run'), { recursive: true });
  const dates = listRunDates(root);
  const todoFile = join(root, 'data', 'todo.md');
  const todos = existsSync(todoFile) ? parseOpenTodos(readFileSync(todoFile, 'utf-8')) : [];
  let pages = 0;
  dates.forEach((date, i) => {
    const digest = readJson(join(root, 'data', 'runs', `${date}.json`), null);
    if (!digest) return;
    const page = renderRunPage(digest, scanStatusFor(digest, date, root, i === 0), { runDates: dates, todos: i === 0 ? todos : [], jobsLink: false });
    writeFileSync(join(dir, 'run', `${date}.html`), page);
    if (i === 0) writeFileSync(join(dir, 'index.html'), page);
    pages += 1;
  });
  writeFileSync(join(dir, '_headers'), SITE_HEADERS);
  writeFileSync(join(dir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  return { dir, pages };
}

/** Public base URL of the site, or '' when not configured. */
export function siteUrl(env = process.env) {
  if (env.AUTOPILOT_SITE_URL) return env.AUTOPILOT_SITE_URL.replace(/\/$/, '');
  return env.AUTOPILOT_SITE_PROJECT ? `https://${env.AUTOPILOT_SITE_PROJECT}.pages.dev` : '';
}

function deploy(dir, project) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['--yes', 'wrangler@4', 'pages', 'deploy', dir, '--project-name', project, '--branch', 'main', '--commit-dirty=true'],
      { cwd: ROOT, shell: process.platform === 'win32', env: process.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', (err) => resolve({ code: 1, out: String(err) }));
  });
}

/** Build + upload. Returns a short status line; never throws. */
export async function publishSite() {
  dotenv.config({ path: join(ROOT, '.env'), quiet: true });
  try {
    const { dir, pages } = buildSite();
    const project = process.env.AUTOPILOT_SITE_PROJECT;
    if (!project) return `site built (${pages} page(s)), upload skipped — AUTOPILOT_SITE_PROJECT not set in .env`;
    const { code, out } = await deploy(dir, project);
    if (code !== 0) return `site upload FAILED: ${out.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300)}`;
    return `site published: ${siteUrl()} (${pages} run page(s))`;
  } catch (err) {
    return `site publish FAILED: ${String(err?.message ?? err).slice(0, 200)}`;
  }
}

function selfTest() {
  let failures = 0;
  const check = (n, c) => { if (!c) { console.error(`FAIL: ${n}`); failures += 1; } else console.log(`ok: ${n}`); };
  check('siteUrl from project', siteUrl({ AUTOPILOT_SITE_PROJECT: 'uri-ap' }) === 'https://uri-ap.pages.dev');
  check('siteUrl override wins, trailing slash dropped', siteUrl({ AUTOPILOT_SITE_PROJECT: 'x', AUTOPILOT_SITE_URL: 'https://jobs.example/' }) === 'https://jobs.example');
  check('siteUrl empty when unset', siteUrl({}) === '');
  check('headers keep it out of search + caches', SITE_HEADERS.includes('noindex') && SITE_HEADERS.includes('no-store'));
  if (failures) process.exitCode = 1; else console.log('\nAll self-tests passed.');
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) selfTest();
  else if (argv.includes('--build-only')) { const r = buildSite(); console.log(`built ${r.pages} page(s) in ${r.dir}`); }
  else console.log(await publishSite());
}
