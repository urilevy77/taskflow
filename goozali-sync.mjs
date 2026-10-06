#!/usr/bin/env node
/**
 * goozali-sync.mjs — keep portals.yml fed from the Goozali Israeli-company directory.
 *
 * WHY THIS IS NOT A PROVIDER: goozali.com publishes *companies*, not postings.
 * A `providers/*.mjs` module must return Job objects (providers/_types.js), and
 * a company row is not a job. What this directory is good for is the layer
 * above the scanner — deciding which employer boards `scan.mjs` should visit.
 * So this is a maintenance script you run occasionally, not a scan source.
 *
 * WHAT IT DOES
 *   1. Reads the public Airtable view behind goozali.com (990+ Israeli
 *      companies, each with a careers URL and a "Hiring" flag).
 *   2. Keeps rows that are flagged hiring and whose careers URL resolves to a
 *      provider career-ops already ships.
 *   3. Drops the ones already in portals.yml.
 *   4. Prints the remainder as a ready-to-paste tracked_companies block
 *      (or writes it in place with --apply).
 *
 * HOW THE AIRTABLE READ WORKS (each step was a distinct failure to get here):
 *   - The REST path keys on the VIEW id (`viw…`), not the share id (`shr…`);
 *     the share id only addresses the embed page. Using the share id returns
 *     INVALID_MODEL_ID.
 *   - `x-time-zone` is mandatory; without it the API returns BAD_REQUEST.
 *   - Authorization is the `accessPolicy` blob embedded in the embed page's
 *     HTML, passed straight back as a query parameter.
 *   - `stringifiedObjectParams` must request the nested response format.
 *
 * FRAGILITY, STATED PLAINLY: this reads a private API that Airtable does not
 * document and can change without notice, and only the company-directory view
 * is public (goozali's other embedded views return 401). Treat a failure here
 * as "the source moved", not as a career-ops bug. Nothing else depends on it.
 *
 * Usage:
 *   node goozali-sync.mjs              # report new companies, write nothing
 *   node goozali-sync.mjs --apply      # insert them into portals.yml
 *   node goozali-sync.mjs --json       # machine-readable
 */

import fs from 'node:fs';
import * as yaml from 'js-yaml';
import { loadProviders, resolveProvider } from './providers/_registry.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const SHARE_ID = 'shrNtlFxOG2ag1kyB';
const EMBED = `https://airtable.com/embed/${SHARE_ID}`;
const UA = 'Mozilla/5.0';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const JSON_OUT = argv.includes('--json');

