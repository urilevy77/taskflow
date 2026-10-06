#!/usr/bin/env node
// @ts-check
// run-report.mjs — the daily run as a web page (served by phone-server.mjs at /run, /run/<date>) plus the
// per-board scan status behind it. Read-only over the user's files; sends nothing.
//
//   per board:  status (portal-health.tsv, this run's batch) · jobs found (scan-sources.json) · new today (scan-history.tsv)
//   whatsapp:   links collected per group (whatsapp-sources.jsonl) in the run window
//   totals:     the last scan-runs.tsv row at/after the run start
//
//   node autopilot/run-report.mjs --self-test
//   node autopilot/run-report.mjs [date] > report.html

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = getCareerOpsRoot();
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const read = (p) => { try { return existsSync(p) ? readFileSync(p, 'utf-8') : ''; } catch { return ''; } };
const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return fb; } };

/** TSV text → array of header-keyed objects. */
export function parseTsv(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const head = lines[0].split('\t');
  return lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i], v])));
}

const STATUS_ORDER = { auth: 0, network: 1, slug_gone: 2, unknown: 3, empty: 4, reachable: 5 };

/**
 * Pure. Inputs are raw file contents; `window` = { start, end } ISO strings of the run.
 * → { totals, boards: [{name, status, found, added}], statusCounts, whatsapp: [{group, links}] }
 */
export function buildScanStatus({ portalHealth, scanSources, scanRuns, scanHistory, whatsapp }, window) {
  const start = Date.parse(window.start), end = Date.parse(window.end);
  const inWin = (iso) => { const t = Date.parse(iso); return t >= start - 1000 && t <= end + 1000; };

  // portal-health.tsv: "timestamp<TAB>name<TAB>status" per line (a stray header line is ignored).
  const raw = String(portalHealth ?? '').split(/\r?\n/).filter(Boolean)
    .map((l) => { const [ts, name, status] = l.split('\t'); return { ts, name, status }; })
    .filter((r) => r.ts && r.name && r.status && !Number.isNaN(Date.parse(r.ts)));
  let batch = raw.filter((r) => inWin(r.ts));
  if (!batch.length && raw.length) { const last = raw[raw.length - 1].ts; batch = raw.filter((r) => r.ts === last); }
  const healthByName = new Map(batch.map((r) => [r.name.toLowerCase(), r.status]));

  const day = String(window.start).slice(0, 10);
  const added = new Map();
  for (const r of parseTsv(scanHistory)) {
    if (r.first_seen !== day || (r.status && r.status !== 'added')) continue;
    const k = String(r.company ?? '').toLowerCase();
    added.set(k, (added.get(k) ?? 0) + 1);
  }

  const sources = scanSources?.sources ?? {};
  const names = new Set([...Object.keys(sources), ...batch.map((r) => r.name)]);
  const boards = [...names].map((name) => ({
    name,
    status: healthByName.get(name.toLowerCase()) ?? 'not scanned',
    found: sources[name]?.found ?? null,
    added: added.get(name.toLowerCase()) ?? 0,
  })).sort((a, b) => (STATUS_ORDER[a.status] ?? 6) - (STATUS_ORDER[b.status] ?? 6) || (b.found ?? -1) - (a.found ?? -1) || a.name.localeCompare(b.name));

  const statusCounts = {};
  for (const b of boards) statusCounts[b.status] = (statusCounts[b.status] ?? 0) + 1;

  const runs = parseTsv(scanRuns).filter((r) => Date.parse(r.timestamp) >= start - 1000);
  const totals = runs.length ? runs[runs.length - 1] : null;

  const wa = new Map();
  for (const line of String(whatsapp ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const { group, ts } = JSON.parse(line); if (group && ts && inWin(ts)) wa.set(group, (wa.get(group) ?? 0) + 1); } catch { /* torn line */ }
  }
  const whatsappRows = [...wa].map(([group, links]) => ({ group, links })).sort((a, b) => b.links - a.links);

  return { totals, boards, statusCounts, whatsapp: whatsappRows };
}

export function loadScanStatus(digest, root = ROOT) {
  return buildScanStatus({
    portalHealth: read(join(root, 'data', 'portal-health.tsv')),
    scanSources: readJson(join(root, 'data', 'scan-sources.json'), {}),
    scanRuns: read(join(root, 'data', 'scan-runs.tsv')),
    scanHistory: read(join(root, 'data', 'scan-history.tsv')),
    whatsapp: read(join(root, 'data', 'whatsapp-sources.jsonl')),
  }, { start: digest.started_at, end: digest.finished_at });
}

