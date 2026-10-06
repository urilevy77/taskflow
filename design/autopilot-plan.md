# Plan: Daily Job Autopilot

**Status:** plan, agreed in principle, not yet built.
**Started:** 2026-09-25 · **Supersedes:** `design/apply-ui-design-note.md` (its three
screens shipped upstream in `web/` before we built them).

## What you asked for

1. A daily routine that fetches jobs into a DB.
2. Only jobs that fit — same gates and archetypes as `modes/_brief.md`.
3. For each: the URL and the full job description, archived.
4. On your approval, the agent submits the application for you.
5. A dashboard tracking every application's real status, with Gmail as a status source.

## What already exists (do not rebuild)

This is the most important section of the plan. Roughly 70% of the above is already
in this checkout, some of it built by you:

| Need | Already there |
|---|---|
| Board intake | `scan.mjs` over **329** configured boards (incl. 6 Comeet — the Israeli ATS), `scan-ats-full.mjs` reverse-ATS sweep, `scan-hn.mjs` |
| WhatsApp intake | `plugins.local/whatsapp/watch.mjs` + **14** Israeli junior-jobs groups in `config/plugins.yml`, drained by `plugins.mjs run whatsapp` |
| One-shot intake | your `scan-all.mjs` — ingest queues first, then boards, under one pipeline lock |
| Board freshness | your `goozali-sync.mjs` — Israeli company directory → `portals.yml` |
| Dedup | `data/scan-history.tsv`, `url-key.mjs`, `fingerprint-core.mjs` |
| Fit filtering | `modes/triage.md` scored against your `modes/_brief.md` (Israel hard gate, 8 archetypes, CV-match-only) |
| Full evaluation | `modes/oferta.md` → `reports/NNN-*.md` with Blocks A–G and archived JD |
| JD archival | `fetch-jd.mjs` (zero-token ATS API), `archive-posting.mjs --report=N`, `jd-capture.mjs` |
| Tracker | `data/applications.md` (57 rows), `merge-tracker.mjs`, `set-status.mjs`, `data/status-log.tsv` |
| **Form filling** | `web/` apply session: headed real Chrome via Playwright, agentic drive that fills the whole multi-page form (`goal:"full"`), then hands the tab to you |
| Mail classification | `reply-watch.mjs`, `reply-matcher.mjs`, `paste-reply.mjs`, `invite-match.mjs` |
| Dashboard | `web/` — Next.js 16, pages for pipeline / jobs / apply / analytics / followups / explore, ~35 API routes |

So the real deltas are: **a DB**, **one orchestrator**, **a Gmail bridge**, **an approval
queue**, and **the final submit click**. Not a new system.

## The one genuine conflict, stated plainly

`AGENTS.md` and `web/README.md` make "never submit" a hard rule, and
`web/src/lib/apply/drive.ts:26` enforces it by construction — the agent's action
vocabulary has no submit, and `SUBMIT_RX` refuses any control that looks like one.

We are not removing that. The plan **does not touch `drive.ts`**. The AI keeps having
no submit action. Instead, a separate deterministic function — no model in the loop —
performs the click, and only when it holds a valid single-use approval token you
created by pressing a button. That keeps the property the rule actually protects
(no model ever decides to submit) while giving you what you asked for (you decide
once, not field by field).

Two consequences to accept up front:

- This install diverges from upstream on a stated principle. Keep it local; don't PR it.
- **Account-walled ATSs are out of scope.** Greenhouse, Lever, Ashby and Comeet are
  realistically automatable. Workday and iCIMS want an account, email verification
  and sometimes 2FA per employer; those get a `manual` verdict in the queue rather
  than a pretend attempt.

## Architecture

### Layer 1 — `data/careerops.db` (SQLite, derived index)

Node 24 ships `node:sqlite`, so this adds **zero dependencies**.

