import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPreparedRecent, readSources } from "../../src/lib/autopilot/prepared-read.mjs";

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "prepared-read-"));
  mkdirSync(join(root, "data", "runs"), { recursive: true });
  try { fn(root, (name, body) => writeFileSync(join(root, "data", "runs", name), body)); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("no data/runs → nothing, no error", () => {
  const root = mkdtempSync(join(tmpdir(), "prepared-read-"));
  try {
    assert.deepEqual(readPreparedRecent(root), { days: [], errors: [] });
    assert.deepEqual(readSources(root), { error: null, rows: [], generatedAt: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("newest days first, capped", () => {
  withRoot((root, put) => {
    for (const d of ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"]) put(`prepared-${d}.json`, JSON.stringify({ date: d, records: [{ company: d }] }));
    put("2026-09-30.json", "{}"); // the run digest, not a prepared file
    const r = readPreparedRecent(root, 3);
    assert.deepEqual(r.days.map((x) => x.date), ["2026-09-30", "2026-09-29", "2026-09-28"]);
    assert.equal(r.days[0].records[0].company, "2026-09-30");
  });
});

test("a broken file is reported, not silently emptied", () => {
  withRoot((root, put) => {
    put("prepared-2026-09-30.json", "{ not json");
    put("sources.json", "also broken");
    const r = readPreparedRecent(root);
    assert.equal(r.days.length, 0);
    assert.equal(r.errors.length, 1);
    assert.match(readSources(root).error, /sources\.json/);
  });
});

test("sources rows and timestamp are read", () => {
  withRoot((root, put) => {
    put("sources.json", JSON.stringify({ generated_at: "2026-09-30T10:00:00Z", rows: [{ source: "lever-api", found: 3 }] }));
    const s = readSources(root);
    assert.equal(s.rows[0].source, "lever-api");
    assert.equal(s.generatedAt, "2026-09-30T10:00:00Z");
  });
});