/** Digest files in data/runs (YYYY-MM-DD.json), newest first. */
export function listRunDates(root = ROOT) {
  const d = join(root, 'data', 'runs');
  return existsSync(d) ? readdirSync(d).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse() : [];
}

const ICON = { reachable: '✅', empty: '⚪', network: '🔌', auth: '🔒', slug_gone: '🚫', unknown: '❓', 'not scanned': '⏭' };
const LABEL = { reachable: 'reachable', empty: 'empty (0 jobs)', network: 'network error', auth: 'auth required', slug_gone: 'board gone', unknown: 'unknown', 'not scanned': 'not scanned' };

const TOTAL_LABELS = [
  ['companies', 'Companies'], ['boards', 'Boards'], ['found', 'Jobs found'], ['filtered_title', 'Filtered: title'], ['filtered_location', 'Filtered: location'],
  ['filtered_tier', 'Filtered: tier'], ['filtered_posting_age', 'Filtered: age'], ['dupes', 'Duplicates'], ['new_added', 'New added'], ['errors', 'Errors'],
];

/** Pure: full run page. `runDates` feeds the history links. */
export function renderRunPage(digest, scan, { runDates = [], todos = [], jobsLink = true } = {}) {
  const stages = digest.stages ?? [];
  const failed = stages.filter((s) => !s.ok);
  const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const mins = (ms) => (ms >= 90000 ? `${(ms / 60000).toFixed(1)} min` : secs(ms));
  const day = String(digest.started_at).slice(0, 10);
  const total = new Date(digest.finished_at).getTime() - new Date(digest.started_at).getTime();

  const stageRows = stages.map((s) => `<tr><td>${s.ok ? '✅' : '❌'}</td><td><b>${esc(s.name)}</b></td><td class="r">${mins(s.durationMs)}</td><td>${esc(s.summary)}${s.detail ? `<pre>${esc(s.detail)}</pre>` : ''}</td></tr>`).join('');
  const chips = Object.entries(scan.statusCounts).sort((a, b) => (STATUS_ORDER[a[0]] ?? 6) - (STATUS_ORDER[b[0]] ?? 6))
    .map(([k, n]) => `<span class="chip">${ICON[k] ?? ''} ${esc(LABEL[k] ?? k)}: <b>${n}</b></span>`).join('');
  const totals = scan.totals ? `<div class="grid">${TOTAL_LABELS.filter(([k]) => scan.totals[k] !== undefined).map(([k, l]) => `<div class="kpi"><b>${esc(scan.totals[k])}</b><span>${l}</span></div>`).join('')}</div>` : '<p class="muted">No scan totals recorded for this run.</p>';
  const boardRows = scan.boards.map((b) => `<tr class="${b.status === 'reachable' ? '' : 'bad'}"><td>${esc(b.name)}</td><td>${ICON[b.status] ?? ''} ${esc(LABEL[b.status] ?? b.status)}</td><td class="r">${b.found ?? '—'}</td><td class="r">${b.added || ''}</td></tr>`).join('');
  const wa = scan.whatsapp.length ? `<table><tr><th>group</th><th class="r">links</th></tr>${scan.whatsapp.map((w) => `<tr><td>${esc(w.group)}</td><td class="r">${w.links}</td></tr>`).join('')}</table>` : '<p class="muted">No WhatsApp links collected in this run window.</p>';
  const history = runDates.length ? `<p class="muted">Other runs: ${runDates.slice(0, 14).map((d) => (d === day ? `<b>${d}</b>` : `<a href="/run/${d}">${d}</a>`)).join(' · ')}</p>` : '';
  const todoHtml = todos.length ? `<h2>Open to-dos (${todos.length})</h2><ul>${todos.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autopilot ${esc(day)}</title>
<style>
:root{--bg:#f6f8fa;--card:#fff;--fg:#1f2328;--mut:#57606a;--line:#d0d7de;--bad:#fff1f0}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--fg:#e6edf3;--mut:#8b949e;--line:#30363d;--bad:#2d1618}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}main{max-width:820px;margin:0 auto;padding:16px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:14px 0;overflow-x:auto}
h1{font-size:20px;margin:8px 0}h2{font-size:16px;margin:4px 0 8px}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.r{text-align:right}tr.bad{background:var(--bad)}
pre{white-space:pre-wrap;font-size:11px;margin:4px 0 0}.muted{color:var(--mut);font-size:13px}.chip{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:2px 10px;margin:2px 4px 2px 0;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin:8px 0}.kpi{border:1px solid var(--line);border-radius:8px;padding:8px}.kpi b{display:block;font-size:20px}.kpi span{color:var(--mut);font-size:12px}
a{color:#0969da}
</style></head><body><main>
<h1>${failed.length ? '❌' : '✅'} Autopilot — ${esc(day)}</h1>
<p class="muted">Run <code>${esc(digest.run_id)}</code> · ${mins(total)} · ${stages.length - failed.length}/${stages.length} stages ok${failed.length ? ` · FAILED: ${esc(failed.map((s) => s.name).join(', '))}` : ''}</p>
<section><h2>Stages</h2><table>${stageRows}</table></section>
<section><h2>Scan totals</h2>${totals}</section>
<section><h2>Scan status per source (${scan.boards.length})</h2><p>${chips}</p>
<p class="muted">Problem sources first. “found” = jobs the board returned before filters; “new” = rows added to the pipeline today.</p>
<table><tr><th>source</th><th>status</th><th class="r">found</th><th class="r">new</th></tr>${boardRows}</table></section>
<section><h2>WhatsApp groups</h2>${wa}</section>
<section>${jobsLink ? '<p><a href="/">→ Jobs to apply to (CVs + “I applied”)</a></p>' : ''}${todoHtml}${history}</section>
</main></body></html>`;
}

