# Autopilot — Handoff

**Written:** 2026-09-26, end of the build session that shipped Phases 0–2.
**Read this with:** `design/autopilot-plan.md` (the agreed design; still accurate).
**Audience:** the next agent picking this up cold.

---

## 1. Where things stand

Phases 0, 1, 2 of `design/autopilot-plan.md` are **built and validated**. Phase 3
(Gmail sync) and Phase 4 (the submit gate) are **not started, deliberately**.

Nothing is scheduled. `autopilot/install-schedule.ps1` exists and its `-DryRun` path
is verified, but the Task Scheduler job was **never registered** — the user wants to
watch manual runs first. Don't register it without being asked.

### Files this work added (all user-layer, all declared in `config/local-paths.txt`)

| File | Purpose | Tests |
|---|---|---|
| `autopilot/db-build.mjs` | files → `data/careerops.db` (SQLite derived index) | 9 self-tests |
| `autopilot/triage-run.mjs` | lane routing + drives `modes/triage.md`, parses `TRIAGE:` | 24 self-tests |
| `autopilot/daily.mjs` | stage orchestration + run digest | 10 self-tests |
| `autopilot/run-log.mjs` | append-only ledger `data/autopilot-runs.tsv` | 19 self-tests |
| `autopilot/install-schedule.ps1` | Task Scheduler registration (NOT registered) | `-DryRun` verified |
| `web/src/lib/autopilot/db-read.mjs` | read-only DB queries (`readOnly: true`) | — |
| `web/src/app/autopilot/runs/page.tsx` | `/autopilot/runs` dashboard | renders live |

Every script supports `--self-test` (in-memory, no subprocess, no network). **Run them
first** — they're the fastest way to confirm nothing rotted:

```bash
node autopilot/db-build.mjs   --self-test
node autopilot/triage-run.mjs --self-test
node autopilot/daily.mjs      --self-test
node autopilot/run-log.mjs    --self-test
```

The only tracked (upstream) file edited is `web/src/lib/nav-items.ts` — one line, the
nav entry. Expect at most a one-line conflict on an upstream pull.

---

## 2. Two known defects — fix these first

Both were exposed by the final overnight run (2026-09-26 01:21) and are **unfixed**.

### 2a. Error logging echoes the entire prompt

`autopilot/triage-run.mjs` passes `execFileSync`'s error message through nearly raw.
That message contains the **whole command line**, i.e. the full triage prompt with
every URL. One 40-row run produced a **967-line log**. Unattended on a schedule this
would produce five-figure log files.

Fix: truncate to the actual cause before logging. The failure line is built around
`err.code ?? err.message` in the batch loop — cap it hard (say 200 chars) and strip
the echoed prompt.

### 2b. No rate-limit / quota awareness

This is the one that actually cost the user a run. When the Claude quota was
exhausted mid-run, `triage-run.mjs` kept going and burned **72 consecutive doomed CLI
calls** (32 in pass 1, all 40 in pass 2) before the outer loop's no-progress guard
stopped it.

`batch/batch-runner.sh` already solves this properly — it has `--rate-limit-sleep`,
a pause sentinel (`batch/batch-runner.paused`), a `rate_limited` state, and a
resume path. **Read how it detects the condition and mirror that**, rather than
inventing a new mechanism. Minimum viable fix: after N consecutive batch failures
(2–3), stop the run and report "quota/rate limit suspected" instead of continuing.

---

## 3. Binding constraints — do not violate these

These are user decisions, not suggestions.

1. **NO EVALUATIONS.** The user said explicitly: *"I want to mention that I dont want
   the evaluations to happen"* and *"Only until triage."* `autopilot/daily.mjs` has
   **no stage 6** — not stubbed, not flag-disabled, absent. Keep it that way until
   they say otherwise.

2. **NO SUBMISSIONS.** The user asked pointedly to verify nothing could submit their
   CV. Phase 4 was never built. `web/src/lib/apply/drive.ts`'s `SUBMIT_RX` guard is
   **untouched** (`git diff` is empty) and must stay that way. If Phase 4 is ever
   built, the plan's design is binding: the model never gets a submit action; a
   deterministic function does, gated on a single-use token bound to a hash of the
   approved answer set, with a pre-click field diff that aborts on mismatch.

