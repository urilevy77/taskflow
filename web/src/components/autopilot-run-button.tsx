"use client";

import { useCallback, useEffect, useState } from "react";

type RunState = { running: boolean; pid: number | null; startedAt: string | null; log: string[] };

// Starts autopilot/daily.mjs via /api/autopilot/daily. Triage (LLM spend) is a
// separate, explicit opt-in — the default run is scan + enrich + index + health.
export function AutopilotRunButton() {
  const [state, setState] = useState<RunState | null>(null);
  const [triage, setTriage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/autopilot/daily", { cache: "no-store" });
      if (res.ok) setState(await res.json());
    } catch {
      /* server unreachable — leave the last state */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!state?.running) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [state?.running, refresh]);

  async function start() {
    setError(null);
    const res = await fetch("/api/autopilot/daily", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triage, budgetTriage: 60 }),
    });
    if (!res.ok) setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "failed to start");
    await refresh();
  }

  return (
    <div className="mt-6 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={start}
          disabled={state?.running}
          className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-50"
        >
          {state?.running ? "Running…" : "Run daily now"}
        </button>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={triage} onChange={(e) => setTriage(e.target.checked)} />
          Include LLM triage (up to 40 rows — spends tokens)
        </label>
      </div>
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
      {state && state.log.length > 0 && (
        <pre className="mt-3 max-h-64 overflow-auto rounded bg-surface p-3 text-xs">{state.log.join("\n")}</pre>
      )}
    </div>
  );
}
