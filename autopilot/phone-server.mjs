#!/usr/bin/env node
// @ts-check
// phone-server.mjs — the "apply from my phone" page (design/daily-task-design.md §13).
//
// A deliberately tiny, zero-dependency server, separate from the dashboard. The dashboard's /api
// routes spawn scripts and are gated to localhost on purpose; opening that gate for the phone would
// expose all of them. This serves only:
//
//   GET  /            today's READY / CHECK jobs (mobile page): Apply, CV, "I applied", "Skip"
//   GET  /cv/<n>      that job's tailored CV (PDF) — n is a report number, digits only
//   POST /act         { report, action: "applied" | "skip" } → the tracker
//
// It never submits anything: "I applied" records that YOU applied. The tracker is written only via
// set-status.mjs (the canonical path; it seeds the follow-up on Applied) or, for a job with no tracker
// row yet, a tracker-additions TSV + merge-tracker.mjs.
//
// Access: a secret token (AUTOPILOT_PHONE_TOKEN in .env) in a cookie, same-origin POSTs only, and by
// default it listens on 127.0.0.1 — reach it from the phone by binding to your Tailscale address
// (AUTOPILOT_PHONE_HOST=100.x.y.z) so only your own devices can connect. Never expose it publicly.
//
//   node autopilot/phone-server.mjs              # serve (token + host from .env)
//   node autopilot/phone-server.mjs --print-link # the URL to open on the phone, token included
//   node autopilot/phone-server.mjs --self-test

import http from 'node:http';
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, createReadStream, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { getCareerOpsRoot, resolveTrackerPath } from '../path-resolver.mjs';
import { flagValue, hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { parseTrackerRows } from '../find.mjs';
import { findBundleCv, cvAttachmentName, safeHttpUrl } from './apply-kit.mjs';
import { buildTrackerTsv } from './prepare-new.mjs';
import { renderRunPage, loadScanStatus, listRunDates } from './run-report.mjs';
import { parseOpenTodos } from './notify-mail.mjs';

const ROOT = getCareerOpsRoot();
const DONE_STATUSES = new Set(['applied', 'responded', 'interview', 'offer', 'hired', 'rejected', 'skip', 'discarded']);
const RECENT_DAYS = 14;
const COOKIE = 'ap_phone';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return fb; } };

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * Jobs worth showing: prepared bundles that are READY/CHECK, or already carry a CV, and aren't BLOCKED;
 * updated in the last RECENT_DAYS days, or still open. Tracker status decides open vs done.
 */