3. **Never edit system-layer files.** `rank-pipeline.mjs`, `scan.mjs`,
   `batch/batch-runner.sh`, `providers/*`, everything in `modes/` except
   `_profile.md` / `_custom.md` / `_brief.md`. They're in `update-system.mjs`'s
   `SYSTEM_PATHS` and will be overwritten. Import and invoke them instead.

4. **`career-ops/` stays.** It's a second full copy of the repo nested inside the
   repo (untracked, ~200 files), kept at the user's request. Never read, index, or
   walk into it. Same for `node_modules/` and `web/node_modules/`.

5. **Cost is the user's call.** They engaged carefully with every budget question.
   Ask before spending real LLM money on a large batch; don't default into it.

---

## 4. Current pipeline state (2026-09-26 ~01:40)

- `data/pipeline.md`: **407 pending** (203 `agent-fetch`, 144 `api-jd`, 60 `il-source`), 1413 processed
- Triage verdicts written by autopilot so far: **71 FAIL, 28 SKIP, 3 PASS** (102 rows)
- `data/applications.md`: 58 rows — 28 Evaluated, 28 SKIP, 2 Applied, 0 responses
- `data/careerops.db`: 1820 jobs, 76 reports, 58 applications
- `verify-pipeline.mjs`: **0 errors**, 41 warnings (all pre-existing and understood —
  18 legitimately-covered orphan reports + 6 unresolved employer boards)
- `data/autopilot-runs.tsv`: 5 runs logged

### The 3 PASS rows (the actual output so far)

| Role | Score | Note |
|---|---|---|
| Mobileye — ML/AI Engineer, Ramat Gan | 4.5/5 | **already tracker #109, status Applied** |
| Mobileye — ML/AI Engineer, Jerusalem | 4.5/5 | **already tracker #110, status Applied** |
| **Ib1 — Senior Backend Engineer, Tel Aviv** | 3.8/5 | **the one genuinely new lead** |

---

## 5. Calibration finding — don't re-litigate this

An early worry was that `modes/_brief.md`'s gates were too tight (0 PASS in the first
15 rows). **The data says they're correct.** Across 102 triaged rows the FAIL reasons
are all legitimate: mechanical engineering, industrial maintenance, chemical lab
testing, HR roles, radar/hardware integration, QA/regulatory, 7+-years-experience
roles, remote-abroad annotation gigs. A ~3% PASS rate reflects genuine intake
quality, not an over-tight filter. **Do not loosen the gates** without new evidence.

`calibrate.mjs` is the right tool once there are enough real outcomes.

---

## 6. Intake work already done (don't redo)

Phase 0 and follow-ups cleaned a lot. Backups exist for every destructive step:
`portals.yml.pre-il-prune.bak`, `data/pipeline.md.pre-phase0.bak`,
`data/pipeline.md.pre-lilt.bak`.

- **96 stale pending rows retired** (secrethunter 36, solid.jobs 29, Nortal 13,
  VW/CARIAD 13, BMW 2, svt.jobs 3) — sources already disabled; rows **moved** to
  `## Processed`, never deleted.
- **12 portals entries disabled** (215 → 203 enabled): 3M, Munters, Chegg, Veritone,
  Transperfect, Tether, Cadence, matia, Maxlinear, Lendbuzz, Oversee, `lilt production`.
  All had scanned rows with **zero Israel-located postings ever**. Each carries an
  inline reason. Verified safe: `goozali-sync.mjs` dedups on company *name*
  regardless of `enabled`, so they won't be re-added.
  - `lilt production` was the worst: **97 rows of "AI Training Contributor –
    {Language} – Remote"** annotation gigs, exactly 1 Israel-located. 80 pending rows
    retired with it.
