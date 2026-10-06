#!/usr/bin/env node
// @ts-check
// enrich-leads.mjs — fills in Company/Title/Location for bare WhatsApp-intake
// rows in data/pipeline.md, zero LLM tokens, so triage-run.mjs (and any human
// reading the Pending table) has something to score besides a naked URL.
//
// USER LAYER (new file — not a system-layer script). It never edits
// providers/*, scan.mjs, triage-run.mjs, rank-pipeline.mjs, or any modes/*
// file; it imports the ATS JD fetchers those already ship instead of
// re-deriving them.
//
// Why this exists: `node plugins.mjs run whatsapp` queues rows shaped
//   - [ ] https://app.civi.co.il/promo/id=812889&src=10193 |  | Job lead (WhatsApp) | lane: il-source
// with an empty Company cell and a placeholder Title cell ("Job lead
// (WhatsApp)" — the source tag, not a real title) and no Location cell at
// all. triage-run.mjs's own lane routing and JD fetch still work on these
// (classifyLane reads the URL, not the row's cells, and modes/triage.md's
// step 1 has the model fetch the JD itself) — so this is NOT a correctness
// fix for triage; see the Phase A report for what was actually checked.
// It IS a quality-of-life + prompt-quality fix: better `listed company` /
// `listed title` hints in triage-run.mjs's buildTriagePrompt, and a
// pipeline.md that a human can actually scan.
//
// Coverage tiers (see resolveRow for the dispatch order):
//   1. Known ATS JD-text API (greenhouse/lever/ashby/workday) via
//      browser-extract.mjs's fetchJdViaKnownApi — already imported by
//      triage-run.mjs for the same purpose, never re-derived here.
//   2. LinkedIn's unauthenticated jobs-guest HTML endpoint (custom parser
//      below — this host has no JD-text API and isn't covered by tier 1).
//   3. Small number of other host-specific parsers verified against live
//      pages (comeet.com, careers.quality-ai.com, jobs.smartrecruiters.com,
//      careers.qualcomm.com's schema.org JobPosting JSON-LD, app.civi.co.il's
//      Hebrew "מיקום:" convention).
//   4. Generic JSON-LD JobPosting fallback for any other host.
//   5. An explicit skip list for hosts confirmed NOT to carry job data at all
//      (referral/landing pages, login-walled apply-only flows, a
//      career-coaching blog) — reported as skipped-with-reason, never forced.
//
// Usage:
//   node autopilot/enrich-leads.mjs                 # dry-run (default), all bare rows
//   node autopilot/enrich-leads.mjs --limit 20       # dry-run, first 20 only
//   node autopilot/enrich-leads.mjs --host civi.co.il
//   node autopilot/enrich-leads.mjs --write          # actually persist (backs up first)
//   node autopilot/enrich-leads.mjs --self-test       # in-memory suite; no network

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';
import { fetchJdViaKnownApi } from '../browser-extract.mjs';
import { resolveAtsApi, JD_TEXT_API_ATS } from '../liveness-api.mjs';
import { DEFAULT_USER_AGENT, BROWSER_LIKE_USER_AGENT } from '../user-agent.mjs';
import { flagValue, hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = getCareerOpsRoot();
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const BACKUP_PATH = join(ROOT, 'data', 'pipeline.md.pre-enrich.bak');

const PLACEHOLDER_TITLE = 'Job lead (WhatsApp)';
const ANNOTATION_RE = /^(lane|triage|posted|note|trust):/i;
const REQUEST_SPACING_MS = 250; // matches providers/workday.mjs's INTER_PAGE_DELAY_MS
const FETCH_TIMEOUT_MS = 10_000;

const USAGE = `
  enrich-leads.mjs — zero-LLM Company/Title/Location resolver for bare
  WhatsApp-intake rows in data/pipeline.md.

  node autopilot/enrich-leads.mjs [--limit N] [--host <substring>] [--write] [--self-test]

    --limit N       cap how many bare rows to resolve this run
    --host <str>    only resolve rows whose URL hostname contains <str>
    --write         actually persist (default is dry-run; backs up first)
    --self-test     run the in-memory suite (no network, no subprocess)
`;

// ---------------------------------------------------------------------------
// Row selection — scoped strictly to "## Pending" (never "## Processed",
// which uses a different, tracker-like row shape entirely).
// ---------------------------------------------------------------------------

export function extractPendingSection(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((l) => l.trim() === '## Pending');
  if (start === -1) return { startIndex: -1, endIndex: -1, lines: [] };
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  return { startIndex: start, endIndex: end, lines };
}

/**
 * Split a pending row into {checked, url, descriptive, annotations}.
 * `descriptive` is [company, title, location?] before any annotation cell;
 * `annotations` is every cell from the first `label:` cell onward, verbatim.
 * Returns null for a line that isn't a checkbox row at all.
 */
export function splitPendingRow(raw) {
  if (typeof raw !== 'string') return null;
  const checked = raw.startsWith('- [x] ');
  if (!checked && !raw.startsWith('- [ ] ')) return null;
  const cells = raw.slice(6).split('|').map((c) => c.trim());
  const url = cells[0] ?? '';
  let annotStart = cells.length;
  for (let i = 1; i < cells.length; i += 1) {
    if (ANNOTATION_RE.test(cells[i])) { annotStart = i; break; }
  }
  return {
    checked,
    url,
    descriptive: cells.slice(1, annotStart),
    annotations: cells.slice(annotStart),
  };
}

/** True for an unchecked pending row with an empty Company cell and the WhatsApp placeholder Title. */
export function isBareLeadRow(raw) {
  const row = splitPendingRow(raw);
  if (!row || row.checked) return false;
  const [company, title] = row.descriptive;
  return (company ?? '') === '' && (title ?? '').trim() === PLACEHOLDER_TITLE;
}

/** @returns {{raw: string, url: string}[]} bare rows found in "## Pending", in file order. */
export function collectBareRows(text) {
  const { startIndex, endIndex, lines } = extractPendingSection(text);
  if (startIndex === -1) return [];
  const out = [];
  for (let i = startIndex + 1; i < endIndex; i += 1) {
    const raw = lines[i];
    if (isBareLeadRow(raw)) {
      const row = splitPendingRow(raw);
      out.push({ raw, url: row.url });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row rewriting — replaces only the Company/Title/Location cells that were
// unresolved before, leaves the URL and every annotation cell untouched.
// ---------------------------------------------------------------------------

/**
 * @param {string} raw - original pipeline.md line
 * @param {{company?: string, title?: string, location?: string}} resolved
 * @returns {string|null} the new line, or null if nothing would actually change
 */
export function buildEnrichedLine(raw, resolved) {
  const row = splitPendingRow(raw);
  if (!row) return null;
  const [company0, title0, location0] = row.descriptive;
  // The WhatsApp placeholder title is a source tag, not a real title — treat
  // it as "not yet filled" the same way an empty cell is, so enrichment can
  // replace it.
  const existingTitle = (title0 || '').trim() === PLACEHOLDER_TITLE ? '' : (title0 || '').trim();
  const company = (company0 || '').trim() || (resolved.company || '').trim() || '';
  const title = existingTitle || (resolved.title || '').trim() || (title0 || '').trim() || '';
  const location = (location0 || '').trim() || (resolved.location || '').trim() || '';

  const changed = company !== (company0 ?? '') || title !== (title0 ?? '') || location !== (location0 ?? '');
  if (!changed) return null;

  const descriptive = location ? [company, title, location] : [company, title];
  const cells = [row.url, ...descriptive, ...row.annotations];
  const prefix = row.checked ? '- [x] ' : '- [ ] ';
  return `${prefix}${cells.join(' | ')}`;
}

/**
 * Apply resolved enrichments to pipeline.md text. Consumes each `raw` match
 * exactly once (same idempotency rule as triage-run.mjs's applyRowUpdates),
 * so a row that no longer matches (already enriched by a prior run) is
 * silently skipped rather than double-applied.
 * @param {string} text
 * @param {{raw: string, resolved: object}[]} updates
 */
export function applyEnrichments(text, updates) {
  const queue = updates.map((u) => ({ ...u, used: false }));
  let written = 0;
  const out = String(text ?? '')
    .split('\n')
    .map((line) => {
      const hit = queue.find((u) => !u.used && u.raw === line);
      if (!hit) return line;
      const next = buildEnrichedLine(line, hit.resolved);
      if (next === null) return line;
      hit.used = true;
      written += 1;
      return next;
    })
    .join('\n');
  return { text: out, written };
}

// ---------------------------------------------------------------------------
// HTML / text helpers (pure, unit-tested)
// ---------------------------------------------------------------------------

export function stripHtmlTags(s) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractMetaTag(html, property) {
  return stripHtmlTags(extractMetaTagRaw(html, property));
}

/** Same match as extractMetaTag but WITHOUT collapsing whitespace/newlines — needed by
 * parsers (e.g. civi's "מיקום:" line) that rely on a real newline to bound a field. */
export function extractMetaTagRaw(html, property) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i');
  const m = re.exec(String(html ?? ''));
  return m ? m[1] : '';
}

export function extractTitleTag(html) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(String(html ?? ''));
  return m ? stripHtmlTags(m[1]) : '';
}

/** First `application/ld+json` block that parses as a schema.org JobPosting. */
export function extractJsonLdJobPosting(html) {
  const blocks = [...String(html ?? '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  for (const raw of blocks) {
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    const candidates = Array.isArray(json) ? json : [json];
    for (const c of candidates) {
      if (c && (c['@type'] === 'JobPosting' || (Array.isArray(c['@type']) && c['@type'].includes('JobPosting')))) {
        const company = typeof c.hiringOrganization?.name === 'string' ? c.hiringOrganization.name : '';
        let location = '';
        const jobLoc = Array.isArray(c.jobLocation) ? c.jobLocation[0] : c.jobLocation;
        const addr = jobLoc?.address;
        // Schema.org allows addressCountry to be either a plain string or a
        // nested Country object ({ "@type": "Country", "name": "IL" }) —
        // Qualcomm's board uses the latter. Coerce either shape to a string
        // rather than letting an object reach the joined location and print
        // as the literal text "[object Object]".
        const str = (v) => (typeof v === 'string' ? v : typeof v?.name === 'string' ? v.name : '');
        if (addr) {
          location = [str(addr.addressLocality), str(addr.addressRegion), str(addr.addressCountry)].filter(Boolean).join(', ');
        }
        return { title: typeof c.title === 'string' ? c.title.trim() : '', company: company.trim(), location: location.trim() };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-host parsers
// ---------------------------------------------------------------------------

/** comeet.com og:title convention: "Job opportunity: {title} at {COMPANY}". */
export function parseComeetOgTitle(ogTitle) {
  const m = /^job opportunity:\s*(.+?)\s+at\s+(.+)$/i.exec(String(ogTitle ?? '').trim());
  if (!m) return null;
  return { title: m[1].trim(), company: m[2].trim() };
}

/** careers.quality-ai.com: og:title "{reqId} - {title}", <title> "... | QualityAI". */
export function parseQualityAiTitle(ogTitle, titleTag) {
  const stripped = String(ogTitle ?? '').replace(/^\d+\s*-\s*/, '').trim();
  const companyMatch = /\|\s*([^|]+)$/.exec(String(titleTag ?? ''));
  return {
    title: stripped || undefined,
    company: companyMatch ? companyMatch[1].trim() : undefined,
  };
}

/** jobs.smartrecruiters.com: <title> "{Company} {Title} | SmartRecruiters", og:title "{Title}". */
export function parseSmartRecruitersTitle(ogTitle, titleTag) {
  const title = String(ogTitle ?? '').trim();
  let base = String(titleTag ?? '').replace(/\s*\|\s*SmartRecruiters\s*$/i, '').trim();
  let company = base;
  if (title && base.toLowerCase().endsWith(title.toLowerCase())) {
    company = base.slice(0, base.length - title.length).trim();
  }
  return { title: title || undefined, company: company || undefined };
}

/** app.civi.co.il: title from og:title, location from the Hebrew "מיקום:" (or "Location:") line in the description meta. */
export function parseCiviPage(html) {
  const title = extractMetaTag(html, 'og:title') || extractTitleTag(html).replace(/\s*\|\s*Civi\s*$/i, '');
  const desc = extractMetaTagRaw(html, 'og:description') || extractMetaTagRaw(html, 'description');
  const locMatch = /(?:מיקום|location)\s*:\s*([^\n\r|]+)/i.exec(desc);
  return { title: title || undefined, location: locMatch ? locMatch[1].trim().replace(/\*+$/, '').trim() : undefined };
}

/**
 * LinkedIn — classify the pending row's URL before ever fetching it.
 *   - `linkedin.com/jobs/view/(?:.*-)?{id}` (or `?currentJobId={id}`) → a real
 *     job posting, resolvable via the guest endpoint below.
 *   - `linkedin.com/feed/update/...` (and anything else under linkedin.com
 *     that isn't a /jobs/view/ URL) → a feed post shared into the WhatsApp
 *     group, not a job posting at all. No job id to resolve; bucketed
 *     separately rather than forced through the job endpoint.
 *   - `lnkd.in/...` shortlinks resolve (one redirect hop) to one of the above.
 */
export function classifyLinkedInUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { kind: 'unknown' };
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'lnkd.in') return { kind: 'shortlink' };
  if (!/(^|\.)linkedin\.com$/.test(host)) return { kind: 'not-linkedin' };
  const path = u.pathname.match(/^\/jobs\/view\/(?:.*-)?(\d+)\/?$/);
  if (path) return { kind: 'job', id: path[1] };
  const current = u.searchParams.get('currentJobId');
  if (current && /^\d+$/.test(current)) return { kind: 'job', id: current };
  return { kind: 'feed' };
}

// Reject a bullet that isn't actually a place: LinkedIn reuses
// `topcard__flavor--bullet` for the applicant count too ("52 applicants"),
// and a stray malformed nested span can leak through as an empty string. A
// wrong location fed into modes/_brief.md's Israel hard gate is worse than a
// missing one, so this is conservative on purpose (reject on any doubt).
function looksLikeLinkedInPlace(s) {
  return Boolean(s) && !/applicant/i.test(s) && !/^\d/.test(s) && !/<[a-z]/i.test(s);
}

/** Parse LinkedIn's unauthenticated jobs-guest HTML into {title, company, location}. */
export function parseLinkedInGuestHtml(html) {
  const str = String(html ?? '');
  const h2 = /<h2[^>]*class=["'][^"']*top-card[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i.exec(str);
  const org = /topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/i.exec(str);
  const bullets = [...str.matchAll(/topcard__flavor--bullet[^>]*>([\s\S]*?)<\/span>/gi)]
    .map((m) => stripHtmlTags(m[1]))
    .filter(looksLikeLinkedInPlace);
  return {
    title: h2 ? stripHtmlTags(h2[1]) : undefined,
    company: org ? stripHtmlTags(org[1]) : undefined,
    location: bullets[0] || undefined,
  };
}

// ---------------------------------------------------------------------------
// Explicit skip list — hosts verified NOT to carry job data at all. Reported
// as skipped-with-reason, never silently forced through a generic parser.
// ---------------------------------------------------------------------------

const SKIP_HOSTS = [
  {
    test: (h) => h === 'referally.link' || h === 'referally.setmore.com' || h === 'linktr.ee',
    reason: 'referral/landing page, not a job posting (confirmed pattern: a triaged sibling row already got "Not a job posting — CV workshop/course page")',
  },
  {
    test: (h) => h === 'hitkabalta.co.il',
    reason: 'career-coaching blog/marketing site (articles, testimonials) — the WhatsApp-shared URLs are blog/anchor links, not job postings',
  },
  {
    test: (h) => /^talentgrid-[\w-]+\.onrender\.com$/.test(h),
    reason: 'apply-flow / login-walled host — /apply/{token} links redirect to /login with no public job data',
  },
];

export function findSkipReason(host) {
  const hit = SKIP_HOSTS.find((s) => s.test(host));
  return hit ? hit.reason : null;
}

// ---------------------------------------------------------------------------
// Network — one small fetch helper, all resolvers funnel through it.
// ---------------------------------------------------------------------------

async function fetchText(url, { userAgent = DEFAULT_USER_AGENT, redirect = 'follow' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': userAgent, accept: 'text/html,application/json' },
      redirect,
      signal: controller.signal,
    });
    if (redirect === 'manual' && res.status >= 300 && res.status < 400) {
      return { redirectTo: res.headers.get('location') || null };
    }
    if (!res.ok) return null;
    return { text: await res.text(), finalUrl: res.url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {string} lowercased hostname, no leading www. */
export function extractHost(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Resolver dispatch
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{resolved: {company?: string, title?: string, location?: string}|null, skipped?: string, tier: string}>}
 */
export async function resolveRow(url) {
  const host = extractHost(url);
  if (!host) return { resolved: null, skipped: 'unparseable URL', tier: 'n/a' };

  const skipReason = findSkipReason(host);
  if (skipReason) return { resolved: null, skipped: skipReason, tier: 'skip-list' };

  // Tier 1: known ATS JD-text API (greenhouse/lever/ashby/workday).
  const ats = resolveAtsApi(url);
  if (ats && JD_TEXT_API_ATS.has(ats.ats)) {
    const jd = await fetchJdViaKnownApi(url).catch(() => null);
    if (jd) {
      const locMatch = /^Location:\s*(.+)$/im.exec(jd.text || '');
      const company = ats.parts.board || ats.parts.slug || ats.parts.org || ats.parts.tenant || undefined;
      return { resolved: { title: jd.title || undefined, company, location: locMatch ? locMatch[1].trim() : undefined }, tier: `api-jd:${ats.ats}` };
    }
    // fall through to a generic fetch below rather than give up immediately
  }

  // Tier 2: LinkedIn (guest endpoint) / lnkd.in (resolve shortlink first).
  if (host === 'lnkd.in') {
    const redirect = await fetchText(url, { redirect: 'manual' });
    const target = redirect?.redirectTo;
    if (!target) return { resolved: null, skipped: 'lnkd.in shortlink did not resolve', tier: 'linkedin' };
    return resolveRow(target);
  }
  if (/(^|\.)linkedin\.com$/.test(host)) {
    const li = classifyLinkedInUrl(url);
    if (li.kind === 'feed') return { resolved: null, skipped: 'LinkedIn feed post/update, not a job posting — no job id to resolve', tier: 'linkedin' };
    if (li.kind !== 'job') return { resolved: null, skipped: 'unrecognized LinkedIn URL shape', tier: 'linkedin' };
    await sleep(REQUEST_SPACING_MS * 2); // LinkedIn's guest endpoint is rate-limit sensitive; extra spacing
    const res = await fetchText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${li.id}`, { userAgent: BROWSER_LIKE_USER_AGENT });
    if (!res?.text) return { resolved: null, skipped: 'LinkedIn guest endpoint did not answer (rate-limited or blocked)', tier: 'linkedin' };
    const parsed = parseLinkedInGuestHtml(res.text);
    if (!parsed.title && !parsed.company) return { resolved: null, skipped: 'LinkedIn guest endpoint returned a page we could not parse', tier: 'linkedin' };
    return { resolved: parsed, tier: 'linkedin' };
  }

  // Tier 3/4: host-specific + generic fetch.
  const res = await fetchText(url);
  if (!res?.text) return { resolved: null, skipped: 'fetch failed or non-200', tier: 'generic-fetch' };
  const html = res.text;

  if (host === 'app.civi.co.il') {
    const civi = parseCiviPage(html);
    if (civi.title || civi.location) return { resolved: civi, tier: 'civi' };
    // fall through to the generic tiers below rather than give up outright
  }
  if (host === 'comeet.com') {
    const ogTitle = extractMetaTag(html, 'og:title');
    const parsed = parseComeetOgTitle(ogTitle);
    if (parsed) return { resolved: parsed, tier: 'comeet' };
  }
  if (host === 'careers.quality-ai.com') {
    const ogTitle = extractMetaTag(html, 'og:title');
    const titleTag = extractTitleTag(html);
    const parsed = parseQualityAiTitle(ogTitle, titleTag);
    if (parsed.title || parsed.company) return { resolved: parsed, tier: 'quality-ai' };
  }
  if (host === 'jobs.smartrecruiters.com') {
    const ogTitle = extractMetaTag(html, 'og:title');
    const titleTag = extractTitleTag(html);
    const parsed = parseSmartRecruitersTitle(ogTitle, titleTag);
    if (parsed.title || parsed.company) return { resolved: parsed, tier: 'smartrecruiters' };
  }

  // Generic JSON-LD JobPosting fallback (careers.qualcomm.com and any other
  // schema.org-tagged career site we don't have a bespoke parser for).
  const ld = extractJsonLdJobPosting(html);
  if (ld && (ld.title || ld.company || ld.location)) {
    return { resolved: ld, tier: 'json-ld' };
  }

  // Last resort: bare og:title / <title>, no company/location — low
  // confidence, but strictly better than the "Job lead (WhatsApp)" sentinel.
  const ogTitle = extractMetaTag(html, 'og:title') || extractTitleTag(html);
  if (ogTitle) return { resolved: { title: ogTitle }, tier: 'title-only' };

  return { resolved: null, skipped: 'no known parser and no JSON-LD/og:title found', tier: 'unresolved' };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log(USAGE);
    return 0;
  }
  if (hasFlag(argv, '--self-test')) {
    selfTest();
    return 0;
  }
  if (!existsSync(PIPELINE_PATH)) {
    console.log('No data/pipeline.md yet — nothing to enrich.');
    return 0;
  }

  const write = hasFlag(argv, '--write');
  const limit = Number(flagValue(argv, '--limit') ?? Infinity);
  const hostFilter = flagValue(argv, '--host');

  const text = readFileSync(PIPELINE_PATH, 'utf-8');
  let bare = collectBareRows(text);
  if (hostFilter) bare = bare.filter((r) => extractHost(r.url).includes(hostFilter));
  if (Number.isFinite(limit)) bare = bare.slice(0, limit);

  if (!bare.length) {
    console.log('No bare (Company/Title-empty) pending rows match. Nothing to do.');
    return 0;
  }

  console.log(`Resolving ${bare.length} bare row(s)${hostFilter ? ` (host filter: ${hostFilter})` : ''}...\n`);

  const updates = [];
  const tally = new Map(); // tier -> count
  const skippedByReason = new Map();

  for (let i = 0; i < bare.length; i += 1) {
    const { raw, url } = bare[i];
    const { resolved, skipped, tier } = await resolveRow(url);
    tally.set(tier, (tally.get(tier) ?? 0) + 1);

    if (resolved) {
      updates.push({ raw, resolved });
      console.log(`  [${tier}] ${url}`);
      console.log(`      -> company:${resolved.company ?? '-'} | title:${resolved.title ?? '-'} | location:${resolved.location ?? '-'}`);
    } else {
      const key = skipped || 'unresolved';
      skippedByReason.set(key, (skippedByReason.get(key) ?? 0) + 1);
      console.log(`  [skip:${tier}] ${url} — ${skipped}`);
    }

    if (i < bare.length - 1) await sleep(REQUEST_SPACING_MS);
  }

  console.log(`\nResolved ${updates.length} of ${bare.length}.`);
  console.log('By tier:');
  for (const [tier, count] of tally) console.log(`  ${count}x — ${tier}`);
  if (skippedByReason.size) {
    console.log('\nSkip reasons:');
    for (const [reason, count] of skippedByReason) console.log(`  ${count}x — ${reason}`);
  }

  if (!write) {
    console.log('\n[dry-run] no files were changed. Re-run with --write to persist.');
    return 0;
  }

  if (!updates.length) {
    console.log('\nNothing resolved — nothing to write.');
    return 0;
  }

  copyFileSync(PIPELINE_PATH, BACKUP_PATH);
  console.log(`\nBacked up pipeline.md -> ${BACKUP_PATH}`);

  let written = 0;
  await withPipelineLock(PIPELINE_PATH, () => {
    const current = readFileSync(PIPELINE_PATH, 'utf-8');
    const result = applyEnrichments(current, updates);
    written = result.written;
    if (written) writeFileSync(PIPELINE_PATH, result.text);
  });

  console.log(`Wrote ${written} enriched row(s) to ${PIPELINE_PATH}.`);
  return 0;
}

// ---------------------------------------------------------------------------
// Self-test — in-memory, no network, no subprocess
// ---------------------------------------------------------------------------

function selfTest() {
  let failures = 0;
  const check = (name, cond) => {
    if (!cond) { console.error(`FAIL: ${name}`); failures += 1; }
    else console.log(`ok: ${name}`);
  };

  // --- row selection ---
  const bareRaw = '- [ ] https://app.civi.co.il/promo/id=812889&src=10193 |  | Job lead (WhatsApp) | lane: il-source';
  const healthyRaw = '- [ ] https://job-boards.greenhouse.io/acme/jobs/1 | Acme | Engineer | Tel Aviv | posted: 2026-01-01 | lane: api-jd';
  const doneRaw = '- [x] https://x.com/a |  | Job lead (WhatsApp) | lane: il-source | triage: SKIP 0/5 — dead';

  check('isBareLeadRow: true for bare row', isBareLeadRow(bareRaw));
  check('isBareLeadRow: false for a healthy row', !isBareLeadRow(healthyRaw));
  check('isBareLeadRow: false once checked/terminal', !isBareLeadRow(doneRaw));

  const pendingFixture = [
    '# Pipeline',
    '## Pending',
    healthyRaw,
    bareRaw,
    '## Processed',
    '- [x] [1](../reports/1-x.md) | https://y.com | | Job lead (WhatsApp) | 1.0/5 | PDF ❌',
  ].join('\n');
  const bareRows = collectBareRows(pendingFixture);
  check('collectBareRows finds exactly the one bare Pending row', bareRows.length === 1 && bareRows[0].url.includes('civi'));
  check('collectBareRows never reaches into Processed', !bareRows.some((r) => r.url.includes('y.com')));

  // --- row rewriting ---
  const enriched = buildEnrichedLine(bareRaw, { title: 'Mold Technician', location: 'Emek Hefer' });
  check('buildEnrichedLine fills title+location, keeps url+lane', enriched
    && enriched.includes('| Mold Technician | Emek Hefer | lane: il-source')
    && enriched.startsWith('- [ ] https://app.civi.co.il/promo/id=812889&src=10193'));
  check('buildEnrichedLine returns null when nothing resolved', buildEnrichedLine(bareRaw, {}) === null);
  check('buildEnrichedLine never overwrites an already-filled cell', (() => {
    const r = buildEnrichedLine(healthyRaw, { company: 'Someone Else', title: 'Other Title' });
    return r === null; // both cells already non-empty -> no change
  })());

  const applied = applyEnrichments(pendingFixture, [{ raw: bareRaw, resolved: { title: 'Mold Technician', location: 'Emek Hefer' } }]);
  check('applyEnrichments writes exactly one row', applied.written === 1);
  check('applyEnrichments leaves the healthy row untouched', applied.text.includes(healthyRaw));
  check('applyEnrichments is idempotent on a second pass', applyEnrichments(applied.text, [{ raw: bareRaw, resolved: { title: 'x' } }]).written === 0);

  // --- host helpers ---
  check('extractHost strips www', extractHost('https://www.comeet.com/jobs/x/1') === 'comeet.com');
  check('extractHost handles bad input', extractHost('not a url') === '');
  check('findSkipReason: referally.link', typeof findSkipReason('referally.link') === 'string');
  check('findSkipReason: talentgrid subdomain pattern', typeof findSkipReason('talentgrid-81ab.onrender.com') === 'string');
  check('findSkipReason: unlisted host', findSkipReason('example.com') === null);

  // --- per-host parsers, fixtures modeled on real captured pages ---
  check('parseComeetOgTitle splits title/company', (() => {
    const p = parseComeetOgTitle('Job opportunity: System Validation Engineer at DRIVENETS');
    return p && p.title === 'System Validation Engineer' && p.company === 'DRIVENETS';
  })());
  check('parseComeetOgTitle rejects an unrelated og:title', parseComeetOgTitle('Spark Hire Recruit Jobs') === null);

  check('parseQualityAiTitle strips req id and reads company from <title>', (() => {
    const p = parseQualityAiTitle('23371 - Automation Engineer - Python', '23371 - Automation Engineer - Python Job Details | QualityAI');
    return p.title === 'Automation Engineer - Python' && p.company === 'QualityAI';
  })());

  check('parseSmartRecruitersTitle splits company from title', (() => {
    const p = parseSmartRecruitersTitle('QA Engineer', 'Check Point Software Technologies QA Engineer | SmartRecruiters');
    return p.title === 'QA Engineer' && p.company === 'Check Point Software Technologies';
  })());

  const civiHtml = `<title>טכנאי/ת תבניות | Civi</title>
    <meta property='og:title' content='טכנאי/ת תבניות'>
    <meta property='og:description' content='מיקום: אזור עמק חפר\nסוג משרה: מלאה'>`;
  check('parseCiviPage reads og:title and the Hebrew מיקום: line', (() => {
    const p = parseCiviPage(civiHtml);
    return p.title === 'טכנאי/ת תבניות' && p.location === 'אזור עמק חפר';
  })());

  const jsonLdHtml = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'http://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
    hiringOrganization: { name: 'Qualcomm Israel Ltd.' },
    jobLocation: { address: { addressLocality: 'Hod HaSharon', addressCountry: 'Israel' } },
  })}</script>`;
  check('extractJsonLdJobPosting reads title/company/location', (() => {
    const ld = extractJsonLdJobPosting(jsonLdHtml);
    return ld && ld.title === 'AI Engineer' && ld.company === 'Qualcomm Israel Ltd.' && ld.location === 'Hod HaSharon, Israel';
  })());
  check('extractJsonLdJobPosting returns null with no JobPosting block', extractJsonLdJobPosting('<script type="application/ld+json">{"@type":"Organization"}</script>') === null);

  check('classifyLinkedInUrl: /jobs/view/{id}', classifyLinkedInUrl('https://www.linkedin.com/jobs/view/4457692970').kind === 'job');
  check('classifyLinkedInUrl: /jobs/view/{slug}-{id}', classifyLinkedInUrl('https://www.linkedin.com/jobs/view/qa-engineer-4457692970').id === '4457692970');
  check('classifyLinkedInUrl: feed post', classifyLinkedInUrl('https://www.linkedin.com/feed/update/urn:li:activity:123').kind === 'feed');
  check('classifyLinkedInUrl: lnkd.in shortlink', classifyLinkedInUrl('https://lnkd.in/p/abc').kind === 'shortlink');
  check('classifyLinkedInUrl: non-linkedin host', classifyLinkedInUrl('https://example.com/jobs/view/1').kind === 'not-linkedin');

  const liHtml = `<h2 class="top-card-layout__title">Data Analyst</h2>
    <a class="topcard__org-name-link">PassportCard</a>
    <span class="topcard__flavor--bullet">Netanya, Center District, Israel</span>
    <span class="topcard__flavor--bullet">52 applicants</span>`;
  check('parseLinkedInGuestHtml reads title/company and skips the applicant-count bullet', (() => {
    const p = parseLinkedInGuestHtml(liHtml);
    return p.title === 'Data Analyst' && p.company === 'PassportCard' && p.location === 'Netanya, Center District, Israel';
  })());
  check('parseLinkedInGuestHtml never picks an applicant-count bullet as location', (() => {
    const p = parseLinkedInGuestHtml('<span class="topcard__flavor--bullet">52 applicants</span>');
    return p.location === undefined;
  })());

  if (failures > 0) {
    console.error(`\n${failures} self-test failure(s)`);
    process.exitCode = 1;
  } else {
    console.log('\nAll self-tests passed.');
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
