import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { careerOpsRoot, readApplications, readInbox } from "@/lib/career-ops";
import { getNormalizeTextKey } from "./text-key";
import type { DiscoveredOffer, KnownMatch } from "@/lib/explore";

/**
 * "Do we already have this job?" — the check the Explore scan was missing.
 *
 * A scanned offer is KNOWN when it matches, in this order of precedence:
 *   1. the tracker (data/applications.md)   — same company + similar role
 *   2. the pipeline (data/pipeline.md)      — same normalized URL, or same company + similar role
 *   3. scan history (data/scan-history.tsv) — an `added` row with the same URL or company + role
 *
 * URL keys come from the core's own url-key.mjs so web dedup matches the CLI's
 * (same reasoning as text-key.ts). Role matching mirrors autopilot/prepare.mjs
 * `titleOverlap` (≥ 0.6 of the smaller title's tokens), with one extra guard:
 * a one-word title only matches an identical one-word title, so "Engineer"
 * cannot swallow every engineering role at a company.
 *
 * Only `added` history rows count — skipped_expired / skipped_* rows are URL-level
 * failures, not evidence the role was ever taken (same rule as scan.mjs).
 */

type NormalizeUrl = (raw: string) => string;
type TextKey = (value: unknown, separator?: string) => string;

const urlCache = new Map<string, NormalizeUrl>();

/** Last-resort key when the core's url-key.mjs can't load: host case, http/https, hash, tracking params, trailing slash. */
function fallbackNormalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
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

async function getNormalizeUrl(): Promise<NormalizeUrl> {
  const file = path.join(careerOpsRoot(), "url-key.mjs");
  const hit = urlCache.get(file);
  if (hit) return hit;
  try {
    const mod = await import(/* webpackIgnore: true */ pathToFileURL(file).href);
    const fn = mod?.normalizeUrl;
    if (typeof fn === "function") {
      urlCache.set(file, fn); // never cache a failure (#2590)
      return fn;
    }
  } catch {
    /* fall through */
  }
  return fallbackNormalizeUrl;
}

const STOP = new Set(["il", "the", "and", "of"]);

function tokens(key: TextKey, s: string): Set<string> {
  return new Set(key(s, " ").split(" ").filter((t) => t.length > 1 && !STOP.has(t)));
}

function similarRole(key: TextKey, a: string, b: string): boolean {
  const ta = tokens(key, a);
  const tb = tokens(key, b);
  if (!ta.size || !tb.size) return false;
  const small = Math.min(ta.size, tb.size);
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  if (small < 2) return ta.size === tb.size && hit === ta.size; // one-word titles: identical only
  return hit / small >= 0.6;
}

type RoleRow = { companyKey: string; role: string; match: KnownMatch };

function readAddedHistory(): { url: string; company: string; title: string; firstSeen: string }[] {
  let tsv: string;
  try {
    tsv = fs.readFileSync(path.join(careerOpsRoot(), "data", "scan-history.tsv"), "utf8");
  } catch {
    return [];
  }
  const rows: { url: string; company: string; title: string; firstSeen: string }[] = [];
  const lines = tsv.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (!line || (i === 0 && line.startsWith("url\t"))) continue;
    // url  first_seen  portal  title  company  status  location …
    const [url, firstSeen, , title = "", company = "", status = "added"] = line.split("\t");
    if (!url || status !== "added") continue;
    rows.push({ url, firstSeen: (firstSeen ?? "").trim(), title: title.trim(), company: company.trim() });
  }
  return rows;
}

export type KnownIndex = { classify(offer: Pick<DiscoveredOffer, "url" | "company" | "title">): KnownMatch | null };

/** Snapshot the tracker, pipeline and scan history once; classify any number of offers against it. */
export async function loadKnownIndex(): Promise<KnownIndex> {
  const [normUrl, key] = await Promise.all([getNormalizeUrl(), getNormalizeTextKey()]);

  const trackerRows: RoleRow[] = readApplications().map((a) => ({
    companyKey: key(a.company),
    role: a.role,
    match: { kind: "tracker", reason: "role", label: `#${a.n} ${a.role}`, trackerNum: a.n, status: a.status },
  }));

  const pipelineUrls = new Map<string, KnownMatch>();
  const pipelineRows: RoleRow[] = [];
  for (const j of readInbox()) {
    const m: KnownMatch = { kind: "pipeline", reason: "url", label: j.role, status: j.done ? "done" : "pending" };
    const k = normUrl(j.url);
    if (k) pipelineUrls.set(k, m);
    pipelineRows.push({ companyKey: key(j.company), role: j.role, match: { ...m, reason: "role" } });
  }

  const historyUrls = new Map<string, KnownMatch>();
  const historyRows: RoleRow[] = [];
  for (const h of readAddedHistory()) {
    const m: KnownMatch = { kind: "history", reason: "url", label: h.title, since: h.firstSeen || undefined };
    const k = normUrl(h.url);
    if (k) historyUrls.set(k, m);
    if (h.company && h.title) historyRows.push({ companyKey: key(h.company), role: h.title, match: { ...m, reason: "role" } });
  }

  const byRole = (rows: RoleRow[], ck: string, title: string): KnownMatch | null =>
    rows.find((r) => r.companyKey === ck && similarRole(key, r.role, title))?.match ?? null;

  return {
    classify(offer) {
      const ck = key(offer.company);
      const uk = normUrl(offer.url);
      // A tracker row is the most useful thing to tell the user about, so it wins.
      const tracked = ck ? byRole(trackerRows, ck, offer.title) : null;
      if (tracked) return tracked;
      const inPipeline = (uk && pipelineUrls.get(uk)) || (ck ? byRole(pipelineRows, ck, offer.title) : null);
      if (inPipeline) return inPipeline;
      return (uk && historyUrls.get(uk)) || (ck ? byRole(historyRows, ck, offer.title) : null) || null;
    },
  };
}

/** Tag each offer with `known` when we already have it. Never drops offers. */
export function annotateKnown<T extends DiscoveredOffer>(index: KnownIndex, offers: T[]): T[] {
  return offers.map((o) => {
    const known = index.classify(o);
    return known ? { ...o, known } : o;
  });
}
