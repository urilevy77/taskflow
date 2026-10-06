// db-read.mjs — read-only view over data/careerops.db for the /autopilot/runs
// page. Plain .mjs (same pattern as tracker-table.mjs / pdf-index.ts) so it
// can be unit-tested directly under node:test without a Next.js boundary.
//
// This NEVER writes. The database is built by `node autopilot/db-build.mjs`
// (Phase 1) and, from Phase 2 on, refreshed by the daily routine — this file
// only reads whatever is already there. Missing DB is a normal, expected
// state (Phase 1 shipped before the daily routine exists to populate `runs`),
// so every query degrades to an empty/zero value rather than throwing.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * @param {string} root - career-ops checkout root (careerOpsRoot()).
 * @returns {{
 *   available: boolean,
 *   jobs: { pending: number, processed: number, byLane: Record<string, number> },
 *   reports: { total: number, withJdArchive: number },
 *   applications: { total: number },
 *   runs: Array<{ run_id: string, started_at: string, finished_at: string, stage_json: string }>,
 * }}
 */
export function readAutopilotIndex(root) {
  const dbPath = join(root, "data", "careerops.db");
  const empty = {
    available: false,
    jobs: { pending: 0, processed: 0, byLane: {} },
    reports: { total: 0, withJdArchive: 0 },
    applications: { total: 0 },
    runs: [],
  };
  if (!existsSync(dbPath)) return empty;

  let db;
  try {
    // read-only: this view must never be the thing that corrupts the index
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return empty;
  }

  try {
    const jobStatusRows = db.prepare("SELECT status, COUNT(*) c FROM jobs GROUP BY status").all();
    const pending = Number(jobStatusRows.find((r) => r.status === "pending")?.c ?? 0);
    const processed = Number(jobStatusRows.find((r) => r.status === "processed")?.c ?? 0);

    const laneRows = db
      .prepare("SELECT lane, COUNT(*) c FROM jobs WHERE lane IS NOT NULL GROUP BY lane")
      .all();
    const byLane = Object.fromEntries(laneRows.map((r) => [String(r.lane), Number(r.c)]));

    const reportsTotal = Number(db.prepare("SELECT COUNT(*) c FROM reports").get()?.c ?? 0);
    const reportsWithJd = Number(
      db.prepare("SELECT COUNT(*) c FROM reports WHERE has_jd_archive = 1").get()?.c ?? 0,
    );

    const applicationsTotal = Number(db.prepare("SELECT COUNT(*) c FROM applications").get()?.c ?? 0);

    const runs = db
      .prepare("SELECT run_id, started_at, finished_at, stage_json FROM runs ORDER BY started_at DESC LIMIT 30")
      .all();

    return {
      available: true,
      jobs: { pending, processed, byLane },
      reports: { total: reportsTotal, withJdArchive: reportsWithJd },
      applications: { total: applicationsTotal },
      runs: runs.map((r) => ({
        run_id: String(r.run_id),
        started_at: String(r.started_at),
        finished_at: String(r.finished_at ?? ""),
        stage_json: String(r.stage_json ?? "{}"),
      })),
    };
  } catch {
    return empty;
  } finally {
    db.close();
  }
}