- **Telegram `@jobforjunior` enabled** (was `enabled: false`) — zero-token source.
- **3 orphan reports merged** into the tracker (#102 Systematics, #103 confidential
  structural, #108 Novelrad). The other 18 flagged orphans were verified as **already
  covered** — the tracker's convention is one row per company+role with re-eval
  history in Notes, so they need no new rows.

### Still open from Phase 0

- **6 major employers enabled but no provider claims their URL** (Microsoft, Meta,
  Apple, IBM, Qualcomm, Palo Alto Networks) — `scan.mjs` silently skips them every
  run. `discover-ats.mjs` found boards for them reporting **0 live postings**, so
  re-probe periodically rather than force-adding. Google "resolved" to
  `google.recruitee.com`, almost certainly a **false positive** (Recruitee is a
  small-company ATS) — do not `--write` it without checking.
- **4 Israel-presence boards returning zero rows**: Broadcom, Marvell, Ribbon,
  **Banias Labs (Alpha Wave — an Israeli company)**. Left enabled on purpose: zero
  rows from an Israeli company smells like a misconfigured board, and disabling would
  bury a fixable bug. `audit-portals.mjs` is the tool, but it needs **>5 minutes**
  (hundreds of paginated Workday boards) — budget for that.

---

## 7. Performance facts worth knowing

- **A full board sweep takes ~40 minutes** (2392s measured). `daily.mjs`'s
  `SCAN_TIMEOUT_MS` is 40 min, which it *just* fits inside. The cost is
  `providers/workday.mjs` fetching **one detail document per posting at 250ms
  spacing** (~1,250 requests) to resolve multi-location placeholders. Zero tokens,
  pure wall-clock.
- **Coverage is incomplete regardless of time**: NVIDIA hits Workday's offset ceiling
  at 2000 and self-reports "still incomplete"; NVIDIA + Cisco left **1,017
  placeholders unresolved** by the provider's own 200-request cap. Upstream limit,
  not fixable from here.
- **Only 7.7% of everything ever scanned (156 of 2013 rows) is Israel-located.** That
  ratio is the strongest argument for pruning intake rather than adding sources.
- `scan.mjs` walks `portals.yml` in **fixed file order with no `--resume`**, so if a
  sweep ever does get truncated, the same early boards get re-swept and late ones may
  never be reached. If that becomes a problem the fix is board-order rotation
  upstream, not a bigger timeout.
- Triage throughput: ~5 rows per CLI call, ~88s per call. `--budget 200` is the hard
  ceiling per run (`selectBatch`'s `LIMIT_CEILING`), so draining 400+ rows needs
  multiple passes.

---

## 8. Gotchas that already bit once

- **`--budget 0` was a footgun.** `selectBatch` treats a falsy limit as "use my
  default (20)", so `--budget 0` once spawned a real, unintended CLI call. Fixed via
  `resolveBudgetSelection()` with an explicit regression test. Don't undo it.
- **`triage-run.mjs --dry-run` still calls the CLI** (it only skips the file write) —
  matching `rank-pipeline.mjs`'s own semantics. It is **not** free. `daily.mjs
  --dry-run` *is* free (executes nothing).
- **`data/runs/{date}.json` is keyed by date**, so multiple runs in one day
  overwrite each other. That's why `data/autopilot-runs.tsv` exists — it's the
  durable history. Don't treat the JSON as a record.
- **`data/careerops.db` is derived and disposable.** Everything in it except
  `submissions`/`mail`/`runs` rebuilds from files. Never make it the source of truth.
- **Report parsing has a cosmetic gap**: `archetype` in some reports' Machine Summary
  YAML is a flow list (`[A, B]`) and lands in SQLite as a raw bracketed string. Not
  blocking; fix alongside broader YAML parsing if touched.
- **Old reports lack a `**Date:**` header** — `db-build.mjs` falls back to the
  filename date. Keep that fallback.

---

## 9. Suggested next steps, in order

1. **Fix the two defects in §2** (prompt-echo logging, quota detection). Small,
   contained, and they block unattended operation.
2. **Surface the 3 PASS rows to the user** — specifically that **Ib1** is the only
   new one. This is the whole point of the machine; don't let it sit in a markdown file.
3. **Drain the remaining 407-row backlog** as quota allows, in budgeted passes. Ask
   before each large spend.
4. Only then consider Phase 3 (Gmail) or Phase 4 (submit gate), and only on the
   user's say-so.

Do **not** register the scheduled task, run evaluations, or build the submit path
without explicit instruction.