Markdown and TSV stay the source of truth. A build step folds them into SQLite so the
dashboard can answer "Israel AI roles scanned this week, triaged PASS, not yet applied"
as a query instead of a grep. Every existing `.mjs`, the Go TUI, and every mode doc keep
working untouched.

```
autopilot/db-build.mjs      # idempotent: drop + rebuild derived tables from files
```

| Table | Source | Rebuildable? |
|---|---|---|
| `jobs` | `data/pipeline.md`, `data/scan-history.tsv`, `jds/` | yes |
| `triage` | triage run output | yes |
| `reports` | `reports/*.md` front-matter + Machine Summary YAML | yes |
| `applications` | `data/applications.md` via `tracker-parse.mjs` | yes |
| `status_events` | `data/status-log.tsv` | yes |
| `submissions` | **owned here** — attempts, screenshots, answer sets, outcomes | no → mirrored to `data/submissions.tsv` |
| `mail` | **owned here** — Gmail thread ids, classifications, evidence | no → mirrored to `data/mail-sync.tsv` |
| `runs` | daily run log | no → mirrored to `data/runs/YYYY-MM-DD.json` |

The two tables the DB owns are append-only-mirrored to TSV under `data/` (user layer),
so a corrupted DB costs you an index rebuild, never history.

### Layer 2 — `autopilot/daily.mjs` (the routine)

One resumable, budgeted, logged pipeline. Each stage writes its own result so a failed
stage never costs you the earlier ones (the same discipline your `scan-all.mjs` already
applies to WhatsApp).

| # | Stage | Cost |
|---|---|---|
| 1 | `goozali-sync.mjs` (Mondays only) — keep `portals.yml` fed | zero-token |
| 2 | `scan-all.mjs` — WhatsApp drain + boards → `data/pipeline.md` | zero-token |
| 3 | Deterministic prefilter: host lane routing + `title-keywords.mjs` | zero-token |
| 4 | `fetch-jd.mjs` per survivor → `jds/`, skip on miss (agent fetches later) | zero-token |
| 5 | **Triage** — headless CLI over `modes/triage.md` + `_brief.md`, parse the `TRIAGE:` line | LLM, budgeted |
| 6 | **Evaluate** PASS rows → write `batch/batch-input.tsv`, run `batch/batch-runner.sh` | LLM, budgeted |
| 7 | Gmail sync (Layer 4) | LLM, small |
| 8 | `db-build.mjs` | zero-token |
| 9 | Health: `verify-pipeline.mjs`, `check-jd-archive.mjs` + write the run digest | zero-token |

Budgets (`--budget-triage=N`, `--budget-eval=N`) are hard ceilings; overflow stays
pending and is picked up tomorrow, in file order, the same determinism
`rank-pipeline.mjs`'s `selectBatch` already uses.

**Stage 3 is not the filter I first assumed it was.** Measured against the real
queue (191 pending rows): only 81 rows carry a location cell at all, and
`location_filter`'s documented rule is *empty location → pass*, so a location regex
cannot gate the other 110. And `fetch-jd.mjs` covers only Greenhouse/Lever/Ashby/
Workday (`JD_TEXT_API_ATS`) — about 8% of the current queue. The honest prefilter is
therefore **host lane routing**, not scoring:

| Lane | Hosts | What happens |
|---|---|---|
| `il-source` | `*.co.il`, `comeet.com`, `civi.co.il`, `director.org.il`, `referally.link` | Israel gate passes on host evidence — the `.il` inference signal `_brief.md` already sanctions. Straight to triage. |
| `api-jd` | greenhouse / lever / ashby / workday | `fetch-jd.mjs` first, then triage reads `local:jds/…` instead of fetching |
| `agent-fetch` | everything else | triage does its own WebFetch, exactly as `modes/triage.md` step 1 specifies |
| `manual` | `secrethunter.io` | **never sent to the LLM.** `portals.yml:3141` records that these URLs 302 to a signin wall, so triage can only ever return SKIP. 36 rows in the queue today — that is 36 guaranteed-wasted calls per run if this lane doesn't exist. |

