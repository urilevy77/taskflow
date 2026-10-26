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

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import { getCareerOpsRoot, resolveTrackerPath } from '../path-resolver.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { renderRunPage, loadScanStatus, listRunDates } from './run-report.mjs';
import { parseOpenTodos } from './notify-mail.mjs';
import { loadJobs } from './phone-server.mjs';
import { sourceIndex, describeSource, originIndex } from './job-origin.mjs';
import { readTracker, pickCv, renderHome, renderApply, renderJobs, renderJob, renderRuns, readFiltered, renderFiltered, renderFollowups } from './site-pages.mjs';
import { loadDue } from './followups.mjs';
import { syncConfig, pagesToml, ROUTES_JSON } from './sync-config.mjs';

const ROOT = getCareerOpsRoot();
const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return fb; } };

// The pages show text from job postings and WhatsApp groups: the CSP allows only the site's own files and
// its inline script/style — no outside scripts, no network calls from the page.
export const SITE_HEADERS = `/*
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-store
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
`;

/** The headers, with the page allowed to call its own /api/marks when the sync worker ships (otherwise no network calls at all). */
export const siteHeaders = (sync = false) => (sync ? SITE_HEADERS.replace("connect-src 'none'", "connect-src 'self'") : SITE_HEADERS);

/** Scan status for a run: the saved snapshot, else computed now (and saved when `save`). */
export function scanStatusFor(digest, date, root = ROOT, save = false) {
  const f = join(root, 'data', 'runs', `scan-status-${date}.json`);
  const snap = readJson(f, null);
  if (snap) return snap;
  const scan = loadScanStatus(digest, root);
  if (save) writeFileSync(f, JSON.stringify(scan, null, 2));
  return scan;
}

const FONTS = ['inter/Inter-Latin-Variable.woff2', 'instrument-serif/InstrumentSerif-Latin-Regular.woff2', 'instrument-serif/InstrumentSerif-Latin-Italic.woff2'];

/**
 * Builds data/site/: / (dashboard), /apply, /jobs, /job/<#>, /runs, /run/<date>, the CVs the pages offer
 * (cv/job/<report#>.pdf, cv/role/<Role>.pdf) and the web UI's fonts. Returns { dir, pages, runs, cvs }.
 * `sync` also ships the worker that stores taps made on the pages (site-worker.mjs -> _worker.js, routed for /api/* only).
 */
