#!/usr/bin/env node
// @ts-check
// goozali-jobs.mjs — Goozali's job-postings table as a daily intake source (daily.mjs stage "goozali-jobs").
//
// goozali.com embeds ~33k Israeli job postings (Airtable shared view) with title, company, field, minimum
// years of experience, location, posting link and the full description. This reads it once per run and
// adds to data/pipeline.md the postings that:
//   1. were added to the table since the last successful run (first run: last 24h; never more than 4 days)
//   2. pass portals.yml `title_filter` — the same filter every other scanner uses
//   3. ask for ≤ MAX_EXPERIENCE years, or don't say
//   4. aren't from a data/blacklist.md company, and aren't already in the pipeline / scan history / tracker
// Each kept posting's description is saved to jds/ (`{company}-{title}-{sha1(url)[0:10]}.md`, the same
// name triage-run.mjs's prefetch uses), so triage reads it locally instead of fetching an agency page.
// Rows are logged to data/scan-history.tsv with portal `goozali-jobs` (dedup + per-source stats).
//
// One request per run, free. Writes nothing on --dry-run. Never triages, never applies.
//
//   node autopilot/goozali-jobs.mjs [--dry-run] [--since-hours N] [--max-exp N]
//   node autopilot/goozali-jobs.mjs --self-test

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { flagValue, hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { readSharedView } from '../goozali-sync.mjs';
import { buildTitleFilter } from '../title-keywords.mjs';
import { normalizeCompany } from '../tracker-utils.mjs';

const ROOT = getCareerOpsRoot();
export const JOBS_EMBED = 'https://airtable.com/embed/appwewqLk7iUY4azc/shrQBuWjXd0YgPqV6';
export const SOURCE = 'goozali-jobs';
export const MAX_EXPERIENCE = 2;
export const FIRST_RUN_HOURS = 24;
export const MAX_WINDOW_HOURS = 96;
const STATE_FILE = join(ROOT, 'data', 'goozali-jobs-state.json');
const JDS_DIR = join(ROOT, 'jds');

const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return fb; } };

