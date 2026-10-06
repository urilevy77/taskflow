/**
 * job-source.mjs — "where did this posting come from?"
 *
 * Pure, dependency-free (plain .mjs so node:test can import it). File reading is
 * the caller's job: pass in the text of data/scan-history.tsv and data/pipeline.md.
 *
 * Precedence, most informative first:
 *   1. WhatsApp     — the URL sits in pipeline.md on a "Job lead (WhatsApp)" row.
 *                     That is the ORIGIN; the ATS behind the link is secondary.
 *   2. Scan source  — the `portal` column scan-history.tsv recorded (greenhouse-api → Greenhouse).
 *   3. Host         — recognised ATS/job-board hosts, else the bare domain.
 *   4. ""           — no URL at all.
 */

const PORTAL_LABELS = {
  greenhouse: "Greenhouse",
  ashby: "Ashby",
  lever: "Lever",
  workday: "Workday",
  workable: "Workable",
  recruitee: "Recruitee",
  smartrecruiters: "SmartRecruiters",
  successfactors: "SuccessFactors",
  bamboohr: "BambooHR",
  icims: "iCIMS",
  oraclecloud: "Oracle Cloud",
  rippling: "Rippling",
  phenom: "Phenom",
  gem: "Gem",
  mokahr: "MokaHR",
  feishu: "Feishu Jobs",
  amazon: "Amazon Jobs",
  solidjobs: "SolidJobs",
  "gsheet-csv": "Google Sheet",
  "whats-new": "Explore",
};

// [host suffix, label] — checked in order against the URL's hostname.
const HOST_LABELS = [
  ["greenhouse.io", "Greenhouse"],
  ["ashbyhq.com", "Ashby"],
  ["lever.co", "Lever"],
  ["myworkdayjobs.com", "Workday"],
  ["workable.com", "Workable"],
  ["recruitee.com", "Recruitee"],
  ["smartrecruiters.com", "SmartRecruiters"],
  ["successfactors.com", "SuccessFactors"],
  ["bamboohr.com", "BambooHR"],
  ["icims.com", "iCIMS"],
  ["oraclecloud.com", "Oracle Cloud"],
  ["rippling.com", "Rippling"],
  ["comeet.com", "Comeet"],
  ["linkedin.com", "LinkedIn"],
  ["indeed.com", "Indeed"],
  ["drushim.co.il", "Drushim"],
  ["alljobs.co.il", "AllJobs"],
];

/** scan-history `portal` value (e.g. "greenhouse-api", "ashby-full") → display label. */
export function portalLabel(portal) {
  const id = String(portal ?? "").trim().toLowerCase().replace(/-(api|full)$/, "");
  if (!id) return "";
  return PORTAL_LABELS[id] ?? id.replace(/(^|[-_])(\w)/g, (_, sep, c) => (sep ? " " : "") + c.toUpperCase());
}

/** Label from the URL's host alone: a known ATS/board, else the bare domain. "" when unparseable. */
export function hostLabel(url) {
  let host;
  try {
    host = new URL(String(url).trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
  if (!host) return "";
  for (const [suffix, label] of HOST_LABELS) if (host === suffix || host.endsWith("." + suffix)) return label;
  return host;
}

/** Same-posting key: https, lowercase host, no hash / tracking params / trailing slash. Never throws. */
export function urlKey(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    u.protocol = "https:";
    u.hostname = u.hostname.toLowerCase();
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|gh_src$|fbclid$|gclid$|trk$)/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return "";
  }
}

/**
 * @param {{ historyTsv?: string | null, pipelineMd?: string | null }} sources
 * @returns {(url: string) => string} url → provider label ("" when there is no URL)
 */
export function buildProviderResolver({ historyTsv, pipelineMd } = {}) {
  /** @type {Set<string>} */
  const whatsapp = new Set();
  for (const line of String(pipelineMd ?? "").split("\n")) {
    const m = line.match(/^\s*-\s*\[[ xX]\]\s*(.+)$/);
    if (!m || !/\(WhatsApp\)/i.test(m[1])) continue;
    const k = urlKey(m[1].split("|")[0]);
    if (k) whatsapp.add(k);
  }

  /** @type {Map<string, string>} */
  const portals = new Map();
  const lines = String(historyTsv ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (!line || (i === 0 && line.startsWith("url\t"))) continue;
    const [url, , portal] = line.split("\t");
    const k = urlKey(url);
    // keep the EARLIEST sighting: that's the source that first surfaced the job
    if (k && portal && !portals.has(k)) portals.set(k, portal);
  }

  return (url) => {
    const k = urlKey(url);
    if (!k) return "";
    if (whatsapp.has(k)) return "WhatsApp";
    const portal = portals.get(k);
    if (portal) return portalLabel(portal);
    return hostLabel(url);
  };
}