**Scheduling:** Windows Task Scheduler, daily ~07:30, via
`autopilot/install-schedule.ps1` — the recipe in `docs/AUTOMATION.md` § "Windows —
Task Scheduler", and `scripts/followup-sweep.sh` as the working precedent for wrapping
a headless CLI call. Cloud `/schedule` agents are the wrong tool here: they cannot
reach `data/`, your Chrome profile, or the WhatsApp session. The machine must be awake
and logged in for the WhatsApp watcher; the board half degrades gracefully without it,
exactly as `scan-all.mjs` already guarantees.

**Scheduling:** Windows Task Scheduler, daily ~07:30, via
`autopilot/install-schedule.ps1`. Cloud `/schedule` agents are the wrong tool here —
they cannot reach `data/`, your Chrome profile, or the WhatsApp session. The machine
must be awake and logged in for the WhatsApp watcher; the board half degrades
gracefully without it, exactly as `scan-all.mjs` already guarantees.

### Layer 3 — the submit gate

```
web/src/app/autopilot/page.tsx              # the review + approve queue
web/src/app/api/autopilot/approve/route.ts  # mints the token
web/src/app/api/autopilot/submit/route.ts   # consumes it
web/src/lib/autopilot/submit.mjs            # the only code that clicks submit
autopilot/submissions.mjs                   # TSV mirror + tracker writeback
```

Flow for one job:

1. The queue row shows: triage score, report link, tailored CV PDF, **every drafted
   answer**, and a provenance note per answer (which `cv.md` / report line backs it —
   `verify-cv-facts.mjs` already does this check). Low-confidence answers are flagged,
   not hidden.
2. You edit anything you want, then press **Approve & Submit**.
3. That mints a single-use token bound to a hash of the exact approved answer set.
   Edit an answer afterwards and the token is dead — you re-approve.
4. `submit.mjs` then, in order:
   - opens an apply session and runs the **existing** `goal:"full"` drive to fill the form;
   - screenshots the filled form → `data/submissions/{id}/pre.png`;
   - **reads the rendered field values back and diffs them against the approved set** —
     mismatch aborts. This is the guard that catches the wrong form, the wrong job, or
     a drive that wandered;
   - clicks submit;
   - screenshots + captures the confirmation URL/text → `post.png`;
   - writes the `submissions` row, appends `data/submissions.tsv`, calls
     `set-status.mjs <report#> Applied --note` and `followup-seed.mjs`.

Hard blocks that a valid token does **not** override: an empty required field; a
duplicate `url_key` already submitted; a company in `data/blacklist.md`; more than
`max_daily_submissions`; an ATS on the account-walled list.

Start in `--no-click` dry-run: run five real applications end to end, inspect the
`pre.png` and the field diff, and only then enable the click.

### Layer 4 — Gmail → status

Gmail MCP is agent-side, so this is a small agent step inside stage 7, not a headless
script. It works today — no OAuth project to set up.

1. Agent searches threads since the last sync across ATS senders and tracker companies.
2. For each, emits JSON only: `{thread_id, company_guess, classification, evidence_quote}`
   where classification ∈ `ack | rejection | interview_invite | offer | recruiter_outreach | other`.
3. Output lands in `data/reply-candidates.json` — the format `paste-reply.mjs` already
   defines. **The agent never writes the tracker.**
4. Deterministic half: `reply-matcher.mjs` matches to rows; `set-status.mjs` applies only
   the unambiguous classes (`rejection` → Rejected, `ack` → Responded). `interview_invite`
   and `offer` always surface for your confirmation — they are high-stakes, and
   `invite-match.mjs` already ranks candidate rows when a company has several.

Per `AGENTS.md`, recruiter email is untrusted content: it is classified, never obeyed.

### Layer 5 — dashboard

Extend `web/`; add only new files so `git pull` stays conflict-free.

