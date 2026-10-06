// Read-only view of what the daily run's prepare/tailor/sources stages wrote under data/runs/.
// Plain JSON files, so this needs no database and no subprocess:
//   prepared-YYYY-MM-DD.json  {date, records: [{label, company, title, score, reasons, cv, ...}]}  (autopilot/prepare-new.mjs, auto-tailor.mjs)
//   sources.json              {generated_at, rows: [{source, found, pass, prepared, applied, ...}]}   (autopilot/sources.mjs)
// A missing file is "nothing yet"; a file that exists but won't parse is reported, never silently emptied.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function readJson(path) {
  if (!existsSync(path)) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (e) {
    return { ok: false, error: `${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The newest `days` prepared-*.json files, newest first. */
export function readPreparedRecent(root, days = 3) {
  const dir = join(root, "data", "runs");
  if (!existsSync(dir)) return { days: [], errors: [] };
  const files = readdirSync(dir)
    .filter((f) => /^prepared-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse()
    .slice(0, days);
  const out = [], errors = [];
  for (const f of files) {
    const r = readJson(join(dir, f));
    if (!r.ok) errors.push(r.error);
    else if (r.value) out.push({ date: r.value.date ?? f.slice(9, 19), records: Array.isArray(r.value.records) ? r.value.records : [] });
  }
  return { days: out, errors };
}

/** The per-source funnel, or null when sources.mjs hasn't run yet. */
export function readSources(root) {
  const r = readJson(join(root, "data", "runs", "sources.json"));
  if (!r.ok) return { error: r.error, rows: [], generatedAt: null };
  return { error: null, rows: Array.isArray(r.value?.rows) ? r.value.rows : [], generatedAt: r.value?.generated_at ?? null };
}