/** Airtable nested payload → plain job objects. Select/multi-select cells hold choice ids → names. Pure. */
export function parseJobs(payload) {
  const cols = payload?.data?.table?.columns ?? [];
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
  const get = (row, name) => {
    const col = byName[name];
    if (!col) return null;
    const v = row.cellValuesByColumnId?.[col.id];
    const choices = col.typeOptions?.choices;
    const name1 = (x) => (choices && choices[x] ? choices[x].name : x);
    if (Array.isArray(v)) return v.map(name1).join(', ');
    return v == null ? null : name1(v);
  };
  return (payload?.data?.table?.rows ?? []).map((r) => {
    const exp = get(r, 'Min Experience (Y)');
    return {
      title: String(get(r, 'Job Title') ?? '').trim(),
      company: String(get(r, 'Company') ?? '').trim(),
      field: get(r, 'Field'),
      location: String(get(r, 'Location') ?? '').trim(),
      url: String(get(r, 'Position Link') ?? '').trim(),
      minExp: exp === null || exp === '' || !Number.isFinite(Number(exp)) ? null : Number(exp),
      posted: get(r, 'Posted'),
      description: String(get(r, 'Job Description') ?? '').trim(),
      requirements: String(get(r, 'Requirements') ?? '').trim(),
      addedAt: r.createdTime ?? null,
    };
  }).filter((j) => j.title && /^https?:\/\//i.test(j.url));
}

/** Window start: the last successful run (capped at MAX_WINDOW_HOURS back), else FIRST_RUN_HOURS. Pure. */
export function windowStart({ lastOkAt = null, sinceHours = null, now = Date.now() } = {}) {
  if (sinceHours) return now - sinceHours * 3_600_000;
  const floor = now - MAX_WINDOW_HOURS * 3_600_000;
  const last = Date.parse(lastOkAt ?? '');
  return Number.isFinite(last) ? Math.max(last, floor) : now - FIRST_RUN_HOURS * 3_600_000;
}

const urlKey = (u) => String(u).trim().replace(/#.*$/, '').replace(/[?&]utm_[^&]+/g, '').replace(/\/+$/, '').toLowerCase();

/**
 * Pure selection. Returns { kept, counts } where counts explains every drop.
 * @param {ReturnType<typeof parseJobs>} jobs
 * `seen` holds keys made by `keyOf` (scan.mjs's normalizeUrlForDedup in real runs).
 * @param {{ since: number, titleOk: (t: string) => boolean, maxExp?: number, seen?: Set<string>, blacklist?: Map<string, any>, keyOf?: (u: string) => string }} o
 */
export function selectJobs(jobs, { since, titleOk, maxExp = MAX_EXPERIENCE, seen = new Set(), blacklist = new Map(), keyOf = urlKey }) {
  const counts = { inWindow: 0, title: 0, experience: 0, blacklisted: 0, seen: 0, kept: 0 };
  const kept = [];
  const batch = new Set();
  for (const j of jobs) {
    if (!(Date.parse(j.addedAt ?? '') >= since)) continue;
    counts.inWindow += 1;
    if (!titleOk(j.title)) { counts.title += 1; continue; }
    if (j.minExp != null && j.minExp > maxExp) { counts.experience += 1; continue; }
    if (blacklist.has(normalizeCompany(j.company))) { counts.blacklisted += 1; continue; }
    const k = keyOf(j.url);
    if (seen.has(k) || batch.has(k)) { counts.seen += 1; continue; }
    batch.add(k);
    kept.push(j);
  }
  counts.kept = kept.length;
  return { kept, counts };
}

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'job';
export const jdFileName = (j) => `${slug(j.company)}-${slug(j.title)}-${createHash('sha1').update(j.url).digest('hex').slice(0, 10)}.md`;

/** The saved JD capture: Goozali's description + requirements, verbatim. Pure. */
export function jdMarkdown(j) {
  return `# ${j.company} — ${j.title}\n\nSource: ${j.url}\nVia: Goozali job listings (added ${String(j.addedAt ?? '').slice(0, 10)})\n`
    + `Location: ${j.location || '—'} · Field: ${j.field ?? '—'} · Min experience: ${j.minExp ?? 'not stated'}\n\n`
    + `## Description\n\n${j.description || '(none given)'}\n\n## Requirements\n\n${j.requirements || '(none given)'}\n`;
}

export async function runGoozaliJobs({ dryRun = false, sinceHours = null, maxExp = MAX_EXPERIENCE, now = Date.now() } = {}) {
  const scan = await import('../scan.mjs'); // heavy; only when actually running
  const config = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf-8'));
  const titleOk = buildTitleFilter(config.title_filter);
  const { seen } = scan.loadSeenUrls(); // already normalized with normalizeUrlForDedup
  const blacklist = scan.loadBlacklist();
  const state = readJson(STATE_FILE, {});
  const since = windowStart({ lastOkAt: state.last_ok_at, sinceHours, now });

  const jobs = parseJobs(await readSharedView(JOBS_EMBED));
  const { kept, counts } = selectJobs(jobs, { since, titleOk, maxExp, seen, blacklist, keyOf: scan.normalizeUrlForDedup });
  const today = new Date(now).toISOString().slice(0, 10);

  if (!dryRun) {
    if (kept.length) {
      mkdirSync(JDS_DIR, { recursive: true });
      for (const j of kept) writeFileSync(join(JDS_DIR, jdFileName(j)), jdMarkdown(j));
      const offers = kept.map((j) => ({ url: j.url, company: j.company, title: j.title, location: j.location, source: SOURCE, description: `${j.description}\n${j.requirements}`, postedAt: Date.parse(j.posted ?? '') || undefined }));
      await scan.appendToPipeline(offers);
      await scan.appendToScanHistory(offers, today);
    }
    mkdirSync(join(ROOT, 'data'), { recursive: true });
    writeFileSync(STATE_FILE, `${JSON.stringify({ last_ok_at: new Date(now).toISOString(), last_added: kept.length }, null, 2)}\n`);
  }
  const hours = Math.round((now - since) / 3_600_000);
  const summary = `${jobs.length} postings in Goozali · ${counts.inWindow} new in the last ${hours}h · ${counts.kept} kept (dropped: ${counts.title} title, ${counts.experience} >${maxExp}y experience, ${counts.seen} already seen, ${counts.blacklisted} blacklisted)${dryRun ? ' · dry-run, nothing written' : ''}`;
  return { kept, counts, summary };
}

// ---------------------------------------------------------------------------

function selfTest() {
  let pass = 0, fail = 0;
  const check = (n, c) => { if (c) pass += 1; else { fail += 1; console.error(`FAIL: ${n}`); } };
  const payload = { data: { table: {
    columns: [
      { id: 't', name: 'Job Title' }, { id: 'c', name: 'Company' }, { id: 'u', name: 'Position Link' }, { id: 'e', name: 'Min Experience (Y)' },
      { id: 'f', name: 'Field', typeOptions: { choices: { sel1: { name: 'Software Engineering' } } } }, { id: 'l', name: 'Location' }, { id: 'd', name: 'Job Description' },
    ],
    rows: [
      { createdTime: '2026-10-06T10:00:00Z', cellValuesByColumnId: { t: 'Junior Python Developer', c: 'Acme', u: 'https://acme.com/j/1', e: 1, f: 'sel1', l: 'Tel Aviv', d: 'Build APIs' } },
      { createdTime: '2026-10-06T11:00:00Z', cellValuesByColumnId: { t: 'Senior Backend Engineer', c: 'Beta', u: 'https://beta.com/j/2', e: 5 } },
      { createdTime: '2026-10-06T12:00:00Z', cellValuesByColumnId: { t: 'AI Engineer', c: 'Gamma', u: 'https://g.com/3' } },
      { createdTime: '2026-10-06T12:00:00Z', cellValuesByColumnId: { t: 'Sales Manager', c: 'Delta', u: 'https://d.com/4', e: 0 } },
      { createdTime: '2026-10-01T12:00:00Z', cellValuesByColumnId: { t: 'Python Developer', c: 'Old', u: 'https://o.com/5', e: 1 } },
      { createdTime: '2026-10-06T12:00:00Z', cellValuesByColumnId: { t: 'Python Developer', c: 'Seen', u: 'https://seen.com/6/' } },
      { createdTime: '2026-10-06T12:00:00Z', cellValuesByColumnId: { t: 'Python Developer', c: 'Bad Co', u: 'https://bad.com/7' } },
      { createdTime: '2026-10-06T12:00:00Z', cellValuesByColumnId: { t: 'No link', c: 'X', u: 'not a url' } },
    ],
  } } };
  const jobs = parseJobs(payload);
  check('parse: rows without a real link dropped', jobs.length === 7);
  check('parse: choice id → name, experience → number', jobs[0].field === 'Software Engineering' && jobs[0].minExp === 1 && jobs[2].minExp === null);
  const now = Date.parse('2026-10-07T09:00:00Z');
  check('window: first run = 24h', windowStart({ now }) === now - 24 * 3_600_000);
  check('window: since last ok run', windowStart({ lastOkAt: '2026-10-06T09:00:00Z', now }) === Date.parse('2026-10-06T09:00:00Z'));
  check('window: capped at 4 days', windowStart({ lastOkAt: '2026-09-01T00:00:00Z', now }) === now - 96 * 3_600_000);
  check('window: --since-hours wins', windowStart({ lastOkAt: '2026-10-06T09:00:00Z', sinceHours: 2, now }) === now - 2 * 3_600_000);
  const titleOk = (t) => /python|backend|ai engineer/i.test(t);
  const { kept, counts } = selectJobs(jobs, { since: windowStart({ now }), titleOk, seen: new Set(['https://seen.com/6']), blacklist: new Map([[normalizeCompany('Bad Co'), {}]]) });
  check('select: keeps junior + unstated experience, in window', kept.map((j) => j.company).join() === 'Acme,Gamma');
  check('select: every drop counted', counts.inWindow === 6 && counts.title === 1 && counts.experience === 1 && counts.seen === 1 && counts.blacklisted === 1 && counts.kept === 2);
  check('jd file: triage-compatible name', /^acme-junior-python-developer-[0-9a-f]{10}\.md$/.test(jdFileName(jobs[0])));
  check('jd text: verbatim description', jdMarkdown(jobs[0]).includes('Build APIs') && jdMarkdown(jobs[0]).includes('Source: https://acme.com/j/1'));
  console.log(`goozali-jobs.mjs self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--self-test')) process.exitCode = selfTest() ? 0 : 1;
  else {
    const r = await runGoozaliJobs({ dryRun: hasFlag(args, '--dry-run'), sinceHours: Number(flagValue(args, '--since-hours')) || null, maxExp: Number(flagValue(args, '--max-exp') ?? MAX_EXPERIENCE) });
    for (const j of r.kept) console.log(`  + ${j.company} — ${j.title} (${j.location || '?'}, exp ${j.minExp ?? '?'})`);
    console.log(r.summary);
  }
}