- **`/autopilot`** — the approval queue. The new center of gravity.
- **`/autopilot/runs`** — per-day: what came in, from which source, what each stage
  filtered and *why*. This is the "is it actually working?" view, and the thing you will
  read most in week one.
- **`/autopilot/submissions/[id]`** — evidence card: pre/post screenshots, the approved
  answers, confirmation text, and the Gmail thread timeline for that application.
- `/pipeline` gains SQLite-backed filters. `/analytics`, `/followups`, `/jobs/[id]` unchanged.

### Update safety

`update-system.mjs` checks out only its `SYSTEM_PATHS` list — `web/` is not in it, and
neither is anything new we add. It also reads `config/local-paths.txt` (gitignored,
absent today) as a user-layer declaration. Step one of Phase 1 is creating it:

```
autopilot/
web/src/lib/autopilot/
web/src/app/autopilot/
web/src/app/api/autopilot/
data/submissions/
data/careerops.db
```

Only one tracked file needs an edit ever: `web/src/lib/nav-items.ts`, one line, to show
the new pages. A one-line conflict on upstream pull is the entire maintenance cost.

## Integration map — what to reuse, and the only gaps

Every row below was checked against the actual file. "Reuse" means *import or invoke*,
not reimplement.

| Job | Reuse this | Gap |
|---|---|---|
| Whole-intake orchestration | `scan-all.mjs` (yours) — drains ingest queues, then boards, under one pipeline lock | none |
| Board freshness | `goozali-sync.mjs`, `discover-ats.mjs`, `audit-portals.mjs`, `dead-boards.mjs` | none |
| Parse pending rows | `rank-pipeline.mjs` → `parsePendingEntries()` | import |
| Annotate rows safely | `rank-pipeline.mjs` → `applyAnnotations()`, `formatRankSegment()`; `scan.mjs` → `sanitizeMarkdownField()` (maps `\|`→`/`, so a model reason can't forge a row) | import |
| Budget / determinism | `rank-pipeline.mjs` → `selectBatch()`, `LIMIT_CEILING` | import |
| Find + invoke a CLI headlessly | `rank-pipeline.mjs` → `CLI_CANDIDATES`, `detectCli()` (the `AGENTS.md` headless table, already encoded) | import |
| Cheap title-only ranking | `rank-pipeline.mjs` **as a whole script** — annotates `\| rank: X.X/5 — reason` | none |
| Triage scoring rules | `modes/triage.md` — reads only `_brief.md`, emits one machine-readable line | **nothing in the repo parses `TRIAGE:` today** |
| JD text, free | `fetch-jd.mjs` / `browser-extract.mjs` (`JD_TEXT_API_ATS` = gh/lever/ashby/workday) | none |
| JD archival + validation | `archive-posting.mjs --report=N`, `jd-capture.mjs`, `check-jd-archive.mjs` | none |
| **Full evaluation fan-out** | `batch/batch-runner.sh` — parallel workers, resumable `batch-state.tsv`, retries, rate-limit pause/resume, `--limit`, `--min-score`, `--skip-pdf`, model from `spend_tier`, report numbers via `reserve-report-num.mjs`, then `merge-tracker.mjs` → `reconcile-pipeline.mjs` → `verify-pipeline.mjs`. Already MSYS/Git-Bash aware. | **write `batch/batch-input.tsv`** (4 columns) |
| Tracker writes | `merge-tracker.mjs`, `set-status.mjs`, `followup-seed.mjs` | none |
| Tracker reads for the DB | `tracker-parse.mjs`, `tracker-aliases.json`, `find.mjs` | import |
| Locking | `pipeline-lock.mjs` → `withPipelineLock()` | import |
| Flags + self-test style | `lib/cli-flags.mjs`; the `--self-test` convention every script here follows | import |
| Run counters | `data/scan-runs.tsv` written by `scan.mjs`, read by `stats.mjs` | same pattern, new file |
| Health gates | `verify-pipeline.mjs`, `doctor.mjs`, `tracker-sync-check.mjs`, `check-jd-archive.mjs` | none |
| Scheduling recipe | `docs/AUTOMATION.md` § Windows; `scripts/followup-sweep.sh` as the wrapper precedent | port to `.mjs` |
| Funnel + analytics | `stats.mjs`, `funnel-velocity.mjs`, `web/src/lib/funnel-tiles.mjs` | none |
| "Run a mode" from the web | `web/src/app/api/run/route.ts`, `lib/run-prompts.mjs`, `lib/spawn-cli.mjs` | hook into it |

**Net new code for Phases 1–2: three scripts.**

```
autopilot/triage-run.mjs   ~150 lines  — lane routing + CLI loop + TRIAGE: parser
autopilot/daily.mjs        ~200 lines  — stage sequencing, budgets, run digest
autopilot/db-build.mjs     ~250 lines  — files → SQLite (node:sqlite, zero deps)
autopilot/install-schedule.ps1          — Task Scheduler registration
```

Everything else is invoking what exists. `rank-pipeline.mjs` and `batch-runner.sh` are
both **system layer** (`SYSTEM_PATHS`), so they get imported and invoked, never edited.

## What the repo's own health checks say right now

Run before planning, because it changes what Phase 2 should even do. Corrections to my
first read, which assumed the intake config was the problem:

**The config is already clean.** ByteDance/DeepSeek (the Feishu provider that once
flooded a scan with 561 Chinese postings), Nortal, BMW, CARIAD/Volkswagen, all 8
SolidJobs divisions (a *Polish* board, including Marketing/Sales/HR/Logistics) and
SecretHunter are **all `enabled: false`** already, and `location_filter` carries a
27-keyword Israel allow-list. A previous session did that work on 2026-09-19.

What's actually wrong is downstream residue and one live gap:

1. **7 of the biggest Israeli employers are silently skipped on every scan.**
   `verify-pipeline.mjs` check 15: Microsoft, Google, Meta, Apple, IBM, Qualcomm and
   Palo Alto Networks are `enabled: true` with Israel-filtered careers URLs that **no
   provider claims** — so `scan.mjs` skips them without naming them, while they read as
   coverage. This is the highest-value fix in the whole plan and it needs no new code:
   `node discover-ats.mjs Microsoft Google Meta Apple IBM Qualcomm "Palo Alto Networks"`
   probes for a scannable board and previews entries (`--write` to apply).
2. **191 pending rows are pre-cleanup residue.** Roughly 80 come from sources now
   disabled (36 SecretHunter, 29 SolidJobs, 13 Nortal) — they will never be re-added,
   but they still sit in `## Pending` waiting to be triaged. Triaging them costs tokens
   to reach a foregone conclusion. Prune to match current config before the first run.
3. **~12 duplicate report pairs and ~21 orphan reports.** The 09-19 and 09-20 batches
   evaluated the same companies twice (Check Point ×4, EY, Comblack, Connecteam, Retym,
   Nitro, DeWeb, Iscar ×2, Annapurna, IAI, Mobileye), and ~21 reports were written but
   never merged into the tracker. The DB and every dashboard count will be wrong until
   this is reconciled.
4. **`stats.mjs` on today's data:** 55 tracker rows — 28 Evaluated, 25 SKIP, 2 Applied,
   0 responses. Average fit **1.6/5** (3.3 among pursued). Filters already remove 86.1%
   of 5327 found per run. That average is the whole argument for this plan: the
   evaluation budget has been going to roles that were never a fit.

## Phasing

| Phase | Ships | Why this order |
|---|---|---|
| **0 — Repair (no code)** | `discover-ats.mjs` for the 7 skipped giants · prune pending residue · reconcile duplicate/orphan reports · clear the two `pipeline.md` backups | Pure config and existing commands. Fixes the intake before automating on top of it, and makes every later number trustworthy. Half a session. |
| **1 — Foundation** | `config/local-paths.txt`, `autopilot/db-build.mjs`, `/autopilot/runs` read-only | No behavior change. Proves the DB and gives visibility before anything runs unattended. |
| **2 — Daily routine** | `autopilot/triage-run.mjs`, `autopilot/daily.mjs`, Task Scheduler, budgets | End state: every morning a lane-routed, triaged, JD-archived, evaluated shortlist. **Fully useful on its own.** |
| **3 — Gmail** | Stage 7, safe-class auto-apply, mail timeline | Status accuracy matters more once volume rises. |
| **4 — Submit** | Approval token, `/autopilot` queue, `submit.mjs`, dry-run then live | Last, deliberately. A submit button on a bad shortlist is a machine for applying badly. |

Phase 0 is new since the first draft, and it is the one I would not skip: automating on
top of an intake that silently misses Microsoft and Google — while re-triaging 80 dead
rows — would bake both mistakes into a daily schedule.

## Things worth adding that you did not ask for

1. **Telegram intake — one flag, not new work.** `portals.yml` already carries
   `Telegram @jobforjunior` with `provider: telegram-channel` (read via the public
   `t.me/s/` web preview), sitting at `enabled: false`. Same population as your WhatsApp
   groups, zero tokens. Flip it in Phase 0 and see what one scan brings in.
2. **Warm intros in the queue** (you approved this). `linkedin-join.mjs` +
   `docs/LINKEDIN_JOIN.md` answer "do I know anyone here?" — zero-token, offline,
   read-only, and explicitly never a scoring input. It needs `data/Connections.csv`,
   which is **not present yet**: request the export from LinkedIn (Settings → Data
   privacy → Get a copy of your data → Connections), drop the CSV in `data/`, and it
   works. For a June-2026 grad a referral outperforms a cold submission by enough that
   this belongs next to **Approve & Submit**, where it changes what you do with the row.
3. **Follow-ups as Gmail drafts.** `followup-cadence.mjs` already knows what is overdue.
   Draft them into Gmail (`create_draft`, never `send_message`) so sending stays one click
   and zero composition.
4. **Calibrate after ~20 applications.** `calibrate.mjs` checks whether triage scores
   actually predict interviews. If your 4.5s and your 3.6s convert the same, the gates in
   `_brief.md` are wrong and the fix is upstream of everything here.
5. **Reposts as a signal.** `detect-reposts.mjs` flags roles relisted repeatedly — often
   a sign of a role that is not really being filled. Cheap negative signal in the queue.

## Housekeeping to settle before building

1. **`career-ops/` stays** (your call, 2026-09-25) — a second full copy of the repo nested
   inside it, untracked, ~200 files. Because it stays, every new script must exclude it
   explicitly: `db-build.mjs` walking `reports/` or `jds/` would otherwise index it twice,
   and `Glob`/`grep` sweeps over the tree are measurably slower through it. Concretely:
   `autopilot/*` takes its roots from `path-resolver.mjs` (`getCareerOpsRoot()`) rather
   than any recursive walk, and the one place a walk is unavoidable — report discovery —
   skips `career-ops/`, `node_modules/`, and `web/node_modules/` by name.
2. **`package.json` is modified vs. HEAD** — your WhatsApp scripts, `whatsapp-web.js`,
   `qrcode-terminal`, `patch-package`. Fine, but it will conflict on the next upstream
   pull; worth knowing before it happens mid-build. Phase 2 adds `autopilot:*` scripts
   to the same block, so the conflict surface stays one hunk.
3. **Confirm gitignore** covers `.wwebjs_cache/`, `data/whatsapp-session/`, `Uri_Personal/`
   (it holds a personal PDF), and — once it exists — `data/careerops.db`.
4. Moved into Phase 0: the two stale `data/pipeline.md` backups
   (`.bak-2026-09-22`, `.pre-reconcile.bak`).
