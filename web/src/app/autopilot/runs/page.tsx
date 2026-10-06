import { careerOpsRoot } from "@/lib/career-ops";
import { readAutopilotIndex } from "@/lib/autopilot/db-read.mjs";
import { readPreparedRecent, readSources } from "@/lib/autopilot/prepared-read.mjs";
import { Card } from "@/components/ui/card";
import { AutopilotRunButton } from "@/components/autopilot-run-button";

export const dynamic = "force-dynamic"; // the index changes underneath every db-build run

// Phase 1 of design/autopilot-plan.md: a read-only proof that
// data/careerops.db reflects what's actually in the files, BEFORE anything
// runs unattended on a schedule (Phase 2). The `runs` table is populated by
// autopilot/daily.mjs, which does not exist yet — its empty state here is
// expected, not a bug.

type PreparedRecord = {
  url_key?: string;
  label: string;
  company: string;
  title: string;
  score?: number | null;
  reasons?: string[];
  cv?: { status?: string; library?: string | null; note?: string | null };
};
type SourceRow = { source: string; found: number; pass: number; prepared: number; applied: number; responded: number; interview: number };

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div>
      <div className="text-3xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-sm text-muted">{label}</div>
    </div>
  );
}

function formatStageJson(stageJson: string): string {
  try {
    const parsed = JSON.parse(stageJson);
    return Object.entries(parsed)
      .map(([stage, v]) => `${stage}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" · ");
  } catch {
    return stageJson;
  }
}

export default function AutopilotRunsPage() {
  const root = careerOpsRoot();
  const index = readAutopilotIndex(root);

  if (!index.available) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="font-display text-2xl tracking-tight text-landing">Autopilot</h1>
        <Card className="mt-6" corner="br">
          <p className="text-sm text-foreground">No index built yet.</p>
          <p className="mt-2 text-sm text-muted">
            Run <code className="rounded bg-surface px-1.5 py-0.5 text-xs">node autopilot/db-build.mjs</code> from
            the checkout root to build <code className="rounded bg-surface px-1.5 py-0.5 text-xs">data/careerops.db</code>{" "}
            from your current pipeline, reports, and tracker. Nothing here writes to your data — this page only
            reads the index once it exists.
          </p>
        </Card>
      </div>
    );
  }

  const prepared = readPreparedRecent(root, 3) as { days: { date: string; records: PreparedRecord[] }[]; errors: string[] };
  const sources = readSources(root) as { rows: SourceRow[]; error: string | null; generatedAt: string | null };
  const laneEntries = Object.entries(index.jobs.byLane).sort((a, b) => b[1] - a[1]);
  const jdCoveragePct = index.reports.total
    ? Math.round((index.reports.withJdArchive / index.reports.total) * 100)
    : 0;

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="font-display text-2xl tracking-tight text-landing">Autopilot</h1>
      <p className="mt-1 text-sm text-muted">
        A read-only index over your pipeline, reports, and tracker — see design/autopilot-plan.md.
      </p>

      <AutopilotRunButton />

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat value={index.jobs.pending} label="pending in pipeline" />
        <Stat value={index.jobs.processed} label="processed" />
        <Stat value={index.reports.total} label="reports" />
        <Stat value={`${jdCoveragePct}%`} label="reports with JD archived" />
      </div>

      {laneEntries.length > 0 && (
        <Card className="mt-8" corner="bl">
          <h2 className="text-sm font-medium text-foreground">Pending by lane</h2>
          <p className="mt-1 text-xs text-faint">
            Written by autopilot/triage-run.mjs (Phase 2) — host routing, not a fit score.
          </p>
          <div className="mt-4 space-y-2">
            {laneEntries.map(([lane, n]) => (
              <div key={lane} className="flex items-center justify-between text-sm">
                <span className="text-muted">{lane}</span>
                <span className="tabular-nums">{n}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="mt-8" corner="br">
        <h2 className="text-sm font-medium text-foreground">Prepared jobs</h2>
        <p className="mt-1 text-xs text-faint">
          New PASS jobs from the last {prepared.days.length || 3} daily runs: READY = nothing in the way, CHECK = look
          first, BLOCKED = never offered. Written by autopilot/prepare-new.mjs and auto-tailor.mjs.
        </p>
        {prepared.errors.map((e) => (
          <p key={e} className="mt-2 text-xs text-red-700 dark:text-red-400">
            Could not read {e}
          </p>
        ))}
        {prepared.days.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing prepared yet — the daily run fills this in.</p>
        ) : (
          prepared.days.map((day) => (
            <div key={day.date} className="mt-4">
              <div className="text-xs font-medium text-faint">{day.date}</div>
              <div className="mt-2 space-y-2">
                {day.records.map((r: PreparedRecord) => (
                  <div key={r.url_key ?? `${r.company}-${r.title}`} className="flex items-start justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <span className="font-medium">{r.company}</span> <span className="text-muted">— {r.title}</span>
                      {r.reasons?.[0] && <div className="text-xs text-faint">{r.reasons[0]}</div>}
                      {r.cv?.status && (
                        <div className="text-xs text-faint">
                          CV: {r.cv.status}
                          {r.cv.library ? ` · ${r.cv.library}` : ""}
                          {r.cv.note ? ` · ${r.cv.note}` : ""}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 text-right text-xs">
                      <div className="font-medium">{r.label}</div>
                      {typeof r.score === "number" && <div className="text-faint tabular-nums">{r.score.toFixed(1)}/5</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </Card>

      <Card className="mt-8" corner="bl">
        <h2 className="text-sm font-medium text-foreground">Sources</h2>
        <p className="mt-1 text-xs text-faint">
          Which platforms and WhatsApp groups produce jobs that get prepared, applied to and answered
          {sources.generatedAt ? ` (updated ${sources.generatedAt})` : ""}. A job seen in two places counts for both.
          WhatsApp links collected before 2026-09-30 have no group.
        </p>
        {sources.error && <p className="mt-2 text-xs text-red-700 dark:text-red-400">Could not read {sources.error}</p>}
        {sources.rows.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No source data yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-faint">
                  <th className="pr-3 font-normal">source</th>
                  {["found", "PASS", "prep", "applied", "resp", "intv"].map((h) => (
                    <th key={h} className="px-2 text-right font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sources.rows.slice(0, 25).map((s: SourceRow) => (
                  <tr key={s.source} className="border-t border-border">
                    <td className="py-1.5 pr-3">{s.source}</td>
                    {[s.found, s.pass, s.prepared, s.applied, s.responded, s.interview].map((n, i) => (
                      <td key={i} className="px-2 text-right tabular-nums">
                        {n}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="mt-8" corner="br">
        <h2 className="text-sm font-medium text-foreground">Daily runs</h2>
        {index.runs.length === 0 ? (
          <p className="mt-2 text-sm text-muted">
            No automated runs yet. Phase 2 (design/autopilot-plan.md) ships autopilot/daily.mjs, which will
            populate this after each scheduled run — what came in, what each stage filtered, and why.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {index.runs.map((r) => (
              <div key={r.run_id} className="border-b border-border pb-3 text-sm last:border-0 last:pb-0">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{r.started_at}</span>
                  <span className="text-xs text-faint">{r.finished_at || "in progress"}</span>
                </div>
                <p className="mt-1 text-xs text-muted">{formatStageJson(r.stage_json)}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
