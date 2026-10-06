#!/usr/bin/env node
// @ts-check
// sources.mjs — which platforms and WhatsApp groups actually produce applications
// (design/daily-task-design.md §12).
//
// Per source: found → PASS → prepared → applied → responded → interview.
//   source = whatsapp:<group>   from data/whatsapp-sources.jsonl (written by plugins.local/whatsapp/watch.mjs;
//                               links collected before 2026-09-30 have no group → "whatsapp (group unknown)")
//          | <portal>           from data/scan-history.tsv (greenhouse-api, ashby-api, comeet, …)
//          | <host>             fallback: the link's own site (linkedin.com, …)
// A job seen in two sources counts for BOTH — a duplicate marked `dup-of:` credits its own source to the
// row it duplicates, so being second never penalises a source.
//
// Read-only over the user's files. `--write` stores the result at data/runs/sources.json (read by the
// daily email and /autopilot/runs).
//
//   node autopilot/sources.mjs [--json] [--write]
//   node autopilot/sources.mjs --self-test

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { normalizeUrl } from '../url-key.mjs';
import { parsePipelineRow } from './prepare.mjs';

const ROOT = getCareerOpsRoot();

export const WA_UNKNOWN = 'whatsapp (group unknown)';
const APPLIED = new Set(['applied', 'responded', 'interview', 'offer', 'hired', 'rejected']);
const RESPONDED = new Set(['responded', 'interview', 'offer', 'hired', 'rejected']);
const INTERVIEW = new Set(['interview', 'offer', 'hired']);

const safeKey = (u) => { try { return normalizeUrl(u); } catch { return String(u ?? ''); } };

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return 'unknown'; }
}

/** url_key → Set of "whatsapp:<group>" from the append-only source log. */
export function parseWhatsappSources(text) {
  const map = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const { url, group } = JSON.parse(line);
      if (!url || !group) continue;
      const k = safeKey(url);
      if (!map.has(k)) map.set(k, new Set());
      map.get(k).add(`whatsapp:${String(group).trim()}`);
    } catch { /* a torn line in an append-only log is skipped, never fatal */ }
  }
  return map;
}

/** url_key → portal, from scan-history.tsv (header-driven). */
export function parseScanPortals(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return new Map();
  const head = lines[0].split('\t');
  const iUrl = head.indexOf('url'), iPortal = head.indexOf('portal');
  const map = new Map();
  if (iUrl < 0 || iPortal < 0) return map;
  for (const l of lines.slice(1)) {
    const c = l.split('\t');
    if (c[iUrl] && c[iPortal]) map.set(safeKey(c[iUrl]), c[iPortal].trim());
  }
  return map;
}