export function buildSite(root = ROOT, { sync = false } = {}) {
  const dir = join(root, 'data', 'site');
  // Clear the contents, not the directory itself: under OneDrive data/site can be a
  // reparse-point placeholder that rmSync cannot remove (EPERM).
  mkdirSync(dir, { recursive: true });
  for (const e of readdirSync(dir)) rmSync(join(dir, e), { recursive: true, force: true });
  for (const d of ['run', 'job', 'cv/job', 'cv/role', 'fonts']) mkdirSync(join(dir, d), { recursive: true });
  const write = (rel, html) => writeFileSync(join(dir, rel), html);

  const todoFile = join(root, 'data', 'todo.md');
  const todos = existsSync(todoFile) ? parseOpenTodos(readFileSync(todoFile, 'utf-8')) : [];
  const trackerFile = resolveTrackerPath(root);
  const rows = existsSync(trackerFile) ? readTracker(readFileSync(trackerFile, 'utf-8')) : [];
  const rowByReport = new Map(rows.filter((r) => r.reportNum != null).map((r) => [r.reportNum, r]));

  // CVs: copied once each, only the ones a page links to.
  const copied = new Set();
  const cvFor = (args) => {
    const cv = pickCv(args, root);
    if (cv && !copied.has(cv.href)) { copyFileSync(cv.src, join(dir, decodeURIComponent(cv.href.slice(1)))); copied.add(cv.href); }
    return cv;
  };

  const jobs = loadJobs(root).map((j) => ({ ...j, gaps: j.state?.gaps ?? [], trackerNum: rowByReport.get(j.num)?.num ?? null, cv: cvFor({ reportNum: j.num, title: j.title, bundle: j.bundle }) }));
  const jobByReport = new Map(jobs.map((j) => [j.num, j]));
  const applyCount = jobs.filter((j) => !j.done).length;

  const dates = listRunDates(root);
  const runs = [];
  dates.forEach((date, i) => {
    const digest = readJson(join(root, 'data', 'runs', `${date}.json`), null);
    if (!digest) return;
    const scan = scanStatusFor(digest, date, root, i === 0);
    write(join('run', `${date}.html`), renderRunPage(digest, scan, { runDates: dates, todos: i === 0 ? todos : [], jobsLink: i === 0, applyCount }));
    const failed = (digest.stages ?? []).filter((s) => !s.ok).map((s) => String(s.name));
    runs.push({ date, ok: !failed.length, failed, found: scan.totals?.found, added: scan.totals?.new_added });
  });

  const followups = loadDue(root, { cap: 40 });
  write('index.html', renderHome({ rows, jobs, latest: runs[0] ?? null, todos, followups }));
  write('followups.html', renderFollowups(followups, applyCount));
  write('apply.html', renderApply(jobs));
  const originOf = originIndex(root);
  write('jobs.html', renderJobs(rows, applyCount, originOf));
  const pipelineFile = join(root, 'data', 'pipeline.md');
  write('filtered.html', renderFiltered(existsSync(pipelineFile) ? readFiltered(readFileSync(pipelineFile, 'utf-8')) : [], applyCount, rows, originOf));
  write('runs.html', renderRuns(runs, applyCount));
  const sourceOf = sourceIndex(root);
  for (const row of rows) {
    const source = row.url ? describeSource(sourceOf(row.url)) : '';
    const reportFile = row.reportPath && /^reports\/[\w.-]+\.md$/.test(row.reportPath) ? join(root, row.reportPath) : null;
    const reportMd = reportFile && existsSync(reportFile) ? readFileSync(reportFile, 'utf-8') : '';
    write(join('job', `${row.num}.html`), renderJob(row, { cv: cvFor({ reportNum: row.reportNum, title: row.role }), job: jobByReport.get(row.reportNum) ?? null, reportMd, applyCount, source }));
  }

  for (const f of FONTS) {
    const src = join(root, 'web', 'src', 'assets', 'fonts', f);
    if (existsSync(src)) copyFileSync(src, join(dir, 'fonts', basename(f)));
  }
  write('_headers', siteHeaders(sync));
  if (sync) {
    copyFileSync(fileURLToPath(new URL('./site-worker.mjs', import.meta.url)), join(dir, '_worker.js'));
    write('_routes.json', ROUTES_JSON);
  }
  write('robots.txt', 'User-agent: *\nDisallow: /\n');
  return { dir, pages: runs.length, runs: runs.length, jobs: rows.length, cvs: copied.size };
}

/** Public base URL of the site, or '' when not configured. */
export function siteUrl(env = process.env) {
  if (env.AUTOPILOT_SITE_URL) return env.AUTOPILOT_SITE_URL.replace(/\/$/, '');
  return env.AUTOPILOT_SITE_PROJECT ? `https://${env.AUTOPILOT_SITE_PROJECT}.pages.dev` : '';
}

/** Pure: does this unauthenticated response come from Cloudflare Access (i.e. the site is behind a login)? */
export function isAccessResponse(status, location) {
  return status >= 300 && status < 400 && /\.cloudflareaccess\.com\//i.test(String(location ?? ''));
}

