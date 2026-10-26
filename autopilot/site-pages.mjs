#!/usr/bin/env node
// @ts-check
// site-pages.mjs — the pages of the static run site (publish-site.mjs uploads them to Cloudflare Pages,
// behind Cloudflare Access). Styled after the career-ops web UI (web/): brand orange, warm neutrals,
// Inter + Instrument Serif, light/dark. Pure renderers + read-only loaders; writes and sends nothing.
//
//   /              dashboard: what to apply to, pipeline counts, latest run, to-dos
//   /apply         apply queue: READY/CHECK jobs with the best CV, the posting link, "I applied" / "Skip"
//   /jobs          every tracker row, filter + search
//   /job/<#>       one tracker row: status, notes, CV, report
//   /filtered      leads triage rejected (FAIL / MARGINAL / SKIP) with the reason, plus "Move to Pass" / "I applied" / "Skip"
//   /runs          every daily run; /run/<date> stays as before (run-report.mjs)
//
// "I applied" / "Skip" are remembered on the phone only (localStorage). The page shows one command to
// run on the PC — node autopilot/phone-server.mjs --mark 134=applied,… — which records them through the
// tracker's canonical path. Filtered leads work the same way with --mark-lead <id>=applied,… (the id is a
// short hash of the posting URL; the PC adds the tracker row). The site itself never writes anything.
//
//   node autopilot/site-pages.mjs --self-test

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';
import { classifyRole, BASE_ROLE, RELATED, cvSource, describeCvSource } from './cv-library.mjs';
import { findBundleCv, CV_FILENAME, safeHttpUrl } from './apply-kit.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { normalizeUrl } from '../url-key.mjs';
import { createHash } from 'node:crypto';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Data ─────────────────────────────────────────────────────────────────────

/** Tracker markdown → rows (with notes + URL, which find.mjs's parser drops). */
export function readTracker(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const colmap = resolveColumns(lines);
  const rows = [];
  for (const line of lines) {
    const r = parseTrackerRow(line, colmap);
    if (!r) continue;
    const cells = line.split('|').map((s) => s.trim());
    const link = r.report.match(/\[(\d+)\]\(([^)]+)\)/);
    const score = parseFloat(r.score);
    rows.push({
      num: r.num, date: r.date, company: r.company, role: r.role, status: r.status.replace(/\*/g, '').trim(),
      score: Number.isFinite(score) ? score : null, notes: r.notes,
      url: safeHttpUrl(colmap.url != null ? cells[colmap.url] : ''),
      reportNum: link ? Number(link[1]) : null,
      reportPath: link ? link[2].replace(/^(\.\.\/)+/, '') : null,
    });
  }
  return rows;
}

const GROUP = { applied: 'active', responded: 'active', interview: 'active', offer: 'active', hired: 'active', evaluated: 'decide', rejected: 'closed', discarded: 'closed', skip: 'closed' };
/** active (in a process) · decide (evaluated, no decision) · closed. Unknown → decide. */
export const statusGroup = (status) => GROUP[String(status ?? '').toLowerCase()] ?? 'decide';

const TONE = { evaluated: 'neutral', applied: 'blue', responded: 'teal', interview: 'brand', offer: 'green', hired: 'green', rejected: 'red', discarded: 'faint', skip: 'faint' };
const CANON = { evaluated: 'Evaluated', applied: 'Applied', responded: 'Responded', interview: 'Interview', offer: 'Offer', hired: 'Hired', rejected: 'Rejected', discarded: 'Discarded', skip: 'SKIP' };
const pill = (status) => (status ? `<span class="pill t-${TONE[String(status).toLowerCase()] ?? 'neutral'}">${esc(CANON[String(status).toLowerCase()] ?? status)}</span>` : '');

/** The job's output/<NNN>-… bundle dir (relative), or null. */
export function bundleFor(reportNum, root) {
  if (reportNum == null) return null;
  const out = join(root, 'output');
  if (!existsSync(out)) return null;
  const d = readdirSync(out, { withFileTypes: true }).find((e) => e.isDirectory() && Number(e.name.split('-')[0]) === Number(reportNum) && /^\d{3,}-/.test(e.name));
  return d ? `output/${d.name}` : null;
}

/**
 * Best available CV for a job: its own tailored CV → the CV of its role family (CVs/<Role>/) → the general CV.
 * Returns { src (absolute), href (site path), label, kind } or null when there is none at all.
 */
export function pickCv({ reportNum, title, bundle }, root) {
  const own = findBundleCv(bundle ?? bundleFor(reportNum, root), root);
  if (own && reportNum != null) return { src: own, href: `/cv/job/${Number(reportNum)}.pdf`, label: describeCvSource(cvSource(own)) || 'Tailored for this job', kind: 'job' };
  const role = classifyRole(title);
  for (const [r, label] of [[role, `Existing CV: ${role.replace(/_/g, ' ')}`], [BASE_ROLE, 'General CV']]) {
    const src = join(root, 'CVs', r, 'Uri_Levy_CV.pdf');
    if (existsSync(src)) return { src, href: `/cv/role/${encodeURIComponent(r)}.pdf`, label: describeCvSource(cvSource(src)) || label, kind: 'role' };
  }
  return null;
}

// ── Markdown (reports) ───────────────────────────────────────────────────────

/** Small, safe markdown → HTML for reports: escapes first, then headings, lists, tables, bold, code. No links. */
export function mdLite(md) {
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let list = [], table = [], para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`); // reports put one "**Field:** value" per line
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`);
    if (table.length) {
      const rows = table.filter((l) => !/^\|(\s*:?-+:?\s*\|)+\s*$/.test(l)).map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim())));
      out.push(`<div class="scroll"><table>${rows.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${c}</th>` : `<td>${c}</td>`)).join('')}</tr>`).join('')}</table></div>`);
    }
    para = []; list = []; table = [];
  };
  for (const raw of esc(md).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); out.push(`<h${Math.min(h[1].length + 2, 5)}>${inline(h[2])}</h${Math.min(h[1].length + 2, 5)}>`); continue; }
    if (/^\s*[-*]\s+/.test(line)) { if (para.length || table.length) flush(); list.push(line.replace(/^\s*[-*]\s+/, '')); continue; }
    if (line.startsWith('|')) { if (para.length || list.length) flush(); table.push(line); continue; }
    if (/^-{3,}$/.test(line.trim())) { flush(); out.push('<hr>'); continue; }
    if (!line.trim()) { flush(); continue; }
    if (list.length || table.length) flush();
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