/** Pull the three values the data call needs out of the embed page HTML. */
export function extractViewParams(html) {
  const pick = (re) => { const m = re.exec(html); return m ? m[1] : null; };
  return {
    appId: pick(/"applicationId"\s*:\s*"([^"]+)"/),
    accessPolicy: pick(/accessPolicy=([^"'&<>\\ ]+)/),
    // Prefer the id inside the page's OWN readSharedViewData URL — a bare
    // `viw…` match can pick up an unrelated view referenced elsewhere.
    viewId: pick(/\/v0\.3\\u002Fview\\u002F(viw[A-Za-z0-9]{14})/) || pick(/(viw[A-Za-z0-9]{14})/),
  };
}

/** Map an Airtable nested-format payload to {company, careersUrl, hiring} rows. */
export function parseDirectory(payload) {
  const columns = payload?.data?.table?.columns ?? [];
  const rows = payload?.data?.table?.rows ?? [];
  const nameById = Object.fromEntries(columns.map((c) => [c.id, c.name]));
  const cell = (row, wanted) => {
    for (const [id, value] of Object.entries(row.cellValuesByColumnId ?? {})) {
      if (nameById[id] === wanted) return value;
    }
    return null;
  };
  return rows.map((r) => ({
    company: cell(r, 'Company'),
    careersUrl: cell(r, 'Careers URL'),
    hiring: cell(r, 'Hiring') === true || cell(r, 'Hiring') === 'Yes',
  })).filter((r) => r.company && r.careersUrl);
}

async function fetchDirectory() {
  const html = await (await fetch(EMBED, { headers: { 'user-agent': UA } })).text();
  const { appId, accessPolicy, viewId } = extractViewParams(html);
  if (!appId || !accessPolicy || !viewId) {
    throw new Error('goozali-sync: could not extract view params from the embed page — the page shape changed');
  }
  const url = `https://airtable.com/v0.3/view/${viewId}/readSharedViewData`
    + `?stringifiedObjectParams=${encodeURIComponent('{"shouldUseNestedResponseFormat":true}')}`
    + `&requestId=req${Math.random().toString(36).slice(2, 12)}`
    + `&accessPolicy=${accessPolicy}`;
  const res = await fetch(url, {
    headers: {
      'x-airtable-application-id': appId,
      'x-time-zone': 'Asia/Jerusalem',
      'x-user-locale': 'en',
      accept: 'application/json',
      'user-agent': UA,
    },
  });
  if (res.status === 401) {
    throw new Error(
      'goozali-sync: HTTP 401 from readSharedViewData.\n'
      + '  This is almost always throttling, not a broken script: Airtable flags the\n'
      + '  caller after a burst of shared-view reads and then rejects the accessPolicy\n'
      + '  token even though the embed page still hands one out. Verified behaviour —\n'
      + '  the same call returned 990 rows before the throttle and 401 after it.\n'
      + '  Wait (hours, not seconds) and re-run. Run it at most once a day; the\n'
      + '  directory changes slowly and there is nothing to gain from polling it.',
    );
  }
  if (!res.ok) throw new Error(`goozali-sync: readSharedViewData returned HTTP ${res.status}`);
  return parseDirectory(await res.json());
}

function yamlBlock(entries, today) {
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  const head = `\n  # ── Israeli companies from the Goozali directory (added ${today}) ──\n`
    + `  # Added by goozali-sync.mjs. Boards belonging to global parents are global —\n`
    + `  # the Israel allow-list in location_filter is what keeps them in scope.\n`;
  return head + '\n' + entries.map((c) => `  - name: ${q(c.company)}
    careers_url: ${c.careersUrl}
    notes: "Israeli company via goozali.com directory (${today}); provider: ${c.providerId}."
    enabled: true
`).join('\n') + '\n';
}

async function main() {
  const root = getCareerOpsRoot();
  const portalsPath = `${root}/portals.yml`;
  const cfg = yaml.load(fs.readFileSync(portalsPath, 'utf8'));
  const known = new Set([...(cfg.tracked_companies ?? []), ...(cfg.job_boards ?? [])]
    .map((e) => String(e.name ?? '').toLowerCase().trim()));

  const providers = await loadProviders(`${root}/providers`);
  const rows = await fetchDirectory();

  const candidates = [];
  let hiring = 0, unclaimed = 0;
  for (const r of rows) {
    if (!r.hiring) continue;
    hiring++;
    const resolved = resolveProvider({ name: r.company, careers_url: r.careersUrl }, providers);
    const id = resolved?.provider?.id;
    // local-parser claims almost anything; it is not evidence of a real board.
    if (!id || id === 'local-parser') { unclaimed++; continue; }
    if (known.has(String(r.company).toLowerCase().trim())) continue;
    candidates.push({ ...r, providerId: id });
  }

  const summary = {
    directoryRows: rows.length,
    hiring,
    noProvider: unclaimed,
    alreadyTracked: hiring - unclaimed - candidates.length,
    newCandidates: candidates.length,
    applied: false,
  };

  if (APPLY && candidates.length) {
    const today = new Date().toISOString().slice(0, 10);
    const text = fs.readFileSync(portalsPath, 'utf8');
    const at = text.indexOf('\njob_boards:');
    if (at === -1) throw new Error('goozali-sync: no `job_boards:` anchor in portals.yml');
    fs.writeFileSync(portalsPath, text.slice(0, at) + '\n' + yamlBlock(candidates, today) + text.slice(at));
    summary.applied = true;
  }

  if (JSON_OUT) { console.log(JSON.stringify({ ...summary, candidates }, null, 2)); return; }

  console.log('\nGoozali directory sync');
  console.log('─'.repeat(40));
  console.log(`Directory rows:        ${summary.directoryRows}`);
  console.log(`  flagged hiring:      ${summary.hiring}`);
  console.log(`  no provider claims:  ${summary.noProvider}`);
  console.log(`  already tracked:     ${summary.alreadyTracked}`);
  console.log(`  NEW candidates:      ${summary.newCandidates}`);
  if (!candidates.length) { console.log('\nNothing new to add.'); return; }
  candidates.slice(0, 20).forEach((c) => console.log(`  + ${c.company} [${c.providerId}]`));
  if (candidates.length > 20) console.log(`  … and ${candidates.length - 20} more`);
  console.log(summary.applied
    ? '\n✅ Written to portals.yml — run `node validate-portals.mjs` next.'
    : '\nRe-run with --apply to insert these into portals.yml.');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