export function loadJobs(root = ROOT, now = Date.now()) {
  const out = join(root, 'output');
  if (!existsSync(out)) return [];
  const trackerPath = resolveTrackerPath(root);
  const tracker = existsSync(trackerPath) ? parseTrackerRows(readFileSync(trackerPath, 'utf-8')) : [];
  const statusByReport = new Map(tracker.filter((t) => t.reportNum != null).map((t) => [Number(t.reportNum), String(t.status).toLowerCase()]));

  const jobs = [];
  for (const d of readdirSync(out, { withFileTypes: true })) {
    if (!d.isDirectory() || !/^\d{3,}-/.test(d.name)) continue;
    const state = readJson(join(out, d.name, 'state.json'), null);
    if (!state || state.gate === 'blocked' || state.label === 'BLOCKED') continue;
    const hasCv = Object.keys(state.stages ?? {}).some((k) => k.startsWith('cv:'));
    if (!(state.label === 'READY' || state.label === 'CHECK' || hasCv)) continue;
    const num = Number(state.report_num);
    const status = statusByReport.get(num) ?? '';
    const done = DONE_STATUSES.has(status);
    const ageDays = (now - Date.parse(state.updated_at ?? 0)) / 86_400_000;
    if (done && ageDays > RECENT_DAYS) continue;
    const cv = findBundleCv(`output/${d.name}`, root);
    jobs.push({
      num, company: state.company || '(unknown)', title: state.role || '', label: state.label ?? (hasCv ? 'READY' : 'CHECK'),
      score: state.score ?? null, reason: state.triage_reason ?? '', reasons: state.reasons ?? [], url: safeHttpUrl(state.url),
      location: state.location ?? '', hasCv: Boolean(cv), cvPath: cv, status, done, bundle: `output/${d.name}`, state,
    });
  }
  return jobs.sort((a, b) => Number(a.done) - Number(b.done) || (Number(b.score) || 0) - (Number(a.score) || 0));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function renderPage(jobs) {
  const open = jobs.filter((j) => !j.done), done = jobs.filter((j) => j.done);
  const color = { READY: '#1a7f37', CHECK: '#9a6700' };
  const card = (j) => `<section class="card" data-num="${j.num}" style="border-left-color:${color[j.label] ?? '#8c959f'}">
<div class="meta">${esc(j.label)}${j.score != null ? ` · ${esc(Number(j.score).toFixed(1))}/5` : ''}${j.location ? ` · ${esc(j.location)}` : ''}</div>
<h2>${esc(j.company)} — ${esc(j.title)}</h2>
${j.reason ? `<p>${esc(j.reason)}</p>` : ''}${j.reasons.map((r) => `<p class="warn">⚠ ${esc(r)}</p>`).join('')}
<div class="row">
${j.hasCv ? `<a class="btn ghost" href="/cv/${j.num}">📄 CV (PDF)</a>` : '<span class="muted">No CV yet</span>'}
${j.url ? `<a class="btn primary" href="${esc(j.url)}" target="_blank" rel="noopener noreferrer">Apply ›</a>` : ''}
</div>
${j.done ? `<p class="muted">Status: ${esc(j.status)}</p>` : `<div class="row">
<button class="btn ok" data-act="applied">✔ I applied</button><button class="btn ghost" data-act="skip">Skip</button></div>`}
</section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Today's applications</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--mut:#57606a;--line:#d0d7de;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--line:#30363d;--card:#161b22}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif;max-width:640px;margin-inline:auto}
h1{font-size:22px;margin:4px 0 12px}h2{font-size:18px;margin:2px 0}p{margin:6px 0;font-size:14px}.muted{color:var(--mut);font-size:13px}.warn{color:#9a6700}
.card{background:var(--card);border:1px solid var(--line);border-left:6px solid;border-radius:10px;padding:12px 14px;margin:14px 0}
.meta{font-size:12px;font-weight:700;color:var(--mut)}.row{display:flex;gap:8px;margin:10px 0 0;flex-wrap:wrap}
.btn{flex:1;min-width:120px;text-align:center;padding:13px 10px;border-radius:10px;border:1px solid var(--line);font-size:16px;font-weight:700;text-decoration:none;background:transparent;color:var(--fg)}
.primary{background:#0969da;border-color:#0969da;color:#fff}.ok{background:#1a7f37;border-color:#1a7f37;color:#fff}.btn:disabled{opacity:.5}
</style></head><body>
<h1>Today's applications</h1><p class="muted">${open.length} open · you click Submit on the company's form; these buttons only record it.</p>
${open.map(card).join('') || '<p>Nothing open. 🎉</p>'}
${done.length ? `<h1>Done</h1>${done.map(card).join('')}` : ''}
<script>
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const sec = b.closest('.card'), act = b.dataset.act;
  if (act === 'skip' && !confirm('Skip this job?')) return;
  sec.querySelectorAll('button').forEach((x) => (x.disabled = true));
  try {
    const r = await fetch('/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'phone' }, body: JSON.stringify({ report: Number(sec.dataset.num), action: act }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    sec.style.opacity = .45; sec.querySelector('.row:last-child').innerHTML = '<span class="muted">Recorded: ' + j.status + '</span>';
  } catch (err) { alert('Failed: ' + err.message); sec.querySelectorAll('button').forEach((x) => (x.disabled = false)); }
});
</script></body></html>`;
}

// ---------------------------------------------------------------------------
// Auth + routing (pure: no sockets, so it is unit-testable)
// ---------------------------------------------------------------------------

export function tokenOk(given, expected) {
  if (!expected || !given) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** A state-changing request must come from this page: same origin, and our marker header. */
export function sameOriginPost(headers) {
  if (headers['x-requested-with'] !== 'phone') return false;
  const origin = headers.origin;
  if (!origin) return true; // fetch() from the page always sends it; non-browser tools are still token-gated
  try { return new URL(origin).host === headers.host; } catch { return false; }
}

const json = (status, body, extra = {}) => ({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }, body: JSON.stringify(body) });
const html = (status, body, extra = {}) => ({ status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra }, body });

/**
 * @param {{ method: string, url: string, headers: Record<string,string>, body?: string }} req
 * @param {{ token: string, root?: string, run?: (cmd: string, args: string[]) => Promise<{code: number, out: string}>, today?: string }} ctx
 */