/** Report → { summary (before the JD), jd (the archived JD) } as markdown; title line and Machine Summary dropped. */
export function splitReport(md) {
  const parts = String(md ?? '').replace(/^#\s.*\r?\n/, '').split(/^(?=##\s)/m);
  const isJd = (p) => /^##\s+Job Description/i.test(p);
  return {
    summary: parts.filter((p) => !isJd(p) && !/^##\s+Machine Summary/i.test(p)).join('').trim(),
    jd: parts.filter(isJd).map((p) => p.replace(/^##.*\r?\n/, '')).join('').trim(),
  };
}

// ── Layout ───────────────────────────────────────────────────────────────────

export const SITE_CSS = `@font-face{font-family:Inter;src:url(/fonts/Inter-Latin-Variable.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Instrument Serif";src:url(/fonts/InstrumentSerif-Latin-Regular.woff2) format("woff2");font-display:swap}
@font-face{font-family:"Instrument Serif";font-style:italic;src:url(/fonts/InstrumentSerif-Latin-Italic.woff2) format("woff2");font-display:swap}
:root{--brand:hsl(26 73% 51%);--brand-fg:hsl(24 30% 12%);--brand-soft:hsl(26 73% 51% / .12);--bg:#f7f6f3;--surface:#fff;--hover:#efeeea;--border:hsl(40 9% 86%);--fg:hsl(30 10% 11%);--muted:hsl(35 9% 34%);--faint:hsl(35 7% 42%);--landing:#59592a;--brand-text:hsl(26 80% 36%);--blue:#1d5fd1;--green:#1a7f37;--red:#b42318;--teal:#0f766e;--amber:#8a5a00;--bad:#fdf0ee;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--surface:#161616;--hover:#232323;--border:#262626;--fg:#fafafa;--muted:#a1a1aa;--faint:#8b8b95;--landing:#e4e2d0;--brand-text:hsl(26 73% 51%);--blue:#7aa7ff;--green:#4ade80;--red:#f87171;--teal:#2dd4bf;--amber:#fbbf24;--bad:#2a1513;color-scheme:dark}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}
a{color:var(--brand-text)}
.top{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--border)}
.top .in{max-width:920px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:16px}
.brand{display:flex;align-items:center;gap:9px;font-weight:600;color:var(--fg);text-decoration:none}
.mark{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--brand);color:var(--brand-fg);font-weight:800;font-size:12px;letter-spacing:-.02em}
.nav{display:flex;gap:2px;margin-left:auto}
.nav a{padding:6px 12px;border-radius:99px;color:var(--muted);text-decoration:none;font-weight:500;font-size:14px}
.nav a:hover{color:var(--fg)}.nav a.on{background:var(--surface);color:var(--fg);box-shadow:0 0 0 1px var(--border)}
.badge{display:inline-block;min-width:18px;padding:0 6px;border-radius:99px;background:var(--brand);color:var(--brand-fg);font-size:11px;font-weight:700;line-height:18px;text-align:center;margin-left:4px}
.tabbar{display:none}
main{max-width:920px;margin:0 auto;padding:16px 16px 104px}
h1{font:400 clamp(32px,8vw,46px)/1.05 "Instrument Serif",ui-serif,Georgia,serif;color:var(--landing);margin:10px 0 6px;letter-spacing:-.01em}
h1 em{font-style:italic;color:var(--brand-text)}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);font-weight:600;margin:30px 0 10px;display:flex;align-items:center;gap:8px}
h2 a{margin-left:auto;text-transform:none;letter-spacing:0;font-size:13px;font-weight:500}
h3{font-size:16px;margin:18px 0 6px}h4,h5{font-size:14px;margin:14px 0 4px}
.sub{color:var(--muted);margin:0 0 6px}.muted{color:var(--muted);font-size:13px}.faint{color:var(--faint)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px 16px;margin:10px 0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.kpi{display:block;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:12px 14px;color:var(--fg);text-decoration:none}
.kpi b{display:block;font:400 38px/1 "Instrument Serif",ui-serif,Georgia,serif}.kpi span{color:var(--muted);font-size:13px}
.kpi.hot{border-color:var(--brand);background:var(--brand-soft)}.kpi.hot b{color:var(--brand-text)}
.bar{display:flex;height:12px;border-radius:99px;overflow:hidden;background:var(--hover);margin:10px 0}
.bar i{display:block;height:100%}.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px;color:var(--muted)}
.legend span::before{content:"";display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;background:var(--c)}
.pill{display:inline-flex;align-items:center;padding:1px 9px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap;color:var(--c);background:color-mix(in srgb,var(--c) 13%,transparent)}
.t-neutral{--c:var(--muted)}.t-blue{--c:var(--blue)}.t-teal{--c:var(--teal)}.t-brand{--c:var(--brand-text)}.t-green{--c:var(--green)}.t-red{--c:var(--red)}.t-faint{--c:var(--faint)}.t-amber{--c:var(--amber)}
.score{font-variant-numeric:tabular-nums;font-weight:600}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:46px;padding:10px 16px;border-radius:11px;border:1px solid var(--border);background:var(--surface);color:var(--fg);font:600 15px/1.1 inherit;text-decoration:none;cursor:pointer;flex:1 1 140px}
.btn:hover{background:var(--hover)}.btn.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-fg)}.btn.primary:hover{filter:brightness(1.07)}
.btn.ok{background:var(--green);border-color:var(--green);color:#fff}.btn.small{min-height:34px;padding:6px 12px;font-size:13px;flex:0 0 auto}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.job .head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.job h3{font-size:18px;margin:4px 0 2px;line-height:1.3}.job h3 a{color:inherit;text-decoration:none}
.job .why{margin:8px 0 0;color:var(--fg)}.job .warn{margin:6px 0 0;color:var(--amber);font-size:14px}
.job .src{margin:4px 0 0;font-size:13px;color:var(--muted)}.job .gaps{margin:6px 0 0;font-size:13px;color:var(--muted)}.job .cv{margin:10px 0 0;font-size:13px;color:var(--muted)}
.job.marked{opacity:.5}
.list{background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.item{display:grid;grid-template-columns:1fr auto;gap:2px 12px;padding:12px 16px;border-top:1px solid var(--border);color:var(--fg);text-decoration:none}
.item:first-child{border-top:0}.item:hover{background:var(--hover)}
.item .co{font-weight:600}.item .ro{color:var(--muted);font-size:14px;grid-column:1}.item .meta{grid-row:1/3;grid-column:2;text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:4px;font-size:12px;color:var(--faint)}
.chips{display:flex;gap:6px;overflow-x:auto;padding:2px 0 8px;scrollbar-width:none}
.chip{flex:0 0 auto;border:1px solid var(--border);background:var(--surface);color:var(--muted);border-radius:99px;padding:6px 12px;font:500 13px/1 inherit;cursor:pointer}
.chip[aria-pressed=true]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
input[type=search]{width:100%;min-height:44px;padding:10px 14px;border-radius:11px;border:1px solid var(--border);background:var(--surface);color:var(--fg);font:15px inherit;margin:4px 0 10px}
.filters{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px;margin:0 0 10px}.filters label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted);flex:1 1 140px;min-width:0}
.filters select,.filters input[type=date]{min-height:40px;padding:6px 10px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--fg);font:14px inherit;width:100%}
.filters label.chk{flex:0 0 auto;flex-direction:row;align-items:center;min-height:40px;font-size:13px}.filters label[hidden]{display:none!important}
.sync{border-color:var(--brand);background:var(--brand-soft)}
.sync code.cmd{display:block;margin:8px 0;padding:10px 12px;border-radius:9px;background:var(--surface);border:1px solid var(--border);font-size:12.5px;white-space:pre-wrap;word-break:break-all}
.sync ul{margin:6px 0;padding-left:18px}
.draft{white-space:pre-wrap;word-break:break-word;margin:10px 0;padding:10px 12px;border-radius:10px;background:var(--hover);border:1px solid var(--border);font:13.5px/1.5 inherit}
[hidden]{display:none!important}
.item .acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:6px}.item .mk{font-size:13px;color:var(--brand)}.lead .co{color:var(--fg);text-decoration:none}
.prose{font-size:15px}.prose p{margin:6px 0}.prose ul{margin:6px 0;padding-left:20px}.prose hr{border:0;border-top:1px solid var(--border);margin:14px 0}
details summary{cursor:pointer;font-weight:600;padding:4px 0}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px;overflow-wrap:normal}td b,td.r,th{white-space:nowrap}td:last-child{overflow-wrap:anywhere;min-width:10em}
th,td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}th{color:var(--faint);font-weight:600}
.r{text-align:right}tr.bad td{background:var(--bad)}pre{white-space:pre-wrap;font-size:11.5px;margin:4px 0 0}code{font-size:.92em}
.stat{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
@media (max-width:719px){.nav{display:none}
.tabbar{display:flex;position:fixed;z-index:6;bottom:0;left:0;right:0;background:var(--surface);border-top:1px solid var(--border);padding:4px 4px calc(4px + env(safe-area-inset-bottom))}
.tabbar a{flex:1;display:flex;flex-direction:column;align-items:center;gap:1px;padding:6px 0;color:var(--faint);text-decoration:none;font-size:11px;font-weight:600}
.tabbar a .ic{font-size:19px;line-height:1.2}.tabbar a.on{color:var(--brand-text)}
.tabbar .badge{position:absolute;margin:-2px 0 0 18px}}`;

const NAV = [['home', '/', 'Home', '⌂'], ['apply', '/apply', 'Apply', '✓'], ['jobs', '/jobs', 'Jobs', '☰'], ['filtered', '/filtered', 'Filtered', '⊘'], ['runs', '/runs', 'Runs', '↻']];

/** Full HTML page. `applyCount` puts a badge on the Apply tab. */
export function layout({ title, active = '', body, applyCount = 0, script = '' }) {
  const badge = (k) => (k === 'apply' && applyCount ? `<span class="badge">${applyCount}</span>` : '');
  const links = NAV.map(([k, href, label]) => `<a href="${href}"${k === active ? ' class="on" aria-current="page"' : ''}>${label}${badge(k)}</a>`).join('');
  const tabs = NAV.map(([k, href, label, ic]) => `<a href="${href}"${k === active ? ' class="on" aria-current="page"' : ''}><span class="ic" aria-hidden="true">${ic}</span>${label}${badge(k)}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#f7f6f3" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)">
<title>${esc(title)}</title><style>${SITE_CSS}</style></head><body>
<header class="top"><div class="in"><a class="brand" href="/"><span class="mark">co</span>Job search</a><nav class="nav">${links}</nav></div></header>
<main>${body}</main>
<nav class="tabbar">${tabs}</nav>${script ? `<script>${script}</script>` : ''}
</body></html>`;
}

// ── Pieces ───────────────────────────────────────────────────────────────────

// 0.0/5 is the tracker's "never scored" placeholder on triage-only rows, not a score.
const fmtScore = (s) => (s != null && Number(s) > 0 ? `<span class="score">${Number(s).toFixed(1)}<span class="faint">/5</span></span>` : '');
const LABEL_TONE = { READY: 'green', CHECK: 'amber' };

/** One apply card. `job` from phone-server loadJobs() plus { cv, trackerNum, gaps }. */
export function applyCard(job) {
  const url = safeHttpUrl(job.url);
  const gaps = (job.gaps ?? []).slice(0, 8);
  const title = job.trackerNum != null ? `<a href="/job/${job.trackerNum}">${esc(job.company)} <span class="faint">—</span> ${esc(job.title)}</a>` : `${esc(job.company)} <span class="faint">—</span> ${esc(job.title)}`;
  return `<article class="card job" data-num="${Number(job.num)}" data-company="${esc(job.company)}">
<div class="head"><span class="pill t-${LABEL_TONE[job.label] ?? 'neutral'}">${esc(job.label)}</span>${fmtScore(job.score)}${job.location ? `<span dir="auto">· ${esc(job.location)}</span>` : ''}${job.done ? pill(job.status) : ''}</div>
<h3 dir="auto">${title}</h3>
${job.why ? `<p class="why" dir="auto"><b>Why:</b> ${esc(job.why)}</p>` : ''}${job.source ? `<p class="src">Source: <bdi>${esc(job.source)}</bdi></p>` : ''}${(job.reasons ?? []).map((r) => `<p class="warn">⚠ ${esc(r)}</p>`).join('')}
${gaps.length ? `<p class="gaps">Possible gaps: ${esc(gaps.join(', '))}</p>` : ''}
<p class="cv">${job.cv ? `📄 ${esc(job.cv.label)}` : 'No CV available yet'}</p>
<div class="row">${job.cv ? `<a class="btn" href="${esc(job.cv.href)}" download="${CV_FILENAME}">⬇ CV</a>` : ''}${url ? `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open posting ↗</a>` : ''}</div>
${job.done ? '' : '<div class="row acts"><button class="btn ok" data-act="applied">✔ I applied</button><button class="btn" data-act="skip">Skip</button></div>'}
</article>`;
}

// ── Source / date / position filters (Jobs + Filtered) ───────────────────────

const FAMILIES = ['Software_Engineer', 'Frontend_Engineer', 'Data_Engineer', 'Data_Scientist', 'AI_ML_Engineer', 'DevOps_Engineer', 'QA_Automation_Engineer'];
/** Filter-only groups for titles the CV library has no family for (it only knows engineering roles). */
const EXTRA_FAMILIES = [
  ['Unknown_Title', /^job lead\b|^careers?$/i],
  ['Security_Cyber', /cyber|security|penetration|\bsoc\b|threat/i],
  ['Data_Analyst', /analyst|\bbi\b|business intelligence/i],
  ['Product_Project', /product|project|program manager/i],
  ['Support_IT', /support|help ?desk|\bit\b|implement|integration specialist|\bsap\b|oracle/i],
];
/** Job title → position family for the filter (the CV library's classifier, then the groups above); else "Other". */
export const roleFamily = (title) => {
  const r = classifyRole(title);
  if (FAMILIES.includes(r)) return r;
  return EXTRA_FAMILIES.find(([, rx]) => rx.test(String(title ?? '')))?.[0] ?? 'Other';
};
const FILTER_RELATED = { ...RELATED, Data_Scientist: [...(RELATED.Data_Scientist ?? []), 'Data_Analyst'], Data_Analyst: ['Data_Scientist', 'Data_Engineer'] };
const roleLabel = (r) => ({ AI_ML_Engineer: 'AI / ML Engineer', QA_Automation_Engineer: 'QA / Automation', Security_Cyber: 'Security / Cyber', Product_Project: 'Product / Project', Support_IT: 'Support / IT', Unknown_Title: 'No title (WhatsApp lead)' })[r] ?? r.replace(/_/g, ' ');

/** { src, date, role } → data-* attributes; a non-object (e.g. a map() index) gives none. */
const facetAttrs = (f) => (f && typeof f === 'object' ? ` data-src="${esc(f.src || 'Unknown')}" data-date="${esc(f.date || '')}" data-role="${esc(f.role || 'Other')}"` : '');

/** The filter bar: options are built from the facets actually present, most common first, with counts. */
function filterBar(facets) {
  const opts = (k, label) => {
    const m = new Map();
    for (const f of facets) m.set(f[k], (m.get(f[k]) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([v, n]) => `<option value="${esc(v)}">${esc(label(v))} (${n})</option>`).join('');
  };
  const undated = facets.filter((f) => !f.date).length;
  return `<div class="filters" role="group" aria-label="More filters">
<label>Source<select id="f-src"><option value="">All sources</option>${opts('src', (v) => v)}</select></label>
<label>Date<select id="f-date"><option value="">Any time</option><option value="today">Today</option><option value="yday">Yesterday</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="day">Pick a day…</option></select></label>
<label id="f-day-w" hidden>Day<input type="date" id="f-day"></label>
<label>Position<select id="f-role"><option value="">All positions</option>${opts('role', roleLabel)}</select></label>
<label class="chk"><input type="checkbox" id="f-rel"> + related</label>
<button class="chip" id="f-clear" type="button">Clear</button></div>${undated ? `<p class="faint" style="margin:-4px 0 8px;font-size:12px">${undated} without a known date are hidden when a date filter is on.</p>` : ''}`;
}

/** Client half of filterBar: defines facetOk(item) and facetWire(run), which re-runs the page's filter on change. Kept per tab in sessionStorage. */
const FACETS_JS = `var REL=${JSON.stringify(FILTER_RELATED)};
var fSrc=document.getElementById('f-src'),fDate=document.getElementById('f-date'),fDay=document.getElementById('f-day'),fDayW=document.getElementById('f-day-w'),fRole=document.getElementById('f-role'),fRel=document.getElementById('f-rel');
function ymd(d){return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2)}
function ago(n){var d=new Date();d.setDate(d.getDate()-n);return ymd(d)}
function facetOk(i){
  if(fSrc.value&&i.dataset.src!==fSrc.value)return false;
  var d=i.dataset.date||'',w=fDate.value;
  if(w==='today'&&d!==ago(0))return false;
  if(w==='yday'&&d!==ago(1))return false;
  if((w==='7'||w==='30')&&!(d&&d>=ago(Number(w)-1)))return false;
  if(w==='day'&&fDay.value&&d!==fDay.value)return false;
  if(fRole.value&&i.dataset.role!==fRole.value&&!(fRel.checked&&(REL[fRole.value]||[]).indexOf(i.dataset.role)>=0))return false;
  return true}
function facetWire(run){
  var KEY='ap-f-'+location.pathname,els=[fSrc,fDate,fDay,fRole,fRel];
  function save(){try{sessionStorage.setItem(KEY,JSON.stringify(els.map(function(e){return e.type==='checkbox'?e.checked:e.value})))}catch(e){}}
  function sync(){fDayW.hidden=fDate.value!=='day'}
  try{var v=JSON.parse(sessionStorage.getItem(KEY)||'null');if(v)els.forEach(function(e,k){if(e.type==='checkbox')e.checked=!!v[k];else if(v[k]!=null)e.value=v[k]})}catch(e){}
  els.forEach(function(e){e.onchange=e.oninput=function(){sync();save();run()}});
  document.getElementById('f-clear').onclick=function(){fSrc.value=fDate.value=fDay.value=fRole.value='';fRel.checked=false;sync();save();run()};
  sync()}
`;

const item = (r, f) => `<a class="item" href="/job/${r.num}" data-group="${statusGroup(r.status)}"${facetAttrs(f)} data-q="${esc(`${r.company} ${r.role} ${r.status} ${r.notes}`.toLowerCase())}">
<span class="co" dir="auto">${esc(r.company)}</span><span class="meta">${pill(r.status)}<span>${fmtScore(r.score)}</span></span><span class="ro"><bdi>${esc(r.role)}</bdi> <span class="faint">· #${r.num} · ${esc(r.date)}</span></span></a>`;

const FUNNEL = [['Evaluated', 'neutral'], ['Applied', 'blue'], ['Responded', 'teal'], ['Interview', 'brand'], ['Offer', 'green'], ['Hired', 'green'], ['Rejected', 'red'], ['Discarded', 'faint'], ['SKIP', 'faint']];

export function statusCounts(rows) {
  const c = {};
  for (const r of rows) { const k = FUNNEL.find(([s]) => s.toLowerCase() === String(r.status).toLowerCase())?.[0] ?? r.status; c[k] = (c[k] ?? 0) + 1; }
  return c;
}

// ── Pages ────────────────────────────────────────────────────────────────────

/**
 * @param {{ rows: any[], jobs: any[], latest?: { date: string, ok: boolean, failed: string[], found?: string, added?: string } | null, todos?: string[], followups?: { total: number, items: any[] }, now?: string }} d
 */
export function renderHome({ rows, jobs, latest = null, todos = [], followups = { total: 0, items: [] }, now = new Date().toISOString() }) {
  const open = jobs.filter((j) => !j.done);
  const c = statusCounts(rows);
  const active = rows.filter((r) => ['interview', 'responded', 'offer'].includes(String(r.status).toLowerCase()));
  const total = rows.length || 1;
  const seg = FUNNEL.filter(([s]) => c[s]).map(([s, t]) => `<i class="t-${t}" style="width:${((c[s] / total) * 100).toFixed(2)}%;background:var(--c)" title="${s}: ${c[s]}"></i>`).join('');
  const legend = FUNNEL.filter(([s]) => c[s]).map(([s, t]) => `<span class="t-${t}">${s} <b>${c[s]}</b></span>`).join('');
  const hour = Number(now.slice(11, 13));
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const body = `<h1>${hello}, <em>Uri</em></h1>
<p class="sub">${open.length ? `${open.length} job${open.length === 1 ? '' : 's'} ready for you to apply to.` : 'Nothing waiting to apply to right now.'}${latest ? ` Last run ${esc(latest.date)} ${latest.ok ? '✓' : '— had failures'}.` : ''}</p>
<div class="kpis" style="margin-top:16px">
<a class="kpi hot" href="/apply"><b>${open.length}</b><span>To apply</span></a>
<a class="kpi" href="/jobs#active"><b>${(c.Applied ?? 0) + (c.Responded ?? 0)}</b><span>Applied, waiting</span></a>
<a class="kpi" href="/jobs#active"><b>${c.Interview ?? 0}</b><span>Interviewing</span></a>
<a class="kpi" href="/jobs#decide"><b>${c.Evaluated ?? 0}</b><span>To decide</span></a>
</div>
<h2>Up next <a href="/apply">All ${open.length} →</a></h2>
${open.slice(0, 3).map(applyCard).join('') || '<div class="card muted">All caught up. New jobs appear here after the next daily run.</div>'}
${followups.total ? `<h2>Follow up today <a href="/followups">All ${followups.total} →</a></h2><div class="card prose"><ul>${followups.items.slice(0, 5).map((i) => `<li><a href="/followups">${esc(i.company || 'Company not recorded')}</a> — ${esc(i.role)} <span class="faint">${i.status === 'applied' ? `applied ${Number(i.daysSinceApplication)}d ago` : i.status === 'interview' ? 'interview check-in' : 'they replied'}</span></li>`).join('')}</ul></div>` : ''}
${active.length ? `<h2>In process</h2><div class="list">${active.map(item).join('')}</div>` : ''}
<h2>Pipeline <a href="/jobs">${rows.length} tracked →</a></h2>
<div class="card"><div class="bar">${seg}</div><div class="legend">${legend}</div></div>
${latest ? `<h2>Latest run <a href="/runs">All runs →</a></h2><a class="card item" style="display:block;text-decoration:none;color:inherit" href="/run/${esc(latest.date)}"><div class="stat"><b>${latest.ok ? '✅' : '❌'} ${esc(latest.date)}</b>${latest.found ? `<span class="muted">${esc(latest.found)} jobs found</span>` : ''}${latest.added ? `<span class="muted">${esc(latest.added)} new</span>` : ''}</div>${latest.failed.length ? `<p class="warn" style="color:var(--red);margin:4px 0 0">Failed: ${esc(latest.failed.join(', '))}</p>` : ''}</a>` : ''}
${todos.length ? `<h2>Open to-dos (${todos.length})</h2><div class="card prose"><ul>${todos.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}`;
  return layout({ title: 'Job search', active: 'home', body, applyCount: open.length });
}

/**
 * Client helper shared by the pages that record taps (Apply, Filtered, Follow up). A tap is kept in this browser,
 * sent to the site's worker (/api/marks → the PC picks it up on its next run) and — only while the worker did not
 * confirm it — listed in a box with one command to run on the PC. A worker that is missing, signed out or offline
 * simply leaves the box as it always was.
 */
export const SYNC_JS = `var APSync=(function(){
function req(method,body){return fetch('/api/marks',{method:method,credentials:'same-origin',headers:{'content-type':'application/json','x-autopilot':'1'},body:body}).then(function(r){return r.ok?r.json():null},function(){return null})}
function load(k){try{return JSON.parse(localStorage.getItem(k)||'{}')||{}}catch(e){return {}}}
function put(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
function copy(text,btn,label){
  function ok(){if(!btn)return;btn.textContent='Copied ✓';setTimeout(function(){btn.textContent=label},1500)}
  function sel(){var el=document.getElementById('sync-cmd');if(!el)return;var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r)}
  if(navigator.clipboard)navigator.clipboard.writeText(text).then(ok,sel);else sel();
}
return {
copyButton:function(){var b=document.getElementById('copy');if(b)b.onclick=function(){copy(document.getElementById('sync-cmd').textContent,b,'Copy command')}},
copy:copy,
track:function(kind,key,onChange){
  var t={marks:load(key),synced:load(key+'-synced')};
  t.save=function(){put(key,t.marks);put(key+'-synced',t.synced)};
  t.drop=function(id){delete t.marks[id];delete t.synced[id]};
  t.set=function(id,act){t.marks[id]=act;delete t.synced[id];t.save();onChange();
    req('POST',JSON.stringify({kind:kind,id:String(id),action:act})).then(function(j){if(j&&j.ok&&t.marks[id]===act){t.synced[id]=act;t.save();onChange()}})};
  t.undo=function(id){t.drop(id);t.save();onChange();req('POST',JSON.stringify({kind:kind,id:String(id),action:'undo'}))};
  t.pull=function(){req('GET').then(function(j){var m=(j&&j.marks)||{},p=kind+':',ch=false;
    Object.keys(m).forEach(function(k){if(k.indexOf(p)!==0)return;var id=k.slice(p.length);if(!t.marks[id]){t.marks[id]=m[k];t.synced[id]=m[k];ch=true}});
    if(ch){t.save();onChange()}})};
  t.ui=function(o){
    var box=document.getElementById('sync'),list=document.getElementById('sync-list'),head=document.getElementById('sync-head'),cmdbox=document.getElementById('sync-cmdbox'),cmd=document.getElementById('sync-cmd');
    var all=Object.keys(t.marks).filter(o.exists),pend=all.filter(function(k){return t.synced[k]!==t.marks[k]});
    box.hidden=!all.length;list.textContent='';
    all.forEach(function(id){var li=document.createElement('li');li.textContent=o.label(id)+(t.synced[id]===t.marks[id]?' · saved ✓':'')+' ';
      var u=document.createElement('button');u.className='chip';u.textContent='Undo';u.onclick=function(){t.undo(id)};li.appendChild(u);list.appendChild(li)});
    head.textContent=pend.length?'Marked on this phone — record on the PC':'Saved ✓ — the PC records these on its next run';
    cmdbox.hidden=!pend.length;
    cmd.textContent=o.cmdPrefix+pend.map(function(k){return k+'='+t.marks[k]}).join(',');
  };
  return t}
}})();
`;

/** The "marked on this phone" box. Visible only while something is marked; the command part only while something is unsaved. */
const syncBox = (note) => `<section id="sync" class="card sync" hidden><b id="sync-head">Marked on this phone — record on the PC</b>
<ul id="sync-list"></ul><div id="sync-cmdbox"><code class="cmd" id="sync-cmd"></code>
<div class="row"><button class="btn small primary" id="copy" type="button">Copy command</button></div>
<p class="muted" style="margin:8px 0 0">${note}</p></div></section>`;

/** Client script for /apply: taps are saved to the site (and so reach the PC by themselves); the sync box is the fallback. */
export const APPLY_SCRIPT = `${SYNC_JS}(function(){
var done=JSON.parse(document.getElementById('done-nums').textContent||'[]');
var t=APSync.track('apply','ap-marks-v1',render);
done.forEach(function(n){t.drop(n)});t.save();
function card(n){return document.querySelector('.job[data-num="'+n+'"]')}
function render(){
  var m=t.marks;
  document.querySelectorAll('#open .job').forEach(function(c){var k=m[c.dataset.num];c.classList.toggle('marked',!!k);c.hidden=!!k});
  var left=document.querySelectorAll('#open .job:not([hidden])').length;
  document.getElementById('open-count').textContent=left;
  document.querySelectorAll('.badge').forEach(function(b){b.textContent=left;b.hidden=!left});
  document.getElementById('empty').hidden=left>0;
  t.ui({exists:card,label:function(n){var c=card(n);return (c?c.dataset.company:'#'+n)+' — '+(m[n]==='applied'?'applied':'skip')},cmdPrefix:'node autopilot/phone-server.mjs --mark '});
}
document.addEventListener('click',function(e){
  var b=e.target.closest('button[data-act]');if(!b)return;
  var c=b.closest('.job'),act=b.dataset.act;
  if(act==='skip'&&!confirm('Skip '+c.dataset.company+'?'))return;
  t.set(c.dataset.num,act);
});
APSync.copyButton();
render();t.pull();
})();`;

export function renderApply(jobs) {
  const open = jobs.filter((j) => !j.done), done = jobs.filter((j) => j.done);
  const body = `<h1>Apply</h1>
<p class="sub"><b id="open-count">${open.length}</b> open. Download the CV, open the posting and submit there yourself — then tap <b>I applied</b>.</p>
${syncBox('Run it in the career-ops folder. Marks clear themselves once the tracker shows the job as done.')}
<div id="open">${open.map(applyCard).join('')}</div>
<div id="empty" class="card muted"${open.length ? ' hidden' : ''}>All caught up. 🎉</div>
${done.length ? `<details style="margin-top:24px"><summary>Done recently (${done.length})</summary>${done.map(applyCard).join('')}</details>` : ''}
<script type="application/json" id="done-nums">${JSON.stringify(done.map((j) => Number(j.num)))}</script>`;
  return layout({ title: 'Apply · Job search', active: 'apply', body, applyCount: open.length, script: APPLY_SCRIPT });
}

const JOBS_SCRIPT = `(function(){
${FACETS_JS}var q=document.getElementById('q'),chips=document.querySelectorAll('.chip[data-g]'),items=document.querySelectorAll('.item'),g=(location.hash||'#all').slice(1);
function apply(){var t=q.value.trim().toLowerCase(),n=0;
  chips.forEach(function(c){c.setAttribute('aria-pressed',String(c.dataset.g===g))});
  items.forEach(function(i){var show=(g==='all'||i.dataset.group===g)&&(!t||i.dataset.q.indexOf(t)>=0)&&facetOk(i);i.hidden=!show;if(show)n++});
  document.getElementById('none').hidden=n>0;}
chips.forEach(function(c){c.onclick=function(){g=c.dataset.g;history.replaceState(null,'','#'+g);apply()}});
q.oninput=apply;facetWire(apply);apply();
})();`;

/** @param {any[]} rows  @param {number} [applyCount]  @param {(url: string) => { src?: string, date?: string }} [originOf] provider per posting URL */
export function renderJobs(rows, applyCount = 0, originOf = () => ({})) {
  const sorted = [...rows].sort((a, b) => b.num - a.num);
  const facet = new Map(rows.map((r) => [r, { src: (r.url && originOf(r.url).src) || 'Unknown', date: r.date, role: roleFamily(r.role) }]));
  const n = (g) => rows.filter((r) => statusGroup(r.status) === g).length;
  const body = `<h1>Jobs</h1><p class="sub">${rows.length} in the tracker, newest first.</p>
<input type="search" id="q" placeholder="Search company, role, notes…" aria-label="Search jobs">
${filterBar([...facet.values()])}
<div class="chips" role="group" aria-label="Filter by status">
<button class="chip" data-g="all">All ${rows.length}</button><button class="chip" data-g="active">In process ${n('active')}</button><button class="chip" data-g="decide">To decide ${n('decide')}</button><button class="chip" data-g="closed">Closed ${n('closed')}</button></div>
<div class="list">${sorted.map((r) => item(r, facet.get(r))).join('')}</div><div id="none" class="card muted" hidden>No jobs match.</div>`;
  return layout({ title: 'Jobs · Job search', active: 'jobs', body, applyCount, script: JOBS_SCRIPT });
}


// ── Filtered leads (triage said no) ──────────────────────────────────────────

// ── Follow up ─────────────────────────────────────────────────────────────────

const FU_KIND = { applied: 'Nudge', interview: 'Thank-you', responded: 'They replied' };

/** One follow-up card. `i` is an item from followups.mjs selectDue(): who, why it is due, and the message to copy. */
export function followupCard(i) {
  const company = i.company || 'Company not recorded';
  const when = i.status === 'applied' ? `applied ${i.daysSinceApplication} days ago${i.overdueDays ? ` · ${i.overdueDays} days past due` : ''}`
    : i.status === 'interview' ? `interview${i.overdueDays ? ` · ${i.overdueDays} days since a check-in was due` : ''}` : 'a reply is waiting';
  return `<article class="card fu" data-num="${Number(i.num)}" data-company="${esc(company)}">
<div class="head"><span class="pill t-${i.urgency === 'urgent' ? 'red' : 'amber'}">${FU_KIND[i.status] ?? 'Follow up'}</span><span class="faint">${esc(when)}</span></div>
<h3 dir="auto"><a href="/job/${Number(i.num)}">${esc(company)} <span class="faint">—</span> ${esc(i.role)}</a></h3>
${i.contact ? `<p class="src">Contact: <bdi>${esc(i.contact)}</bdi></p>` : ''}
${i.draft?.text ? `<pre class="draft" dir="auto">${esc(i.draft.text)}</pre><div class="row"><button class="btn" data-copy type="button">Copy message</button></div>` : '<p class="why">They replied — open the job to see what they said, then answer them yourself.</p>'}
<div class="row acts"><button class="btn ok" data-act="followed">✔ I followed up</button><button class="btn" data-act="retire">Retire</button></div>
</article>`;
}

/** Client script for /followups: copy a message, tap "I followed up" / "Retire" (saved to the site like the Apply taps). */
const FOLLOWUPS_SCRIPT = `${SYNC_JS}(function(){
var t=APSync.track('fu','ap-fu-marks-v1',render);
function card(n){return document.querySelector('.fu[data-num="'+n+'"]')}
Object.keys(t.marks).forEach(function(n){if(!card(n))t.drop(n)});t.save();
function render(){
  var m=t.marks;
  document.querySelectorAll('.fu').forEach(function(c){c.hidden=!!m[c.dataset.num]});
  var left=document.querySelectorAll('.fu:not([hidden])').length;
  document.getElementById('fu-count').textContent=left;
  document.getElementById('empty').hidden=left>0;
  t.ui({exists:card,label:function(n){var c=card(n);return (c?c.dataset.company:'#'+n)+' — '+(m[n]==='followed'?'follow-up sent':'retired')},cmdPrefix:'node autopilot/phone-server.mjs --mark-followup '});
}
document.addEventListener('click',function(e){
  var cp=e.target.closest('button[data-copy]');
  if(cp){APSync.copy(cp.closest('.fu').querySelector('.draft').textContent,cp,'Copy message');return}
  var b=e.target.closest('button[data-act]');if(!b)return;
  var c=b.closest('.fu'),act=b.dataset.act;
  if(act==='retire'&&!confirm('Stop following up with '+c.dataset.company+'?'))return;
  t.set(c.dataset.num,act);
});
APSync.copyButton();
render();t.pull();
})();`;

/** @param {{ total: number, items: any[] }} fu from followups.mjs loadDue()  @param {number} [applyCount] */
export function renderFollowups(fu, applyCount = 0) {
  const shown = fu.items.length;
  const body = `<h1>Follow up</h1>
<p class="sub"><b id="fu-count">${shown}</b> to follow up with${fu.total > shown ? ` (the first ${shown} of ${fu.total})` : ''}. Copy the message, send it yourself — by mail or LinkedIn — then tap <b>I followed up</b>. <b>Retire</b> drops one you will not chase.</p>
${syncBox('Run it in the career-ops folder. Marks clear themselves once the job is no longer due.')}
<div id="list">${fu.items.map(followupCard).join('')}</div>
<div id="empty" class="card muted"${shown ? ' hidden' : ''}>Nobody to follow up with right now. 🎉</div>`;
  return layout({ title: 'Follow up · Job search', active: '', body, applyCount, script: FOLLOWUPS_SCRIPT });
}

/** Stable short id for a lead, from its normalized posting URL — what the site's --mark-lead command carries. */
export const leadId = (url) => createHash('sha1').update(normalizeUrl(url)).digest('hex').slice(0, 10);

/** data/pipeline.md → leads triage did not pass: [{ id, url, company, role, location, verdict, score, reason }]. */
export function readFiltered(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^- \[[ xX]\] (.+?) \| triage: (FAIL|MARGINAL|SKIP)(?: (\d+(?:\.\d+)?)\/5)?\s*(?:[—-]\s*(.*))?$/);
    if (!m || /\| dup-of:/.test(line)) continue;
    const parts = m[1].split(' | ').map((p) => p.trim()).filter((p) => !/^(?:lane|exp|rank|posted):/.test(p)); // annotations, not positional cells
    const [rawUrl, company = '', role = '', location = ''] = parts;
    const url = safeHttpUrl(rawUrl);
    const id = url ? leadId(url) : null;
    if (id) { const prev = out.findIndex((l) => l.id === id); if (prev >= 0) out.splice(prev, 1); } // re-triaged posting: the latest line wins
    out.push({ id, url, company, role, location, verdict: m[2], score: m[3] != null ? Number(m[3]) : null, reason: (m[4] ?? '').trim() });
  }
  return out;
}

const VERDICT_TONE = { FAIL: 'red', MARGINAL: 'amber', SKIP: 'faint' };
/** One filtered lead. `row` is its tracker row when the posting URL is already tracked. */
const fitem = (r, row, f) => `<div class="item lead" data-group="${r.verdict}"${facetAttrs(f)} data-tracked="${row ? 1 : 0}"${r.id && !row ? ` data-id="${r.id}"` : ''} data-company="${esc(r.company || 'Unknown company')}" data-q="${esc(`${r.company} ${r.role} ${r.location} ${r.reason} ${row?.status ?? ''}`.toLowerCase())}">
${r.url ? `<a class="co" dir="auto" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.company || 'Unknown company')} ↗</a>` : `<span class="co" dir="auto">${esc(r.company || 'Unknown company')}</span>`}<span class="meta"><span class="pill t-${VERDICT_TONE[r.verdict]}">${r.verdict}</span><span>${fmtScore(r.score)}</span></span><span class="ro"><bdi>${esc(r.role || 'Job lead')}</bdi> <span class="faint">${r.location ? '· ' + esc(r.location) : ''}</span></span><span class="ro faint" dir="auto">${esc(r.reason)}</span>
<span class="ro acts">${row ? `${pill(row.status)} <a href="/job/${row.num}">Tracked #${row.num} →</a>` : r.id ? '<button class="btn small primary" data-act="pass">→ Move to Pass</button><button class="btn small ok" data-act="applied">✔ I applied</button><button class="btn small" data-act="skip">Skip</button><span class="mk" hidden></span>' : ''}</span></div>`;

/** Client script for /filtered: filter + search, and Applied/Skip/Pass taps saved to the site (sync box as the fallback). */
const FILTERED_SCRIPT = `${SYNC_JS}(function(){
${FACETS_JS}var q=document.getElementById('q'),chips=document.querySelectorAll('.chip[data-g]'),items=document.querySelectorAll('.lead'),g=(location.hash||'#all').slice(1);
var t=APSync.track('lead','ap-lead-marks-v1',function(){render();filter()});
Object.keys(t.marks).forEach(function(id){if(!document.querySelector('.lead[data-id="'+id+'"]'))t.drop(id)});
t.save();
function lead(id){return document.querySelector('.lead[data-id="'+id+'"]')}
function filter(){var s=q.value.trim().toLowerCase(),n=0;
  chips.forEach(function(c){c.setAttribute('aria-pressed',String(c.dataset.g===g))});
  items.forEach(function(i){var ok=g==='all'||(g==='untracked'?i.dataset.tracked==='0'&&!t.marks[i.dataset.id]:i.dataset.group===g);var show=ok&&(!s||i.dataset.q.indexOf(s)>=0)&&facetOk(i);i.hidden=!show;if(show)n++});
  document.getElementById('none').hidden=n>0;}
function render(){
  var m=t.marks;
  items.forEach(function(i){var k=i.dataset.id&&m[i.dataset.id];if(!i.dataset.id)return;
    i.querySelectorAll('button[data-act]').forEach(function(b){b.hidden=!!k});var mk=i.querySelector('.mk');mk.hidden=!k;mk.textContent=k?(k==='pass'?'Moved to Pass':k==='applied'?'Marked applied':'Marked skip')+(t.synced[i.dataset.id]===k?' — saved ✓':' — record on the PC'):''});
  t.ui({exists:lead,label:function(id){var c=lead(id);return (c?c.dataset.company:id)+' — '+(m[id]==='pass'?'move to Pass':m[id])},cmdPrefix:'node autopilot/phone-server.mjs --mark-lead '});
}
document.addEventListener('click',function(e){
  var b=e.target.closest('button[data-act]');if(!b)return;
  var l=b.closest('.lead'),act=b.dataset.act;
  if(act==='skip'&&!confirm('Skip '+l.dataset.company+'?'))return;
  t.set(l.dataset.id,act);
});
APSync.copyButton();
chips.forEach(function(c){c.onclick=function(){g=c.dataset.g;history.replaceState(null,'','#'+g);filter()}});
q.oninput=filter;facetWire(filter);render();filter();t.pull();
})();`;

/** @param {any[]} leads from readFiltered  @param {number} [applyCount]  @param {any[]} [rows] tracker rows, to show which leads are tracked  @param {(url: string) => { src?: string, date?: string }} [originOf] provider + first-seen day per URL */
export function renderFiltered(leads, applyCount = 0, rows = [], originOf = () => ({})) {
  const facet = new Map(leads.map((r) => { const o = r.url ? originOf(r.url) : {}; return [r, { src: o.src || 'Unknown', date: o.date || '', role: roleFamily(r.role) }]; }));
  const byUrl = new Map(rows.filter((r) => r.url).map((r) => [normalizeUrl(r.url), r]));
  const rowOf = (r) => (r.url ? byUrl.get(normalizeUrl(r.url)) : undefined);
  const n = (v) => leads.filter((r) => r.verdict === v).length;
  const untracked = leads.filter((r) => !rowOf(r)).length;
  const rank = { MARGINAL: 0, FAIL: 1, SKIP: 2 };
  const sorted = [...leads].sort((a, b) => rank[a.verdict] - rank[b.verdict] || (b.score ?? 0) - (a.score ?? 0));
  const body = `<h1>Filtered out</h1><p class="sub">${leads.length} leads triage did not pass — closest to passing first. Tap a company to open the posting; tap <b>Move to Pass</b> to get it a CV and put it in your Apply list, or <b>I applied</b> / <b>Skip</b> to track it.</p>
${syncBox('Run it in the career-ops folder. Applied/Skip leads become tracker rows; leads moved to Pass get prepared and show up on the Apply page. Marks clear themselves once they leave this list.')}
<input type="search" id="q" placeholder="Search company, role, reason…" aria-label="Search filtered leads">
${filterBar([...facet.values()])}
<div class="chips" role="group" aria-label="Filter by verdict">
<button class="chip" data-g="all">All ${leads.length}</button><button class="chip" data-g="untracked">Not tracked ${untracked}</button><button class="chip" data-g="MARGINAL">Marginal ${n('MARGINAL')}</button><button class="chip" data-g="FAIL">Fail ${n('FAIL')}</button><button class="chip" data-g="SKIP">Skip ${n('SKIP')}</button></div>
<div class="list">${sorted.map((r) => fitem(r, rowOf(r), facet.get(r))).join('')}</div><div id="none" class="card muted" hidden>No leads match.</div>`;
  return layout({ title: 'Filtered · Job search', active: 'filtered', body, applyCount, script: FILTERED_SCRIPT });
}

/** @param {any} row tracker row  @param {{ cv?: any, job?: any, reportMd?: string, applyCount?: number, source?: string }} [o] */
export function renderJob(row, { cv = null, job = null, reportMd = '', applyCount = 0, source = '' } = {}) {
  const { summary, jd } = splitReport(reportMd);
  const url = row.url ?? safeHttpUrl(job?.url);
  const body = `<p class="muted" style="margin:6px 0 0"><a href="/jobs">← Jobs</a></p>
<h1 dir="auto" style="font-size:clamp(28px,7vw,40px)">${esc(row.company)}</h1>
<p class="sub" dir="auto" style="font-size:17px">${esc(row.role)}</p>
<div class="stat">${pill(row.status)}${fmtScore(row.score)}<span class="muted">#${row.num} · ${esc(row.date)}</span>${job && !job.done ? `<span class="pill t-${LABEL_TONE[job.label] ?? 'neutral'}">${esc(job.label)}</span>` : ''}</div>
${job?.why ? `<p dir="auto" style="font-size:16px;margin:12px 0 0"><b>Why:</b> ${esc(job.why)}</p>` : ''}
${source || job?.source ? `<p class="muted" style="margin:4px 0 0">Source: <bdi>${esc(source || job.source)}</bdi></p>` : ''}
${row.notes ? `<div class="card" dir="auto">${esc(row.notes)}</div>` : ''}
<div class="row">${cv ? `<a class="btn" href="${esc(cv.href)}" download="${CV_FILENAME}">⬇ CV</a>` : ''}${url ? `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open posting ↗</a>` : ''}</div>
${cv ? `<p class="muted">📄 ${esc(cv.label)}</p>` : ''}
${job && !job.done ? '<p class="muted">This job is in your <a href="/apply">apply queue</a>.</p>' : ''}
${summary ? `<h2>Report</h2><div class="card prose">${mdLite(summary)}</div>` : ''}
${jd ? `<div class="card"><details><summary>Job description (archived)</summary><div class="prose" dir="auto">${mdLite(jd)}</div></details></div>` : ''}`;
  return layout({ title: `${row.company} · Job search`, active: 'jobs', body, applyCount });
}

/** @param {{ date: string, ok: boolean, failed: string[], found?: string, added?: string }[]} runs newest first */
export function renderRuns(runs, applyCount = 0) {
  const body = `<h1>Runs</h1><p class="sub">Every daily autopilot run.</p>
<div class="list">${runs.map((r) => `<a class="item" href="/run/${esc(r.date)}"><span class="co">${r.ok ? '✅' : '❌'} ${esc(r.date)}</span><span class="meta">${r.added ? `<span>${esc(r.added)} new</span>` : ''}</span><span class="ro">${r.found ? `${esc(r.found)} jobs found` : 'no scan totals'}${r.failed.length ? ` · failed: ${esc(r.failed.join(', '))}` : ''}</span></a>`).join('') || '<div class="item muted">No runs yet.</div>'}</div>`;
  return layout({ title: 'Runs · Job search', active: 'runs', body, applyCount });
}

// ── Self-test ────────────────────────────────────────────────────────────────

async function selfTest() {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  let failures = 0;
  const check = (n, c) => { if (!c) { console.error(`FAIL: ${n}`); failures += 1; } else console.log(`ok: ${n}`); };

  const md = '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |\n|---|---|---|---|---|---|---|---|---|---|\n'
    + '| 7 | 2026-09-30 | Acme <x> | Backend Dev | 4.0/5 | Interview | ❌ | [201](../reports/201-acme-2026-09-30.md) | call <b> | https://acme.com/j/1 |\n'
    + '| 8 | 2026-09-30 | Beta | Data | N/A | SKIP | ❌ | — | n | javascript:alert(1) |\n';
  const rows = readTracker(md);
  check('tracker rows parsed with notes + url', rows.length === 2 && rows[0].notes === 'call <b>' && rows[0].url === 'https://acme.com/j/1' && rows[0].reportNum === 201 && rows[0].reportPath === 'reports/201-acme-2026-09-30.md');
  check('unsafe tracker url dropped, sentinel score → null', rows[1].url === null && rows[1].score === null);
  check('status groups', statusGroup('Interview') === 'active' && statusGroup('Evaluated') === 'decide' && statusGroup('SKIP') === 'closed' && statusGroup('weird') === 'decide');

  const html = mdLite('## Triage\n\nPASS **4.5** <script>x</script>\n\n- a `b`\n- c\n\n| h | i |\n|---|---|\n| 1 | 2 |\n\n[l](javascript:x)');
  check('mdLite escapes + formats', html.includes('<h4>Triage</h4>') && html.includes('<b>4.5</b>') && html.includes('&lt;script&gt;') && html.includes('<li>a <code>b</code></li>') && html.includes('<th>h</th>') && html.includes('<td>2</td>') && !html.includes('<a '));
  const sp = splitReport('# T\n\n**Date:** x\n\n## Triage\nok\n\n## Job Description (archived verbatim)\nJD text\n\n## Machine Summary\nyaml');
  check('splitReport separates the JD and drops machine summary', sp.summary.includes('Triage') && !sp.summary.includes('JD text') && !sp.summary.includes('yaml') && sp.jd === 'JD text' && !sp.summary.startsWith('# T'));

  const root = mkdtempSync(join(tmpdir(), 'site-'));
  try {
    mkdirSync(join(root, 'output', '201-acme', 'cv', 'tailored', 'v001'), { recursive: true });
    writeFileSync(join(root, 'output', '201-acme', 'cv', 'tailored', 'v001', 'cv.pdf'), '%PDF');
    mkdirSync(join(root, 'CVs', 'AI_ML_Engineer'), { recursive: true }); writeFileSync(join(root, 'CVs', 'AI_ML_Engineer', 'Uri_Levy_CV.pdf'), '%PDF');
    mkdirSync(join(root, 'CVs', '_Base'), { recursive: true }); writeFileSync(join(root, 'CVs', '_Base', 'Uri_Levy_CV.pdf'), '%PDF');
    check('bundle found by report number', bundleFor(201, root) === 'output/201-acme' && bundleFor(999, root) === null);
    writeFileSync(join(root, 'output', '201-acme', 'state.json'), JSON.stringify({ role: 'AI Engineer' }));
    check('CV: own tailored CV first, labelled with the title it was tailored for', (() => { const c = pickCv({ reportNum: 201, title: 'AI Engineer' }, root); return c?.href === '/cv/job/201.pdf' && c.label === 'Tailored for “AI Engineer”'; })());
    check('CV: role family next', pickCv({ reportNum: 5, title: 'Junior AI Engineer' }, root)?.href === '/cv/role/AI_ML_Engineer.pdf');
    check('CV: general CV last', pickCv({ reportNum: 5, title: 'Backend Developer' }, root)?.label === 'General CV');
  } finally { rmSync(root, { recursive: true, force: true }); }

  const jobs = [
    { num: 201, trackerNum: 7, company: 'Acme <x>', title: 'Dev', label: 'READY', score: 4.2, why: 'fits <b>', source: 'WhatsApp group “A<b>”', reasons: ['needs login'], url: 'https://acme.com/j/1', gaps: ['Go'], cv: { href: '/cv/job/201.pdf', label: 'Tailored for this job' }, done: false },
    { num: 202, company: 'Beta', title: 'X', label: 'CHECK', score: 3.6, url: 'javascript:evil()', done: true, status: 'applied' },
  ];
  const apply = renderApply(jobs);
  check('apply page: why + source shown, escaped', apply.includes('<b>Why:</b> fits &lt;b&gt;') && apply.includes('Source: <bdi>WhatsApp group “A&lt;b&gt;”</bdi>'));
  check('apply page escapes and links', apply.includes('Acme &lt;x&gt;') && !apply.includes('javascript:evil') && apply.includes('href="https://acme.com/j/1"'));
  check('apply page: CV download with a clean filename', apply.includes('href="/cv/job/201.pdf" download="Uri_Levy_CV.pdf"'));
  check('apply page: buttons only on open jobs; done nums listed for the script', (apply.match(/data-act="applied"/g) ?? []).length === 1 && apply.includes('id="done-nums">[202]'));
  check('apply page: sync command uses phone-server --mark', apply.includes('phone-server.mjs --mark'));
  const home = renderHome({ rows, jobs, latest: { date: '2026-10-06', ok: false, failed: ['scan<x>'], found: '9', added: '2' }, todos: ['a<b'], now: '2026-10-06T08:00:00Z' });
  check('home: counts, escaping, run link', home.includes('<b>1</b><span>To apply</span>') && home.includes('href="/run/2026-10-06"') && home.includes('scan&lt;x&gt;') && home.includes('a&lt;b') && home.includes('Good morning'));
  check('home: interview row listed under In process', home.includes('In process') && home.includes('href="/job/7"'));
  const jobsPage = renderJobs(rows);
  check('jobs page: one item per row with filter data', (jobsPage.match(/class="item"/g) ?? []).length === 2 && jobsPage.includes('data-group="closed"') && jobsPage.includes('call &lt;b&gt;'));
  const jp = renderJob(rows[0], { reportMd: '# t\n## Triage\nok\n## Job Description (archived verbatim)\n<img src=x>' });
  check('job page: report + escaped JD + posting link', jp.includes('<h4>Triage</h4>') && jp.includes('&lt;img src=x&gt;') && jp.includes('href="https://acme.com/j/1"'));
  check('layout: mobile tab bar, viewport, no external resources', home.includes('class="tabbar"') && home.includes('name="viewport"') && !/(src|href)="https?:\/\/(?!acme)/.test(home));
  check('runs page lists runs', renderRuns([{ date: '2026-10-06', ok: true, failed: [], found: '9', added: '2' }]).includes('href="/run/2026-10-06"'));

  const fl = readFiltered([
    '- [x] https://a.com/1 | Acme | Dev <b> | Tel Aviv | lane: x | triage: FAIL 2.0/5 — too senior',
    '- [x] https://a.com/2 | B | R | dup-of: https://a.com/1',
    '- [ ] https://a.com/3 | C | R | triage: PASS 4.0/5 — ok',
    '- [x] https://a.com/4 |  | Job lead | lane: x | triage: SKIP 0.0/5 — aggregator',
  ].join(String.fromCharCode(10)));
  check('readFiltered keeps FAIL/SKIP only, drops dup + PASS', fl.length === 2 && fl[0].reason === 'too senior' && fl[0].score === 2 && fl[0].location === 'Tel Aviv' && fl[1].verdict === 'SKIP');
  const fp = renderFiltered(fl);
  check('filtered page: items link out, escaped', (fp.match(/class="item lead"/g) ?? []).length === 2 && fp.includes('rel="noopener noreferrer"') && fp.includes('Dev &lt;b&gt;'));
  check('filtered: stable lead id from the normalized URL', /^[0-9a-f]{10}$/.test(fl[0].id) && fl[0].id === leadId('https://A.com/1/?utm_source=x'));
  check('filtered page: untracked leads get Move to Pass/Applied/Skip + --mark-lead sync', (fp.match(/data-act="applied"/g) ?? []).length === 2 && (fp.match(/data-act="pass"/g) ?? []).length === 2 && fp.includes('--mark-lead'));
  const fpt = renderFiltered(fl, 0, [{ num: 9, status: 'Applied', url: 'https://a.com/1' }]);
  check('filtered page: an already-tracked lead shows its status, no buttons', (fpt.match(/data-act="applied"/g) ?? []).length === 1 && fpt.includes('href="/job/9"') && fpt.includes('Not tracked 1'));
  check('role family: known families, else Other', roleFamily('Senior Backend Engineer') === 'Software_Engineer' && roleFamily('LLM Engineer') === 'AI_ML_Engineer' && roleFamily('Product Manager') === 'Product_Project' && roleFamily('Job lead (WhatsApp)') === 'Unknown_Title' && roleFamily('Chef') === 'Other');
  const fp2 = renderFiltered(fl, 0, [], (u) => (u === 'https://a.com/1' ? { src: 'Lever <x>', date: '2026-10-10' } : {}));
  check('filtered page: facet attrs + filter bar with counts, escaped', fp2.includes('data-src="Lever &lt;x&gt;" data-date="2026-10-10" data-role="Other"') && fp2.includes('<option value="Lever &lt;x&gt;">Lever &lt;x&gt; (1)</option>') && fp2.includes('1 without a known date'));
  const jp2 = renderJobs(rows, 0, () => ({ src: 'WhatsApp' }));
  check('jobs page: facets from tracker date + provider, filter wired', jp2.includes('id="f-src"') && jp2.includes('data-src="WhatsApp"') && jp2.includes('facetOk(i)') && jp2.includes('"Software_Engineer":['));
  // Follow up: page, cards, home section, and every client script must at least parse.
  const fu = { total: 3, items: [
    { num: 135, company: 'Acme <b>', role: 'Backend Engineer', status: 'applied', urgency: 'overdue', daysSinceApplication: 9, overdueDays: 2, contact: 'Nina Knopp', draft: { kind: 'nudge', text: 'Hi Nina,\n\nI applied for <the role>.' } },
    { num: 136, company: '', role: 'Data', status: 'responded', urgency: 'urgent', daysSinceApplication: 3, overdueDays: 0, contact: '', draft: { kind: 'reply', text: '' } },
  ] };
  const fup = renderFollowups(fu, 2);
  check('follow-up page: cards escaped, draft + copy only when there is a message', fup.includes('Acme &lt;b&gt;') && !fup.includes('Acme <b>') && fup.includes('I applied for &lt;the role&gt;.') && (fup.match(/<button class="btn" data-copy/g) ?? []).length === 1 && fup.includes('They replied — open the job'));
  check('follow-up page: unrecorded company worded, actions + sync fallback present', fup.includes('Company not recorded') && (fup.match(/data-act="followed"/g) ?? []).length === 2 && fup.includes('data-act="retire"') && fup.includes('--mark-followup') && fup.includes('id="sync-cmdbox"'));
  check('follow-up page: says how many are shown of the total', fup.includes('the first 2 of 3'));
  check('follow-up page: empty state when nothing is due', !renderFollowups({ total: 0, items: [] }).includes('class="card fu"') && !/id="empty"[^>]*hidden/.test(renderFollowups({ total: 0, items: [] })));
  const homeFu = renderHome({ rows: [], jobs: [], followups: fu });
  check('home: "Follow up today" lists names, links to /followups; absent when nothing is due', homeFu.includes('Follow up today') && homeFu.includes('href="/followups"') && homeFu.includes('Acme &lt;b&gt;') && !renderHome({ rows: [], jobs: [] }).includes('Follow up today'));
  const scripts = [renderApply([]), renderFiltered([]), fup, jp2].map((h) => [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n'));
  check('every page script parses (apply, filtered, follow up)', scripts.slice(0, 3).every((src) => { try { new Function(src); return src.length > 0; } catch { return false; } }));
  check('the three tap pages share the APSync helper and post to /api/marks', scripts.slice(0, 3).every((src) => src.includes('var APSync=') && src.includes("'/api/marks'")) && scripts[0].includes("track('apply'") && scripts[1].includes("track('lead'") && scripts[2].includes("track('fu'"));
  if (failures) process.exitCode = 1; else console.log('\nAll self-tests passed.');
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--self-test')) await selfTest();
  else console.log('Usage: node autopilot/site-pages.mjs --self-test');
}