/** url_key → lowercase status, from the applications.md table (uses its URL + Status columns). */
export function parseTrackerStatuses(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const hi = lines.findIndex((l) => /^\|\s*#\s*\|/.test(l));
  if (hi < 0) return new Map();
  const head = lines[hi].split('|').map((c) => c.trim().toLowerCase());
  const iUrl = head.indexOf('url'), iStatus = head.indexOf('status');
  const map = new Map();
  if (iUrl < 0 || iStatus < 0) return map;
  for (const l of lines.slice(hi + 2)) {
    if (!l.startsWith('|')) continue;
    const c = l.split('|').map((x) => x.trim());
    const url = c[iUrl]?.match(/https?:\/\/\S+/)?.[0];
    if (url) map.set(safeKey(url), c[iStatus].replace(/\*/g, '').toLowerCase());
  }
  return map;
}

/**
 * @param {{ pipelineText: string, waText?: string, historyText?: string, trackerText?: string, preparedKeys?: Set<string> }} src
 * @returns {{ source: string, found: number, pass: number, prepared: number, applied: number, responded: number, interview: number }[]}
 */
export function computeFunnel({ pipelineText, waText = '', historyText = '', trackerText = '', preparedKeys = new Set() }) {
  const wa = parseWhatsappSources(waText);
  const portals = parseScanPortals(historyText);
  const tracker = parseTrackerStatuses(trackerText);

  const sourcesOfUrl = (url) => {
    const k = safeKey(url);
    const s = new Set(wa.get(k) ?? []);
    if (portals.has(k)) s.add(portals.get(k));
    if (!s.size) s.add(hostOf(url) === 'unknown' ? 'unknown' : (/whatsapp|wa\.me|chat\./.test(url) ? WA_UNKNOWN : hostOf(url)));
    return s;
  };

  /** @type {Map<string, {url: string, pass: boolean, sources: Set<string>}>} */
  const jobs = new Map();
  const dupOf = [];
  for (const line of String(pipelineText ?? '').split(/\r?\n/)) {
    const row = parsePipelineRow(line);
    if (!row) continue;
    const dm = line.match(/\|\s*dup-of:\s*(https?:\/\/\S+)/);
    if (dm) { dupOf.push({ from: row.url, to: dm[1] }); continue; }
    jobs.set(safeKey(row.url), { url: row.url, pass: row.triage?.verdict === 'PASS', sources: sourcesOfUrl(row.url) });
  }
  for (const { from, to } of dupOf) {
    const target = jobs.get(safeKey(to));
    if (target) for (const s of sourcesOfUrl(from)) target.sources.add(s);
  }

  const table = new Map();
  const bump = (source, field) => {
    if (!table.has(source)) table.set(source, { source, found: 0, pass: 0, prepared: 0, applied: 0, responded: 0, interview: 0 });
    table.get(source)[field] += 1;
  };
  for (const [key, job] of jobs) {
    const status = tracker.get(key) ?? '';
    for (const s of job.sources) {
      bump(s, 'found');
      if (job.pass) bump(s, 'pass');
      if (preparedKeys.has(key)) bump(s, 'prepared');
      if (APPLIED.has(status)) bump(s, 'applied');
      if (RESPONDED.has(status)) bump(s, 'responded');
      if (INTERVIEW.has(status)) bump(s, 'interview');
    }
  }
  return [...table.values()].sort((a, b) => b.applied - a.applied || b.pass - a.pass || b.found - a.found);
}

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf-8') : '');

export function computeFromDisk(root = ROOT) {
  const outDir = join(root, 'output');
  const preparedKeys = new Set();
  if (existsSync(outDir)) {
    for (const d of readdirSync(outDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try { const s = JSON.parse(readFileSync(join(outDir, d.name, 'state.json'), 'utf-8')); if (s.url_key) preparedKeys.add(s.url_key); } catch { /* no state */ }
    }
  }
  const trackerPath = existsSync(join(root, 'data', 'applications.md')) ? join(root, 'data', 'applications.md') : join(root, 'applications.md');
  return computeFunnel({
    pipelineText: read(join(root, 'data', 'pipeline.md')),
    waText: read(join(root, 'data', 'whatsapp-sources.jsonl')),
    historyText: read(join(root, 'data', 'scan-history.tsv')),
    trackerText: read(trackerPath),
    preparedKeys,
  });
}

export function formatTable(rows) {
  const head = ['source', 'found', 'PASS', 'prep', 'applied', 'resp', 'intv'];
  const body = rows.map((r) => [r.source, r.found, r.pass, r.prepared, r.applied, r.responded, r.interview].map(String));
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  return [line(head), ...body.map(line)].join('\n');
}

// ---------------------------------------------------------------------------

function selfTest() {
  let pass = 0, fail = 0;
  const check = (n, c) => { if (c) pass += 1; else { fail += 1; console.error(`FAIL: ${n}`); } };

  const wa = parseWhatsappSources(['{"url":"https://www.linkedin.com/jobs/view/1","group":"Junior Jobs IL"}', 'torn line {', '{"url":"https://www.linkedin.com/jobs/view/2","group":"AI Jobs"}'].join('\n'));
  check('parses the source log, skips torn lines', wa.size === 2 && wa.get(safeKey('https://www.linkedin.com/jobs/view/1')).has('whatsapp:Junior Jobs IL'));

  const portals = parseScanPortals('url\tfirst_seen\tportal\ntitle\nhttps://jobs.lever.co/acme/1\t2026-09-18\tlever-api\n');
  check('parses portals by header', portals.get(safeKey('https://jobs.lever.co/acme/1')) === 'lever-api');

  const tracker = parseTrackerStatuses('| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | d | A | R | 4/5 | **Applied** | x | [1](r) | n | https://jobs.lever.co/acme/1 |\n| 2 | d | B | R | 4/5 | Interview | x | [2](r) | n | https://www.linkedin.com/jobs/view/1 |\n| 3 | d | C | R | 4/5 | Evaluated | x | [3](r) | n | https://x.com/3 |\n');
  check('parses tracker statuses (bold stripped)', tracker.get(safeKey('https://jobs.lever.co/acme/1')) === 'applied' && tracker.size === 3);

  const pipe = [
    '- [ ] https://jobs.lever.co/acme/1 | Acme | Backend | TLV | lane: il-source | triage: PASS 4.0/5 — fit',
    '- [x] https://www.linkedin.com/jobs/view/1 | Acme | Backend | TLV | dup-of: https://jobs.lever.co/acme/1',
    '- [ ] https://www.linkedin.com/jobs/view/2 | Beta | AI Eng | TLV | lane: agent-fetch | triage: FAIL 2.0/5 — no',
    '- [ ] https://x.com/3 | C | Dev | TLV | triage: PASS 3.5/5 — ok',
  ].join('\r\n');
  const rows = computeFunnel({ pipelineText: pipe, waText: [...wa.keys()].length ? '{"url":"https://www.linkedin.com/jobs/view/1","group":"Junior Jobs IL"}\n{"url":"https://www.linkedin.com/jobs/view/2","group":"AI Jobs"}' : '', historyText: 'url\tfirst_seen\tportal\nhttps://jobs.lever.co/acme/1\td\tlever-api\n', trackerText: 'x', preparedKeys: new Set([safeKey('https://jobs.lever.co/acme/1')]) });
  const by = Object.fromEntries(rows.map((r) => [r.source, r]));
  check('a duplicate credits its own source to the kept job', by['whatsapp:Junior Jobs IL']?.found === 1 && by['lever-api']?.found === 1);
  check('both sources get PASS + prepared credit', by['whatsapp:Junior Jobs IL'].pass === 1 && by['whatsapp:Junior Jobs IL'].prepared === 1 && by['lever-api'].prepared === 1);
  check('FAIL row counts as found only', by['whatsapp:AI Jobs'].found === 1 && by['whatsapp:AI Jobs'].pass === 0);
  check('fallback source is the link host', by['x.com']?.found === 1);
  const applied = computeFunnel({ pipelineText: pipe, historyText: 'url\tf\tportal\nhttps://jobs.lever.co/acme/1\td\tlever-api\n', trackerText: '| # | Status | URL |\n|---|---|---|\n| 1 | Interview | https://jobs.lever.co/acme/1 |\n', preparedKeys: new Set() });
  const lv = applied.find((r) => r.source === 'lever-api');
  check('applied / responded / interview funnel', lv.applied === 1 && lv.responded === 1 && lv.interview === 1);
  check('table formats', formatTable(rows).split('\n').length === rows.length + 1);
  check('empty input is safe', computeFunnel({ pipelineText: '' }).length === 0);

  console.log(`sources.mjs self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--self-test')) process.exitCode = selfTest() ? 0 : 1;
  else {
    const rows = computeFromDisk();
    if (hasFlag(args, '--write')) {
      mkdirSync(join(ROOT, 'data', 'runs'), { recursive: true });
      writeFileSync(join(ROOT, 'data', 'runs', 'sources.json'), JSON.stringify({ generated_at: new Date().toISOString(), rows }, null, 2));
    }
    console.log(hasFlag(args, '--json') ? JSON.stringify(rows, null, 2) : formatTable(rows));
  }
}
