#!/usr/bin/env node
// @ts-check
// job-origin.mjs — two facts shown on every job card (web site, phone page, daily email):
//
//   source   where the job came from: the WhatsApp group that shared it, or the scanner that found it,
//            plus the site the posting lives on. Read from data/whatsapp-sources.jsonl and
//            data/scan-history.tsv (the same logs sources.mjs counts); when neither knows the link,
//            only the posting's site is shown and the card says the origin isn't recorded.
//   why      ONE sentence: the strongest reason the candidate fits — or doesn't. Taken from the job's
//            state.json `fit_sentence` when set, else the first sentence of its triage reason
//            (triage-run.mjs asks triage to lead its reason with exactly that sentence).
//
// Read-only. No LLM.
//
//   node autopilot/job-origin.mjs            list every prepared job with its source + why
//   node autopilot/job-origin.mjs --self-test

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { normalizeUrl } from '../url-key.mjs';
import { parseWhatsappSources, parseScanPortals, hostOf } from './sources.mjs';

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf-8') : '');
const safeKey = (u) => { try { return normalizeUrl(u); } catch { return String(u ?? ''); } };

const SITE_NAMES = {
  'linkedin.com': 'LinkedIn', 'comeet.com': 'Comeet', 'google.com': 'Google Careers', 'greenhouse.io': 'Greenhouse',
  'lever.co': 'Lever', 'ashbyhq.com': 'Ashby', 'myworkdayjobs.com': 'Workday', 'amazon.jobs': 'Amazon Jobs',
  'metacareers.com': 'Meta Careers', 'secrethunter.io': 'SecretHunter', 'referally.link': 'Referally',
};

/** Friendly name of the site a posting lives on: linkedin.com → LinkedIn, nvidia.wd5.myworkdayjobs.com → Workday. */
export function siteName(url) {
  const host = hostOf(url);
  if (host === 'unknown') return '';
  const hit = Object.keys(SITE_NAMES).find((d) => host === d || host.endsWith(`.${d}`));
  return hit ? SITE_NAMES[hit] : host;
}

/** scan-history portal id → words: greenhouse-api → Greenhouse, gsheet-csv-api → Google Sheet list. */
export function portalName(portal) {
  const p = String(portal ?? '').replace(/-api$/, '');
  if (p === 'gsheet-csv') return 'Google Sheet list';
  if (p === 'whats-new') return "What's New list";
  if (p === 'goozali-jobs') return 'Goozali job listings';
  return p.split('-').map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ');
}

/** Build a lookup from the source logs once; call it per URL. */
export function sourceIndex(root = getCareerOpsRoot()) {
  const wa = parseWhatsappSources(read(join(root, 'data', 'whatsapp-sources.jsonl')));
  const portals = parseScanPortals(read(join(root, 'data', 'scan-history.tsv')));
  return (url) => {
    const k = safeKey(url);
    return { groups: [...(wa.get(k) ?? [])].map((s) => s.replace(/^whatsapp:/, '')), portal: portals.get(k) ?? null, site: siteName(url) };
  };
}

/** One line: "WhatsApp group “X” · posting on LinkedIn" / "Greenhouse scan" / "LinkedIn (origin not recorded)". */
export function describeSource({ groups = [], portal = null, site = '' } = {}) {
  const found = [];
  if (groups.length) found.push(`WhatsApp group${groups.length > 1 ? 's' : ''} ${groups.map((g) => `“${g}”`).join(', ')}`);
  if (portal) found.push(`${portalName(portal)} scan`);
  if (!found.length) return site ? `${site} (origin not recorded)` : 'Origin not recorded';
  return `${found.join(' + ')}${site && !portal ? ` · posting on ${site}` : ''}`;
}