export async function route(req, ctx) {
  const root = ctx.root ?? ROOT;
  const u = new URL(req.url, 'http://x');
  const cookies = parseCookies(req.headers.cookie);

  // First visit from the email link: ?t=TOKEN → cookie, then a clean URL (token out of history).
  const qt = u.searchParams.get('t');
  if (req.method === 'GET' && qt !== null) {
    if (!tokenOk(qt, ctx.token)) return json(401, { error: 'unauthorized' });
    return { status: 302, headers: { location: u.pathname, 'set-cookie': `${COOKIE}=${encodeURIComponent(qt)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`, 'cache-control': 'no-store' }, body: '' };
  }
  if (!tokenOk(cookies[COOKIE], ctx.token)) return json(401, { error: 'unauthorized — open the link from your email once' });

  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/today')) return html(200, renderPage(loadJobs(root)));

  // The daily run as a web page: /run = latest, /run/YYYY-MM-DD = that day.
  const runPage = u.pathname.match(/^\/run(?:\/(\d{4}-\d{2}-\d{2}))?\/?$/);
  if (req.method === 'GET' && runPage) {
    const dates = listRunDates(root);
    const date = runPage[1] ?? dates[0];
    const digest = date ? readJson(join(root, 'data', 'runs', `${date}.json`), null) : null;
    if (!digest) return json(404, { error: 'no run report for that date' });
    const todoFile = join(root, 'data', 'todo.md');
    const todos = existsSync(todoFile) ? parseOpenTodos(readFileSync(todoFile, 'utf-8')) : [];
    return html(200, renderRunPage(digest, loadScanStatus(digest, root), { runDates: dates, todos }));
  }

  const cv = u.pathname.match(/^\/cv\/(\d{1,6})$/);
  if (req.method === 'GET' && cv) {
    const job = loadJobs(root).find((j) => j.num === Number(cv[1]));
    if (!job || !job.cvPath) return json(404, { error: 'no CV for that job' });
    return { status: 200, file: job.cvPath, headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${cvAttachmentName(job.company)}"`, 'cache-control': 'no-store' }, body: '' };
  }

  if (req.method === 'POST' && u.pathname === '/act') {
    if (!sameOriginPost(req.headers)) return json(403, { error: 'cross-origin request refused' });
    let payload;
    try { payload = JSON.parse(req.body ?? ''); } catch { return json(400, { error: 'bad json' }); }
    const action = payload?.action;
    if (action !== 'applied' && action !== 'skip') return json(400, { error: 'action must be "applied" or "skip"' });
    const report = Number(payload?.report);
    const job = Number.isInteger(report) ? loadJobs(root).find((j) => j.num === report) : null;
    if (!job) return json(404, { error: 'unknown job' });
    return act(job, action, { root, run: ctx.run ?? runNodeScript, today: ctx.today ?? new Date().toISOString().slice(0, 10) });
  }
  return json(404, { error: 'not found' });
}

function runNodeScript(script, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, timeout: 30_000, env: { ...process.env, CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: '10000' } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}`.trim() });
    });
  });
}

/** Record the user's decision. An existing tracker row → set-status; none yet → TSV + merge. */
export async function act(job, action, { root, run, today }) {
  const status = action === 'applied' ? 'Applied' : 'SKIP';
  const note = action === 'applied' ? 'applied via phone' : 'skipped via phone';
  if (job.status) {
    const r = await run('set-status.mjs', ['--report', String(job.num), status, '--note', note, '--source', 'web']);
    return r.code === 0 ? json(200, { ok: true, status }) : json(r.code === 4 ? 503 : 500, { error: r.code === 4 ? 'tracker busy — try again in a moment' : `set-status failed (exit ${r.code})`, detail: r.out.slice(-300) });
  }
  // No tracker row yet (prepared before rows were created automatically): add it, already at its final status.
  const s = job.state;
  const dir = join(root, 'batch', 'tracker-additions');
  mkdirSync(dir, { recursive: true });
  const num = String(job.num).padStart(3, '0');
  writeFileSync(join(dir, `${num}-${String(job.company).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.tsv`), buildTrackerTsv({
    num, date: today, company: job.company, role: job.title, score: Number(s.score) || 0, report: s.report, note: `${note}; triage-only`, url: s.url, status,
  }));
  const m = await run('merge-tracker.mjs', []);
  if (m.code !== 0) return json(500, { error: `merge-tracker failed (exit ${m.code})`, detail: m.out.slice(-300) });
  if (action === 'applied') await run('set-status.mjs', ['--report', String(job.num), 'Applied', '--note', note, '--source', 'web']); // seeds the follow-up (no-op if already Applied)
  return json(200, { ok: true, status, created: true });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function startServer({ token, host = '127.0.0.1', port = 4317 }) {
  const server = http.createServer(async (req, res) => {
    try {
      const body = req.method === 'POST' ? await readBody(req) : '';
      const r = await route({ method: req.method ?? 'GET', url: req.url ?? '/', headers: /** @type {any} */ (req.headers), body }, { token });
      if (r.file && existsSync(r.file)) {
        res.writeHead(r.status, { ...r.headers, 'content-length': String(statSync(r.file).size) });
        createReadStream(r.file).on('error', () => res.destroy()).pipe(res);
      } else {
        res.writeHead(r.status, r.headers);
        res.end(r.body);
      }
    } catch {
      if (res.headersSent) { res.destroy(); return; } // never throw out of the handler: one bad request must not stop the server
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'server error' }));
    }
  });
  server.listen(port, host);
  return server;
}

// ---------------------------------------------------------------------------

async function selfTest() {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  let pass = 0, fail = 0;
  const check = (n, c) => { if (c) pass += 1; else { fail += 1; console.error(`FAIL: ${n}`); } };

  check('tokenOk matches', tokenOk('abc123', 'abc123') && !tokenOk('abc124', 'abc123') && !tokenOk('', 'abc') && !tokenOk('x', ''));
  check('parseCookies', parseCookies('a=1; ap_phone=tok%20en').ap_phone === 'tok en');
  check('same-origin POST needs the marker header', !sameOriginPost({ host: 'h:1' }) && sameOriginPost({ host: 'h:1', 'x-requested-with': 'phone' }));
  check('cross-origin POST refused', !sameOriginPost({ host: 'h:1', 'x-requested-with': 'phone', origin: 'http://evil.com' }) && sameOriginPost({ host: 'h:1', 'x-requested-with': 'phone', origin: 'http://h:1' }));

  // A throw-away repo root with two prepared bundles and a tracker.
  const root = mkdtempSync(join(tmpdir(), 'phone-'));
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |\n|---|------|---------|------|-------|--------|-----|--------|-------|-----|\n| 7 | 2026-09-30 | Acme | Backend Dev | 4.0/5 | Evaluated | ❌ | [201](../reports/201-acme-2026-09-30.md) | n | https://acme.com/j/1 |\n');
    const mk = (dir, state, cv = true) => {
      mkdirSync(join(root, 'output', dir, 'cv', 'tailored', 'v001'), { recursive: true });
      writeFileSync(join(root, 'output', dir, 'state.json'), JSON.stringify(state));
      if (cv) writeFileSync(join(root, 'output', dir, 'cv', 'tailored', 'v001', 'cv.pdf'), '%PDF-1.4 test');
    };
    const fresh = new Date().toISOString();
    mk('201-acme', { report_num: '201', company: 'Acme', role: 'Backend Dev', label: 'READY', score: 4.0, url: 'https://acme.com/j/1', stages: { jd: 'd', 'cv:v001': 'd' }, gate: 'gate-2', updated_at: fresh, triage_reason: 'fits <b>', reasons: [], report: 'reports/201-acme-2026-09-30.md' });
    mk('202-beta', { report_num: '202', company: 'Beta', role: 'Data Dev', label: 'CHECK', score: 3.5, url: 'javascript:evil()', stages: { jd: 'd' }, gate: 'gate-1', updated_at: fresh, reasons: ['JD asks 3+ years'], report: 'reports/202-beta-2026-09-30.md' }, false);
    mk('203-gone', { report_num: '203', company: 'Gone', role: 'X', label: 'BLOCKED', gate: 'blocked', stages: {}, updated_at: fresh }, false);
    mk('204-legacy', { report_num: '204', company: 'Legacy', role: 'Old job', score: 4.2, url: 'https://old.com/1', stages: { jd: 'd', 'cv:v001': 'd' }, gate: 'gate-2', updated_at: fresh, report: 'reports/204-legacy-2026-09-28.md' });

    const jobs = loadJobs(root);
    check('blocked bundles are never listed', !jobs.some((j) => j.company === 'Gone'));
    check('unlabeled bundle with a CV is listed (legacy)', jobs.some((j) => j.company === 'Legacy'));
    check('jobs sorted best score first', jobs[0].company === 'Legacy' && jobs[1].company === 'Acme');
    check('tracker status joins by report number', jobs.find((j) => j.company === 'Acme').status === 'evaluated');
    check('unsafe url is dropped', jobs.find((j) => j.company === 'Beta').url === null);

    const page = renderPage(jobs);
    check('page escapes text', page.includes('fits &lt;b&gt;') && !page.includes('fits <b>'));
    check('page has the two action buttons', page.includes('data-act="applied"') && page.includes('data-act="skip"'));
    check('page has no javascript: link', !page.includes('javascript:evil'));

    const calls = [];
    const run = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, out: '' }; };
    const ctx = { token: 'sekret', root, run, today: '2026-10-01' };
    const cookie = 'ap_phone=sekret';
    const good = { host: 'h:1', 'x-requested-with': 'phone', cookie, 'content-type': 'application/json' };

    check('no cookie → 401', (await route({ method: 'GET', url: '/', headers: {} }, ctx)).status === 401);
    check('wrong token in URL → 401', (await route({ method: 'GET', url: '/?t=nope', headers: {} }, ctx)).status === 401);
    const login = await route({ method: 'GET', url: '/?t=sekret', headers: {} }, ctx);
    check('right token → cookie + clean redirect', login.status === 302 && login.headers.location === '/' && /HttpOnly; SameSite=Strict/.test(login.headers['set-cookie']));
    const home = await route({ method: 'GET', url: '/', headers: { cookie } }, ctx);
    check('page served with the cookie', home.status === 200 && home.body.includes('Acme'));
    check('CV served', (await route({ method: 'GET', url: '/cv/201', headers: { cookie } }, ctx)).headers['content-type'] === 'application/pdf');
    check('CV for a job without one → 404', (await route({ method: 'GET', url: '/cv/202', headers: { cookie } }, ctx)).status === 404);
    check('CV path traversal is not a route', (await route({ method: 'GET', url: '/cv/..%2f..%2fcv.md', headers: { cookie } }, ctx)).status === 404);

    check('POST without marker header → 403', (await route({ method: 'POST', url: '/act', headers: { host: 'h:1', cookie }, body: '{}' }, ctx)).status === 403);
    check('POST with a bad action → 400', (await route({ method: 'POST', url: '/act', headers: good, body: JSON.stringify({ report: 201, action: 'submit' }) }, ctx)).status === 400);
    check('POST for an unknown job → 404', (await route({ method: 'POST', url: '/act', headers: good, body: JSON.stringify({ report: 999, action: 'applied' }) }, ctx)).status === 404);

    const ok = await route({ method: 'POST', url: '/act', headers: good, body: JSON.stringify({ report: 201, action: 'applied' }) }, ctx);
    check('applied on an existing row → set-status --report 201 Applied', ok.status === 200 && calls[0].join(' ') === 'set-status.mjs --report 201 Applied --note applied via phone --source web');
    calls.length = 0;
    const created = await route({ method: 'POST', url: '/act', headers: good, body: JSON.stringify({ report: 204, action: 'skip' }) }, ctx);
    const tsv = readdirSync(join(root, 'batch', 'tracker-additions'));
    check('no row yet → TSV at its final status + merge', created.status === 200 && tsv.length === 1 && readFileSync(join(root, 'batch', 'tracker-additions', tsv[0]), 'utf-8').split('\n')[1].split('\t')[4] === 'SKIP' && calls[0][0] === 'merge-tracker.mjs');
    const busy = await route({ method: 'POST', url: '/act', headers: good, body: JSON.stringify({ report: 201, action: 'applied' }) }, { ...ctx, run: async () => ({ code: 4, out: 'lock' }) });
    check('tracker lock → 503, not a crash', busy.status === 503);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`phone-server.mjs self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--self-test')) {
    process.exitCode = (await selfTest()) ? 0 : 1;
  } else {
    dotenv.config({ path: join(ROOT, '.env'), quiet: true });
    const token = process.env.AUTOPILOT_PHONE_TOKEN;
    const host = flagValue(args, '--host') ?? process.env.AUTOPILOT_PHONE_HOST ?? '127.0.0.1';
    const port = Number(flagValue(args, '--port') ?? process.env.AUTOPILOT_PHONE_PORT ?? 4317);
    if (!token || token.length < 16) {
      console.error('Set AUTOPILOT_PHONE_TOKEN in .env first (16+ random characters), e.g.:');
      console.error('  node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"');
      process.exitCode = 1;
    } else if (hasFlag(args, '--print-link')) {
      const shown = host === '0.0.0.0' || host === '127.0.0.1' ? '<your-tailscale-ip>' : host;
      console.log(`http://${shown}:${port}/?t=${token}`);
    } else {
      startServer({ token, host, port });
      console.log(`phone page on http://${host}:${port}/  (token-protected${host === '127.0.0.1' ? '; bound to localhost only — set AUTOPILOT_PHONE_HOST to your Tailscale IP for the phone' : ''})`);
    }
  }
}