/** Asks the live site, logged out. true = protected by Access; false = open (or unreachable). */
export async function siteIsProtected(url) {
  try {
    const res = await fetch(`${url}/`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    return isAccessResponse(res.status, res.headers.get('location'));
  } catch { return false; }
}

/** Pages project names: lowercase letters, digits, dashes. Also keeps .env input out of the shell line below. */
export const validProject = (p) => /^[a-z0-9][a-z0-9-]{0,57}$/.test(String(p ?? ''));

export function wrangler(args, { cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    // One quoted command line (npx is a .cmd on Windows and needs a shell); every arg is ours or validated.
    const line = ['npx', '--yes', 'wrangler@4', ...args].map((a) => (/^[\w@.:=\\/-]+$/.test(a) ? a : `"${a}"`)).join(' ');
    const child = spawn(line, { cwd, shell: true, env: process.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', (err) => resolve({ code: 1, out: String(err) }));
  });
}

/** Setup checklist: which steps are done. Prints one line per step. */
export async function checkSetup() {
  dotenv.config({ path: join(ROOT, '.env'), quiet: true });
  const project = process.env.AUTOPILOT_SITE_PROJECT;
  const who = await wrangler(['whoami']);
  const loggedIn = who.code === 0 && !/not authenticated/i.test(who.out);
  const projects = loggedIn ? await wrangler(['pages', 'project', 'list']) : { code: 1, out: '' };
  const url = siteUrl();
  const rows = [
    ['Cloudflare login (npx wrangler login)', loggedIn || Boolean(process.env.CLOUDFLARE_API_TOKEN)],
    ['AUTOPILOT_SITE_PROJECT set in .env', Boolean(project)],
    ['Pages project exists', Boolean(project) && projects.code === 0 && projects.out.includes(project)],
    ['Cloudflare Access protects the site', Boolean(url) && await siteIsProtected(url)],
  ];
  for (const [name, ok] of rows) console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (url) console.log(`\nsite: ${url}`);
  return rows.every(([, ok]) => ok);
}

function deploy(dir, project, sync = null) {
  if (!sync) return wrangler(['pages', 'deploy', dir, '--project-name', project, '--branch', 'main', '--commit-dirty=true']);
  // The KV binding and the Access values live in a generated wrangler.toml next to the site, so the deploy
  // is reproducible and nothing has to be clicked together in the dashboard.
  const cfgDir = join(ROOT, 'data', 'pages-deploy');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'wrangler.toml'), pagesToml({ project, ...sync }));
  return wrangler(['pages', 'deploy', '--branch', 'main', '--commit-dirty=true'], { cwd: cfgDir });
}