function selfTest() {
  let failures = 0;
  const check = (n, c) => { if (!c) { console.error(`FAIL: ${n}`); failures += 1; } else console.log(`ok: ${n}`); };
  const win = { start: '2026-10-06T14:56:00.000Z', end: '2026-10-06T15:07:00.000Z' };
  const health = '2026-10-05T10:00:00.000Z\tOld\treachable\n2026-10-06T15:06:58.765Z\tAcme\treachable\n2026-10-06T15:06:58.765Z\tDown\tnetwork\n2026-10-06T15:06:58.765Z\tNone\tempty\n';
  const hist = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n' + 'u1\t2026-10-06\tgh\tT\tAcme\tadded\nu2\t2026-10-06\tgh\tT\tAcme\tadded\nu3\t2026-10-05\tgh\tT\tAcme\tadded\n';
  const runs = 'timestamp\tstatus\tfound\tnew_added\n2026-10-05T10:00:00.000Z\tcompleted\t1\t1\n2026-10-06T15:06:58.821Z\tcompleted\t9\t4\n';
  const wa = '{"url":"x","group":"G1","ts":"2026-10-06T15:00:00.000Z"}\n{"url":"y","group":"G1","ts":"2026-09-01T15:00:00.000Z"}\n{bad';
  const s = buildScanStatus({ portalHealth: health, scanSources: { sources: { Acme: { found: 10 }, Down: { found: 0 } } }, scanRuns: runs, scanHistory: hist, whatsapp: wa }, win);
  check('only this run’s health batch', !s.boards.some((b) => b.name === 'Old') && s.boards.length === 3);
  check('problem sources sort first', s.boards[0].name === 'Down' && s.boards[s.boards.length - 1].name === 'Acme');
  check('found and new-today per board', s.boards.find((b) => b.name === 'Acme').found === 10 && s.boards.find((b) => b.name === 'Acme').added === 2);
  check('status counts', s.statusCounts.reachable === 1 && s.statusCounts.network === 1 && s.statusCounts.empty === 1);
  check('totals from this run’s row', s.totals.found === '9' && s.totals.new_added === '4');
  check('whatsapp counted inside window only; torn line skipped', s.whatsapp.length === 1 && s.whatsapp[0].links === 1);
  const page = renderRunPage({ run_id: 'r', started_at: win.start, finished_at: win.end, stages: [{ name: 'scan', ok: false, summary: '<b>x</b>', durationMs: 1000, detail: 'boom' }] }, s, { runDates: ['2026-10-06', '2026-10-05'], todos: ['a<b'] });
  check('page escapes + shows failure', page.includes('&lt;b&gt;x') && page.includes('FAILED: scan') && page.includes('a&lt;b'));
  check('page links other runs', page.includes('href="/run/2026-10-05"'));
  check('page is mobile-ready', page.includes('name="viewport"'));
  if (failures) process.exitCode = 1; else console.log('\nAll self-tests passed.');
}

if (isMainModule(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === '--self-test') selfTest();
  else {
    const date = arg ?? listRunDates()[0];
    const digest = readJson(join(ROOT, 'data', 'runs', `${date}.json`), null);
    if (!digest) { console.error(`No digest for ${date}`); process.exitCode = 1; }
    else console.log(renderRunPage(digest, loadScanStatus(digest), { runDates: listRunDates() }));
  }
}
