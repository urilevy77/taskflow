// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Published Google Sheet provider — reads a sheet that anyone with the link can
// view, via its built-in CSV export, and maps the rows to Job objects.
//
// WHY THIS EXISTS: a large part of the junior/entry market circulates as
// curated community spreadsheets rather than employer ATS boards. Those rows
// are already structured (one posting per row, a column per field), so they
// need no scraping and no LLM — just the sheet's own `export?format=csv`
// endpoint, which is public for any link-shared sheet.
//
// Wire in via a `job_boards:` entry with an explicit `provider: gsheet-csv`:
//
//   - name: Secret Hunter — Open Junior Positions
//     provider: gsheet-csv
//     careers_url: https://docs.google.com/spreadsheets/d/{ID}/edit?gid=232532044
//     gid: "232532044"              # optional; also read from the URL's #gid=/?gid=
//     enabled: true
//
// There is deliberately NO auto-detect: a docs.google.com URL says nothing
// about whether the sheet is a job table, so claiming one by host alone would
// hand this provider every spreadsheet a user ever pastes. `provider:` is
// required, which is the same rule successfactors.mjs and phenom.mjs apply to
// branded tenants.
//
// COLUMN MAPPING: the header row is found by scanning for the first row that
// resolves both a title-ish and a url-ish column, so the preamble rows these
// sheets usually carry (title banner, "last update", chat invite links) are
// skipped without configuration. Override the aliases per entry with a
// `columns:` block when a sheet uses unusual header text.

const HOST = 'docs.google.com';

/** Header text (lowercased) → canonical field. */
const COLUMN_ALIASES = {
  title: 'title', 'job title': 'title', role: 'title', position: 'title', job: 'title',
  company: 'company', employer: 'company', organisation: 'company', organization: 'company',
  location: 'location', city: 'location', area: 'location', region: 'location',
  url: 'url', link: 'url', 'job url': 'url', 'job link': 'url', apply: 'url', 'apply link': 'url',
  'posted time': 'posted', posted: 'posted', 'posted date': 'posted', date: 'posted', published: 'posted',
  seniority: 'seniority', level: 'seniority', experience: 'seniority',
  skills: 'skills', stack: 'skills', tags: 'skills',
};

/**
 * Minimal RFC4180 CSV parser — handles quoted fields, embedded commas,
 * escaped `""` quotes and both newline conventions. Written here rather than
 * pulled in as a dependency because the scanner core takes no new deps.
 *
 * @param {string} text - Raw CSV.
 * @returns {string[][]} Rows of trimmed cells.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  row.push(field);
  rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

/**
 * Locate the header row and build a canonical-field → column-index map.
 * Returns null when no row resolves both a title and a url column — that is
 * the signal the sheet is not a job table, and the caller throws rather than
 * emitting rows parsed against guessed columns.
 *
 * @param {string[][]} rows
 * @param {Record<string, string>} [overrides] - Extra header→field aliases.
 * @returns {{ index: number, map: Record<string, number> } | null}
 */
export function detectHeader(rows, overrides = {}) {
  const aliases = { ...COLUMN_ALIASES, ...overrides };
  for (let i = 0; i < rows.length; i++) {
    /** @type {Record<string, number>} */
    const map = {};
    rows[i].forEach((cell, col) => {
      const field = aliases[cell.toLowerCase()];
      if (field && map[field] == null) map[field] = col; // first occurrence wins
    });
    if (map.title != null && map.url != null) return { index: i, map };
  }
  return null;
}

/**
 * Resolve the sheet id and gid from an entry, accepting either a normal
 * share/edit URL or a pre-built export URL.
 *
 * @param {{ careers_url?: string, api?: string, gid?: string|number, sheet_id?: string }} entry
 * @returns {{ id: string, gid: string|null } | null}
 */
export function resolveSheet(entry) {
  const raw = String(entry.api || entry.careers_url || '');
  const id = entry.sheet_id || (raw.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/) || [])[1];
  if (!id) return null;
  const fromUrl = (raw.match(/[#?&]gid=(\d+)/) || [])[1];
  const gid = entry.gid != null ? String(entry.gid) : (fromUrl ?? null);
  return { id, gid };
}

/** @param {string} raw @returns {number|undefined} */
function toEpochMs(raw) {
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Map parsed CSV rows to Job objects. Exported for unit tests.
 *
 * @param {string[][]} rows
 * @param {{ index: number, map: Record<string, number> }} header
 * @param {string} fallbackCompany
 * @returns {Array<{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}>}
 */
export function rowsToJobs(rows, header, fallbackCompany) {
  const { index, map } = header;
  const at = (row, field) => (map[field] != null ? (row[map[field]] ?? '') : '');
  const jobs = [];

  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i];
    const title = at(row, 'title');
    const rawUrl = at(row, 'url');
    if (!title || !rawUrl) continue; // spacer rows and section breaks

    let url = '';
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = parsed.href;
    } catch { continue; } // a cell that isn't a URL is not a posting
    if (!url) continue;

    // Seniority and skills ride along in `description` because the sheet gives
    // them for free in the same row — that is what makes them eligible under
    // the zero-token rule, and it lets content_filter narrow on them.
    const extra = [at(row, 'seniority'), at(row, 'skills')].filter(Boolean).join(' · ');

    jobs.push({
      title,
      url,
      company: at(row, 'company') || fallbackCompany,
      location: at(row, 'location'),
      ...(extra ? { description: extra } : {}),
      ...(toEpochMs(at(row, 'posted')) ? { postedAt: toEpochMs(at(row, 'posted')) } : {}),
    });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'gsheet-csv',

  detect(entry) {
    // Explicit opt-in only — see the header note.
    return entry?.provider === 'gsheet-csv' ? { url: String(entry.careers_url || '') } : null;
  },

  /**
   * @param {any} entry - The job_boards entry being processed.
   * @param {any} ctx - HTTP context.
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string}>>}
   */
  async fetch(entry, ctx) {
    const sheet = resolveSheet(entry);
    if (!sheet) throw new Error(`gsheet-csv: cannot resolve a spreadsheet id for "${entry.name}"`);

    const exportUrl = `https://${HOST}/spreadsheets/d/${sheet.id}/export?format=csv`
      + (sheet.gid ? `&gid=${encodeURIComponent(sheet.gid)}` : '');

    // redirect:'follow' is required and safe here: the URL is built by this
    // provider against a pinned docs.google.com host from an id matched by
    // regex, and Google always 307s a CSV export to its googleusercontent CDN.
    // Nothing user-controlled reaches the request except the sheet id itself.
    const csv = await ctx.fetchText(exportUrl, { redirect: 'follow' });

    if (/^\s*<(!doctype|html)/i.test(csv)) {
      throw new Error(`gsheet-csv: "${entry.name}" returned HTML, not CSV — the sheet is probably not link-shared (needs "Anyone with the link can view")`);
    }

    const rows = parseCsv(csv);
    const header = detectHeader(rows, entry.columns);
    if (!header) {
      throw new Error(`gsheet-csv: "${entry.name}" has no recognizable header row — need a title-ish and a url-ish column (got: ${rows.slice(0, 6).map((r) => r.filter(Boolean).join('/')).filter(Boolean).join(' | ') || 'empty sheet'})`);
    }

    return rowsToJobs(rows, header, entry.name || 'Google Sheet');
  },
};
