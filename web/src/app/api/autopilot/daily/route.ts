// Starts / inspects autopilot/daily.mjs from the website.
//
//   POST { triage?: boolean, budgetTriage?: number, skipScan?: boolean, dryRun?: boolean }
//        → spawns daily.mjs DETACHED (it outlives the request; a full scan takes up to 40 min)
//   GET  → { running, pid, startedAt, log: [last lines] }
//
// Triage spends LLM tokens, so it is OFF unless the caller opts in with
// triage:true (and then it is capped). One run at a time, tracked by a pid file
// under data/runs/. Localhost only: this executes a local script.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TRIAGE_BUDGET = 100;
const LOG_TAIL_LINES = 60;

const paths = () => {
  const dir = path.join(/* turbopackIgnore: true */ careerOpsRoot(), "data", "runs");
  return { dir, pid: path.join(dir, "web-run.pid.json"), log: path.join(dir, "web-run.log") };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function isLocal(req: Request): boolean {
  const host = (req.headers.get("host") ?? "").split(":")[0];
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readState() {
  const p = paths();
  let info: { pid: number; startedAt: string; args: string[] } | null = null;
  try {
    info = JSON.parse(fs.readFileSync(p.pid, "utf-8"));
  } catch {
    /* no run recorded */
  }
  const running = !!info && isAlive(info.pid);
  let log: string[] = [];
  try {
    log = fs.readFileSync(p.log, "utf-8").split(/\r?\n/).filter(Boolean).slice(-LOG_TAIL_LINES);
  } catch {
    /* no log yet */
  }
  return { running, pid: info?.pid ?? null, startedAt: info?.startedAt ?? null, args: info?.args ?? [], log };
}

export async function GET(req: Request) {
  if (!isLocal(req)) return json({ error: "localhost only" }, 403);
  return json(readState());
}

export async function POST(req: Request) {
  if (!isLocal(req)) return json({ error: "localhost only" }, 403);

  let body: { triage?: boolean; budgetTriage?: number; skipScan?: boolean; dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body = defaults */
  }

  const state = readState();
  if (state.running) return json({ error: "a run is already in progress", ...state }, 409);

  const root = careerOpsRoot();
  const script = path.join(/* turbopackIgnore: true */ root, "autopilot", "daily.mjs");
  if (!fs.existsSync(script)) return json({ error: "autopilot/daily.mjs not found" }, 404);

  const args = ["autopilot/daily.mjs"];
  if (body.dryRun) args.push("--dry-run");
  if (body.skipScan) args.push("--skip-scan");
  if (body.triage) {
    const n = Math.floor(Number(body.budgetTriage ?? 60));
    if (!Number.isFinite(n) || n < 1 || n > MAX_TRIAGE_BUDGET) {
      return json({ error: `budgetTriage must be 1..${MAX_TRIAGE_BUDGET}` }, 400);
    }
    args.push("--budget-triage", String(n));
  } else {
    args.push("--skip-triage");
  }

  const p = paths();
  fs.mkdirSync(p.dir, { recursive: true });
  const out = fs.openSync(p.log, "w");
  const child = spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(p.pid, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), args }));
  return json({ started: true, pid: child.pid, args }, 202);
}