/** Short provider label for filters: "WhatsApp", "Greenhouse", "LinkedIn"… (the scan wins over the posting's site). */
export function providerName({ groups = [], portal = null, site = '' } = {}) {
  if (groups.length) return 'WhatsApp';
  const name = portal ? portalName(portal) : site || 'Unknown';
  return { 'Amazon Jobs': 'Amazon', 'Goozali job listings': 'Goozali', 'lnkd.in': 'LinkedIn' }[name] ?? name;
}

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** url_key → first day the link reached us: scan-history first_seen, or the WhatsApp message's local day. Earliest wins. */
export function parseFirstSeen(scanTsv, waJsonl) {
  const seen = new Map();
  const keep = (url, day) => {
    if (!url || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    const k = safeKey(url);
    if (!seen.has(k) || day < seen.get(k)) seen.set(k, day);
  };
  const lines = String(scanTsv ?? '').split(/\r?\n/).filter(Boolean);
  const head = (lines[0] ?? '').split('\t'), iUrl = head.indexOf('url'), iSeen = head.indexOf('first_seen');
  if (iUrl >= 0 && iSeen >= 0) for (const l of lines.slice(1)) { const c = l.split('\t'); keep(c[iUrl], String(c[iSeen] ?? '').trim()); }
  for (const line of String(waJsonl ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const { url, ts } = JSON.parse(line); const d = new Date(ts); if (!Number.isNaN(d.getTime())) keep(url, localDay(d)); } catch { /* torn line */ }
  }
  return seen;
}

/** url → { src, date } for the site's filters: provider label + first-seen day ('' when unknown). */
export function originIndex(root = getCareerOpsRoot()) {
  const sourceOf = sourceIndex(root);
  const seen = parseFirstSeen(read(join(root, 'data', 'scan-history.tsv')), read(join(root, 'data', 'whatsapp-sources.jsonl')));
  return (url) => (url ? { src: providerName(sourceOf(url)), date: seen.get(safeKey(url)) ?? '' } : { src: 'Unknown', date: '' });
}

/** The one-sentence fit / no-fit reason. `fit_sentence` wins; else the triage reason's first sentence. */
export function fitSentence({ fit_sentence, triage_reason } = {}) {
  if (fit_sentence && String(fit_sentence).trim()) return String(fit_sentence).trim();
  const r = String(triage_reason ?? '').trim();
  const m = r.match(/^(.{20,}?[.!?])(?:\s+[—–-]\s+|\s+(?=[A-Z֐-׿]))/);
  return m ? m[1] : r;
}

// ---------------------------------------------------------------------------

function selfTest() {
  let pass = 0, fail = 0;
  const check = (n, c) => { if (c) pass += 1; else { fail += 1; console.error(`FAIL: ${n}`); } };
  check('site: LinkedIn', siteName('https://www.linkedin.com/jobs/view/1') === 'LinkedIn');
  check('site: Workday subdomain', siteName('https://nvidia.wd5.myworkdayjobs.com/x') === 'Workday');
  check('site: unknown host kept', siteName('https://careers.glassix.com/j') === 'careers.glassix.com');
  check('portal names', portalName('greenhouse-api') === 'Greenhouse' && portalName('gsheet-csv-api') === 'Google Sheet list');
  check('source: WhatsApp + site', describeSource({ groups: ['Referally Junior 1-2'], site: 'LinkedIn' }) === 'WhatsApp group “Referally Junior 1-2” · posting on LinkedIn');
  check('source: scan', describeSource({ portal: 'workday-api', site: 'Workday' }) === 'Workday scan');
  check('source: both', describeSource({ groups: ['A'], portal: 'lever-api', site: 'Lever' }) === 'WhatsApp group “A” + Lever scan');
  check('source: unknown', describeSource({ site: 'LinkedIn' }) === 'LinkedIn (origin not recorded)');
  check('provider: WhatsApp > scan > site', providerName({ groups: ['A'], portal: 'lever-api' }) === 'WhatsApp' && providerName({ portal: 'greenhouse-api', site: 'Greenhouse' }) === 'Greenhouse' && providerName({ site: 'LinkedIn' }) === 'LinkedIn' && providerName({}) === 'Unknown');
  const fs = parseFirstSeen('url\tfirst_seen\tportal\nhttps://a.com/1\t2026-10-05\tx\nhttps://a.com/1\t2026-10-02\tx\n', '{"url":"https://a.com/2","ts":"2026-10-03T12:00:00.000Z"}\n{bad');
  check('first seen: earliest scan day, WhatsApp day, torn line skipped', fs.get(normalizeUrl('https://a.com/1')) === '2026-10-02' && /^2026-10-0[34]$/.test(fs.get(normalizeUrl('https://a.com/2'))));
  check('why: fit_sentence wins', fitSentence({ fit_sentence: 'You fit.', triage_reason: 'x' }) === 'You fit.');
  check('why: first sentence of the reason', fitSentence({ triage_reason: 'Strong match: Python and agents map to Jeen AI. — Tel Aviv; asks 2 yrs' }) === 'Strong match: Python and agents map to Jeen AI.');
  check('why: old-style reason kept whole', fitSentence({ triage_reason: 'Tel Aviv; direct AI match; asks 2 years' }) === 'Tel Aviv; direct AI match; asks 2 years');
  check('why: empty', fitSentence({}) === '');
  console.log(`job-origin.mjs self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--self-test')) process.exitCode = selfTest() ? 0 : 1;
  else {
    // Reads output/ itself: importing phone-server.mjs here would be a cycle (it imports this module).
    const root = getCareerOpsRoot(), out = join(root, 'output'), sourceOf = sourceIndex(root);
    for (const d of existsSync(out) ? readdirSync(out).filter((n) => /^\d{3,}-/.test(n)).sort() : []) {
      let s; try { s = JSON.parse(readFileSync(join(out, d, 'state.json'), 'utf-8')); } catch { continue; }
      console.log(`#${s.report_num} ${s.company} — ${s.role}\n   source: ${describeSource(sourceOf(s.url))}\n   why:    ${fitSentence(s) || '(none)'}`);
    }
  }
}