/** Build + upload. Returns a short status line; never throws. */
export async function publishSite() {
  dotenv.config({ path: join(ROOT, '.env'), quiet: true });
  try {
    const sync = syncConfig();
    const { dir, pages } = buildSite(ROOT, { sync: Boolean(sync) });
    const project = process.env.AUTOPILOT_SITE_PROJECT;
    if (!project) return `site built (${pages} page(s)), upload skipped — AUTOPILOT_SITE_PROJECT not set in .env`;
    if (!validProject(project)) return `site upload skipped — AUTOPILOT_SITE_PROJECT must be lowercase letters, digits and dashes`;
    // The pages hold the job pipeline: never upload to a site anyone can open.
    if (!(await siteIsProtected(siteUrl()))) return `site upload REFUSED: ${siteUrl()} is not behind Cloudflare Access — add the Access application first (node autopilot/publish-site.mjs --check)`;
    const { code, out } = await deploy(dir, project, sync);
    if (code !== 0) return `site upload FAILED: ${out.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300)}`;
    // Every upload also gets its own preview address (<id>.<project>.pages.dev); an Access app on the bare
    // domain does not cover it. Say so loudly instead of reporting a clean publish.
    const preview = out.match(new RegExp(`https://[a-z0-9-]+\\.${project}\\.pages\\.dev`))?.[0];
    if (preview && !(await siteIsProtected(preview))) {
      return `site published: ${siteUrl()} — WARNING: preview address ${preview} is NOT protected; add *.${project}.pages.dev to the Access application`;
    }
    return `site published: ${siteUrl()} (${pages} run page(s)${sync ? ', phone taps sync on' : ''})`;
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
  check('Access login redirect = protected', isAccessResponse(302, 'https://uri.cloudflareaccess.com/cdn-cgi/access/login/x.pages.dev?kid=1'));
  check('open site = not protected', !isAccessResponse(200, null) && !isAccessResponse(302, 'https://x.pages.dev/run'));
  check('project name validation', validProject('uri-autopilot') && !validProject('a & del x') && !validProject('Upper') && !validProject(''));
  check('look-alike host is not Access', !isAccessResponse(302, 'https://cloudflareaccess.com.evil.io/'));
  check('CSP blocks outside scripts and network calls', /Content-Security-Policy: default-src 'self';.*connect-src 'none'/.test(SITE_HEADERS));
  check('CSP lets the page call only itself when sync ships', siteHeaders(true).includes("connect-src 'self'") && !siteHeaders(true).includes("connect-src 'none'") && siteHeaders(false) === SITE_HEADERS && siteHeaders(true).includes("default-src 'self'"));

  // A throw-away root: one tracker row, one prepared job with a tailored CV, one run.
  const tmp = mkdtempSync(join(tmpdir(), 'site-build-'));
  try {
    mkdirSync(join(tmp, 'data', 'runs'), { recursive: true });
    mkdirSync(join(tmp, 'reports'), { recursive: true });
    mkdirSync(join(tmp, 'output', '201-acme', 'cv', 'tailored', 'v001'), { recursive: true });
    writeFileSync(join(tmp, 'data', 'applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |\n|---|---|---|---|---|---|---|---|---|---|\n| 7 | 2026-10-01 | Acme | AI Engineer | 4.2/5 | Evaluated | ❌ | [201](../reports/201-acme-2026-10-01.md) | n | https://acme.com/j/1 |\n');
    writeFileSync(join(tmp, 'reports', '201-acme-2026-10-01.md'), '# R\n## Triage\nPASS\n');
    writeFileSync(join(tmp, 'output', '201-acme', 'state.json'), JSON.stringify({ report_num: '201', company: 'Acme', role: 'AI Engineer', label: 'READY', score: 4.2, url: 'https://acme.com/j/1', stages: { 'cv:v001': 'd' }, gate: 'gate-2', updated_at: new Date().toISOString() }));
    writeFileSync(join(tmp, 'output', '201-acme', 'cv', 'tailored', 'v001', 'cv.pdf'), '%PDF');
    writeFileSync(join(tmp, 'data', 'runs', '2026-10-06.json'), JSON.stringify({ run_id: 'r', started_at: '2026-10-06T10:00:00Z', finished_at: '2026-10-06T10:05:00Z', stages: [{ name: 'scan', ok: true, summary: 'ok', durationMs: 1 }] }));
    const r = buildSite(tmp);
    const has = (p) => existsSync(join(r.dir, p));
    check('site: dashboard, apply, jobs, runs, run/<date>, job/<#>', ['index.html', 'apply.html', 'jobs.html', 'runs.html', 'run/2026-10-06.html', 'job/7.html', '_headers', 'robots.txt'].every(has));
    check('site: the job’s tailored CV is published', has('cv/job/201.pdf') && readFileSync(join(r.dir, 'apply.html'), 'utf-8').includes('href="/cv/job/201.pdf"'));
    check('site: follow-up page is built; no worker without sync', has('followups.html') && !has('_worker.js') && !has('_routes.json') && readFileSync(join(r.dir, '_headers'), 'utf-8').includes("connect-src 'none'"));
    const rs = buildSite(tmp, { sync: true });
    check('site with sync: worker + /api/* only routes + relaxed CSP', existsSync(join(rs.dir, '_worker.js')) && readFileSync(join(rs.dir, '_worker.js'), 'utf-8').includes('/api/marks') && JSON.parse(readFileSync(join(rs.dir, '_routes.json'), 'utf-8')).include.join() === '/api/*' && readFileSync(join(rs.dir, '_headers'), 'utf-8').includes("connect-src 'self'"));
    check('site: job page carries the report', readFileSync(join(r.dir, 'job', '7.html'), 'utf-8').includes('<h4>Triage</h4>'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  if (failures) process.exitCode = 1; else console.log('\nAll self-tests passed.');
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) selfTest();
  else if (argv.includes('--check')) process.exitCode = (await checkSetup()) ? 0 : 1;
  else if (argv.includes('--build-only')) { const r = buildSite(); console.log(`built ${r.runs} run page(s), ${r.jobs} job page(s), ${r.cvs} CV(s) in ${r.dir}`); }
  else console.log(await publishSite());
}
