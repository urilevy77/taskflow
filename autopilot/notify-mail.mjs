#!/usr/bin/env node
// @ts-check
// notify-mail.mjs — emails the run digest when daily.mjs finishes.
//
// Config (.env, gitignored — see .env.example):
//   AUTOPILOT_MAIL_USER   Gmail address that sends (e.g. urilevy1999@gmail.com)
//   AUTOPILOT_MAIL_PASS   Gmail APP PASSWORD (not the account password):
//                         https://myaccount.google.com/apppasswords (needs 2-Step Verification)
//   AUTOPILOT_MAIL_TO     recipient (default: AUTOPILOT_MAIL_USER)
// Unset user/pass → the mail is skipped with a one-line note, never an error.
// This sends ONLY the run report to the user's own address; nothing else.
//
// Usage:
//   node autopilot/notify-mail.mjs --self-test
//   node autopilot/notify-mail.mjs --send-latest    # mail data/runs/{today}.json (tests SMTP setup)

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { buildApplyKit, summaryFromCv, sourcesTableHtml } from './apply-kit.mjs';

const ROOT = getCareerOpsRoot();

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Pure: markdown text of data/todo.md → open item lines (without the "- [ ] " prefix). */
export function parseOpenTodos(md) {
  const open = md.split(/^## Done/m)[0];
  return open.split(/\r?\n/).filter((l) => /^- \[ \] /.test(l)).map((l) => l.replace(/^- \[ \] /, '').trim());
}

function readOpenTodos() {
  try {
    const f = join(ROOT, 'data', 'todo.md');
    return existsSync(f) ? parseOpenTodos(readFileSync(f, 'utf-8')) : [];
  } catch { return []; }
}

/** Today's prepared records (prepare-new.mjs writes data/runs/prepared-{date}.json). */
export function readPreparedToday(date = new Date().toISOString().slice(0, 10)) {
  try {
    const f = join(ROOT, 'data', 'runs', `prepared-${date}.json`);
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf-8')).records ?? []) : [];
  } catch { return []; }
}

/** data/runs/sources.json rows (autopilot/sources.mjs), or []. */
export function readSources() {
  try {
    const f = join(ROOT, 'data', 'runs', 'sources.json');
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf-8')).rows ?? []) : [];
  } catch { return []; }
}

/** Pure: digest → { subject, text, html, attachments }. `kit` is buildApplyKit()'s result, or null; `sources` (Mondays) adds the funnel table. */
export function buildReport(digest, todos = [], kit = null, sources = [], opts = {}) {
  const stages = digest.stages ?? [];
  const failed = stages.filter((s) => !s.ok);
  const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const totalMs = new Date(digest.finished_at).getTime() - new Date(digest.started_at).getTime();
  const day = String(digest.started_at ?? '').slice(0, 10);
  const jobs = kit ? `${kit.counts.READY} READY · ${kit.counts.CHECK} CHECK · ` : '';
  const subject = failed.length
    ? `Autopilot ${day} — ${jobs}${failed.length} stage(s) FAILED (${failed.map((s) => s.name).join(', ')})`
    : `Autopilot ${day} — ${jobs}${stages.length}/${stages.length} stages ok`;

  const text = [
    ...(kit && kit.text ? [kit.text, '', '—'.repeat(20)] : []),
    `Run ${digest.run_id}`,
    `Started ${digest.started_at} — finished ${digest.finished_at} (${secs(totalMs)})`,
    `${stages.length - failed.length}/${stages.length} stages ok`,
    '',
    ...stages.map((s) => `${s.ok ? '✓' : '✗'} ${s.name} (${secs(s.durationMs)})\n    ${s.summary}`),
    ...(todos.length ? ['', `Open to-dos (${todos.length}):`, ...todos.map((t) => `  - ${t}`)] : []),
  ].join('\n');

  const rows = stages
    .map((s) => `<tr><td>${s.ok ? '✅' : '❌'}</td><td><b>${esc(s.name)}</b></td><td>${secs(s.durationMs)}</td><td>${esc(s.summary)}${s.detail ? `<pre style="white-space:pre-wrap;font-size:11px;background:#f6f8fa;padding:6px">${esc(s.detail)}</pre>` : ''}</td></tr>`)
    .join('');
  const html = `<div style="font-family:sans-serif;max-width:640px"><h2>${esc(subject)}</h2>${kit ? kit.html : ''}<h3>Run details</h3>
<p>Run <code>${esc(digest.run_id)}</code><br>${esc(digest.started_at)} → ${esc(digest.finished_at)} (${secs(totalMs)})</p>
<table cellpadding="6" style="border-collapse:collapse;border:1px solid #ccc">${rows}</table>${todos.length ? `<h3>Open to-dos (${todos.length})</h3><ul>${todos.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>`;
  if (opts.reportUrl) return buildCompactReport({ subject, stages, failed, totalMs, kit, scan: opts.scan, reportUrl: opts.reportUrl, todos });
  const closing = '</div>';
  const withSources = sources && sources.length && html.endsWith(closing) ? `${html.slice(0, -closing.length)}${sourcesTableHtml(sources)}${closing}` : html;
  return { subject, text, html: withSources, attachments: kit ? kit.attachments : [] };
}

/** Compact email: headline, the numbers that matter, and a button to the full web report. */
function buildCompactReport({ subject, stages, failed, totalMs, kit, scan, reportUrl, todos }) {
  const mins = `${(totalMs / 60000).toFixed(1)} min`;
  const t = scan?.totals;
  const bad = scan ? scan.boards.filter((b) => b.status !== 'reachable' && b.status !== 'empty').length : 0;
  const lines = [
    `${stages.length - failed.length}/${stages.length} stages ok in ${mins}`,
    ...(t ? [`Scan: ${t.found} jobs found · ${t.new_added} new · ${t.dupes} duplicates · ${t.errors} errors`] : []),
    ...(scan ? [`Sources: ${scan.boards.length} scanned, ${bad} with problems`] : []),
    ...(kit ? [`Ready to apply: ${kit.counts.READY} READY · ${kit.counts.CHECK} CHECK`] : []),
    ...failed.map((s) => `FAILED: ${s.name} — ${s.summary}`),
  ];
  const btn = 'display:inline-block;background:#0969da;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600';
  const html = `<div style="font-family:sans-serif;max-width:560px"><h2>${esc(subject)}</h2>
<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
<p><a href="${esc(reportUrl)}" style="${btn}">Open the full run report</a></p>
<p style="color:#57606a;font-size:12px">Per-source scan status, stages, WhatsApp groups and your to-do list are on the page.${todos.length ? ` ${todos.length} open to-dos.` : ''}</p></div>`;
  return { subject, text: `${lines.join('\n')}\n\nFull report: ${reportUrl}`, html, attachments: kit ? kit.attachments : [] };
}

/** Sends the report. Returns a short status string; never throws. */
export async function sendRunReport(digest) {
  dotenv.config({ path: join(ROOT, '.env'), quiet: true });
  const user = process.env.AUTOPILOT_MAIL_USER;
  const pass = (process.env.AUTOPILOT_MAIL_PASS ?? '').replace(/\s+/g, ''); // Google displays app passwords as "xxxx xxxx xxxx xxxx"
  if (!user || !pass) return 'mail skipped (AUTOPILOT_MAIL_USER / AUTOPILOT_MAIL_PASS not set in .env)';
  const to = process.env.AUTOPILOT_MAIL_TO || user;
  try {
    const { default: nodemailer } = await import('nodemailer');
    const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
    const kit = buildApplyKit(readPreparedToday(String(digest.started_at ?? '').slice(0, 10) || undefined), {
      // AUTOPILOT_PHONE_URL = where the phone reaches autopilot/phone-server.mjs (e.g. http://100.x.y.z:4317);
      // the token in the link logs the phone in once (cookie), so the page itself needs no password.
      phoneUrl: process.env.AUTOPILOT_PHONE_URL && process.env.AUTOPILOT_PHONE_TOKEN
        ? `${process.env.AUTOPILOT_PHONE_URL.replace(/\/$/, '')}/?t=${encodeURIComponent(process.env.AUTOPILOT_PHONE_TOKEN)}`
        : '',
      cvSummary: summaryFromCv(existsSync(join(ROOT, 'cv.md')) ? readFileSync(join(ROOT, 'cv.md'), 'utf-8') : ''),
    });
    const isMonday = new Date(digest.started_at ?? Date.now()).getDay() === 1; // weekly, per design §12
    const day = String(digest.started_at ?? '').slice(0, 10);
    // The public site (publish-site.mjs, behind Cloudflare Access) — no token in the link.
    const { siteUrl, scanStatusFor } = await import('./publish-site.mjs');
    const base = siteUrl();
    const reportUrl = base ? `${base}/run/${day}` : '';
    const { subject, text, html, attachments } = buildReport(digest, readOpenTodos(), kit, isMonday ? readSources() : [], { reportUrl, scan: reportUrl ? scanStatusFor(digest, day) : undefined });
    await transport.sendMail({ from: user, to, subject, text, html, attachments });
    return `mail sent to ${to}`;
  } catch (err) {
    return `mail FAILED: ${String(err?.message ?? err).slice(0, 200)}`;
  }
}

function selfTest() {
  let failures = 0;
  const check = (n, c) => { if (!c) { console.error(`FAIL: ${n}`); failures += 1; } else console.log(`ok: ${n}`); };
  const base = { run_id: 'r1', started_at: '2026-09-30T07:00:00.000Z', finished_at: '2026-09-30T07:05:00.000Z' };
  const okR = buildReport({ ...base, stages: [{ name: 'scan', ok: true, summary: 'done', durationMs: 1000 }] });
  check('all-ok subject', okR.subject.includes('1/1 stages ok') && okR.subject.includes('2026-09-30'));
  const bad = buildReport({ ...base, stages: [{ name: 'triage', ok: false, summary: 'FAILED: <x>', durationMs: 5 }] });
  check('failure subject names stage', bad.subject.includes('triage') && bad.subject.includes('FAILED'));
  check('html escapes summary', bad.html.includes('&lt;x&gt;') && !bad.html.includes('<x>'));
  check('text has duration', okR.text.includes('300.0s'));
  const md = '## Open\n\n- [ ] a\n- [x] b\n- [ ] c\n\n## Done\n\n- [ ] not open\n';
  check('parseOpenTodos open only', parseOpenTodos(md).join(',') === 'a,c');
  check('report lists todos', buildReport({ ...base, stages: [] }, ['a']).text.includes('Open to-dos (1)'));
  const kit = { counts: { READY: 2, CHECK: 1, BLOCKED: 0 }, html: '<div>KIT</div>', text: 'KIT TEXT', attachments: [{ filename: 'a.pdf', path: 'x' }] };
  const withKit = buildReport({ ...base, stages: [{ name: 'scan', ok: true, summary: 'ok', durationMs: 1 }] }, [], kit);
  check('subject carries READY/CHECK counts', withKit.subject === 'Autopilot 2026-09-30 — 2 READY · 1 CHECK · 1/1 stages ok');
  check('kit html comes before the run table', withKit.html.indexOf('KIT') < withKit.html.indexOf('Run details'));
  check('attachments pass through', withKit.attachments.length === 1);
  const weekly = buildReport({ ...base, stages: [] }, [], null, [{ source: 'lever-api', found: 3, pass: 1, prepared: 1, applied: 0, responded: 0, interview: 0 }]);
  check('sources table is appended inside the wrapper', weekly.html.includes('Sources (all time)') && weekly.html.endsWith('</div>'));
  check('no sources table when none given', !buildReport({ ...base, stages: [] }).html.includes('Sources (all time)'));
  const compact = buildReport({ ...base, stages: [{ name: 'scan', ok: true, summary: 'ok', durationMs: 1 }] }, ['t'], null, [], { reportUrl: 'http://h:1/run/2026-09-30?t=x', scan: { totals: { found: '9', new_added: '2', dupes: '1', errors: '0' }, boards: [{ status: 'network' }, { status: 'reachable' }] } });
  check('compact mail links to the report and skips the stage table', compact.html.includes('href="http://h:1/run/2026-09-30?t=x"') && !compact.html.includes('Run details') && compact.text.includes('Sources: 2 scanned, 1 with problems'));
  const detailR =buildReport({ ...base, stages: [{ name: 'triage', ok: false, summary: 'FAILED', durationMs: 1, detail: 'boom <x>' }] });
  check('failed-stage detail is shown and escaped', detailR.html.includes('boom &lt;x&gt;'));
  if (failures) process.exitCode = 1; else console.log('\nAll self-tests passed.');
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) selfTest();
  else if (argv.includes('--send-latest')) {
    const f = join(ROOT, 'data', 'runs', `${new Date().toISOString().slice(0, 10)}.json`);
    if (!existsSync(f)) { console.error(`No digest at ${f}`); process.exitCode = 1; }
    else console.log(await sendRunReport(JSON.parse(readFileSync(f, 'utf-8'))));
  } else console.log('Usage: node autopilot/notify-mail.mjs --self-test | --send-latest');
}
