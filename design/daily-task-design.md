# Daily Task — Complete Design

**Written:** 2026-09-30 · **Status:** design, agreed scope, not yet built.
**Builds on:** `design/autopilot-plan.md` (Layers 1–2), `design/tailor-apply-handoff.md` (prepare.mjs).

## 1. Decisions (2026-09-30)

| Topic | Decision |
|---|---|
| End point | **Intake → triage → prepare.** The daily run stops after `prepare.mjs` stages A–C (free) on every new PASS job. No tailoring, no evaluation, no submission. |
| Trigger | **Windows Task Scheduler on this PC**, once a day. The website "Run daily now" button stays as the manual trigger. |
| Reporting | **Email to yourself** + **website `/autopilot/runs`**. |
| Gmail replies | **Not yet.** Revisit once the intake has run cleanly for a couple of weeks. |

Carried over (still binding): no evaluations, no submissions (you click Submit), no
system-layer edits, never walk `career-ops/`, ask before any LLM spend beyond the
triage budget.

## 2. The whole process, end to end

```
              ┌──────────────── AUTOMATIC (every day, 17:30) ────────────────┐
              │                                                                   │
 Task         │  0 preflight ─► 1 goozali ─► 2 scan ─► 3 enrich ─► 4 triage ─►    │
 Scheduler ──►│  5 prepare ─► 6 db-build ─► 7 health ─► 8 report (email + web)    │
              └───────────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
              ┌──────────────── YOU (when you have time) ─────────────────────────┐
              │  read email → gate 1: tailor or skip each prepared job            │
              │  → tailor CV (1 LLM call, on demand) → gate 2: approve PDF        │
              │  → form filled in Chrome → YOU click Submit → tracker = Applied   │
              └───────────────────────────────────────────────────────────────────┘
```

## 3. Stages

| # | Stage | What it does | Reads → Writes | Cost | Status |
|---|---|---|---|---|---|
| 0 | **preflight** | Refuse to start if another run holds the pipeline lock; check network; note whether the WhatsApp session exists (missing ⇒ boards-only, not a failure). | — | free | **new** |
| 1 | **goozali** | Mondays only. Israeli company directory → *report* of boards missing from `portals.yml`. Never writes `portals.yml` unattended. | directory → run report | free | built |
| 2 | **scan** | `scan-all.mjs`: drain 14 WhatsApp groups, then ~320 boards. New URLs only (dedup via `scan-history.tsv`). | web → `data/pipeline.md` Pending, `scan-history.tsv`, `scan-runs.tsv` | free, ≤40 min | built, **timeout issue** |
| 3 | **enrich** | Fill Company / Title / Location for bare links (mostly WhatsApp). | `pipeline.md` → `pipeline.md` | free | built |
| 3b | **dedup** | Same job from two sources (e.g. WhatsApp LinkedIn link + Lever link): company+role match after enrich; duplicate marked `dup-of:`, never triaged; kept row lists `also-seen`. See §11. | `pipeline.md`, tracker → `pipeline.md` | free | **new** |
| 4 | **triage** | Route each untriaged row to a lane (`il-source` / `api-jd` / `agent-fetch` / `manual`). Fetch the JD to `jds/`. One `claude -p` call per row against `modes/triage.md` + `modes/_brief.md` → `PASS / MARGINAL / SKIP / FAIL` + score + reason. | `pipeline.md`, `_brief.md` → `pipeline.md` annotations, `jds/` | **LLM, ≤60 rows/day** | built, **2 defects** |
| 5 | **prepare** | For each PASS row triaged and not yet prepared: `prepare.mjs` A–C — confirm the posting is live, archive the JD, preflight (tracker duplicate, blacklist, account-walled ATS, repost, "N+ years" asks), skill gap vs `cv.md`, stub report + bundle. | `pipeline.md`, `jds/`, `cv.md` → `reports/NNN-*.md`, `output/NNN-*/`, tracker row | free, ≤15 jobs/day | **new** (wraps existing `prepare.mjs`) |
| 5b | **auto-tailor** | READY jobs only, ≤5 per run: check `CVs/` first (reuse = free); otherwise tailor and save to `CVs/<Role>/`. **Max 3 LLM tailors per run.** See §9. | `CVs/`, bundle, `cv.md` → bundle `cv/tailored/`, `CVs/<Role>/` | **LLM, ≤3/day** | **new** (wraps existing `tailor.mjs`) |
| 6 | **db-build** | Rebuild `data/careerops.db` from the files. | all files → db | free | built |
| 7 | **health** | `verify-pipeline.mjs` + `check-jd-archive.mjs`. | — | free | built |
| 8 | **report** | Write the digest; send the email; website reads the same data. | → `data/runs/{date}.json`, `data/autopilot-runs.tsv`, email | free | built, **email not configured** |

A stage failing never cancels the stages before or after it (except: triage failing ⇒
prepare has nothing new, which is fine).

### Stage 5 detail — what "prepare" produces per job

For each new PASS job you get, before you've touched anything:

- **Verdict line** for the email: `READY` / `CHECK` / `BLOCKED`
  - `BLOCKED` — posting closed, already Applied in tracker, blacklisted company
  - `CHECK` — "N+ years required" above your experience, account-walled ATS (Workday/iCIMS/LinkedIn), repost signal
  - `READY` — none of the above
- `reports/NNN-{company}-{date}.md` — triage-only stub with the JD archived verbatim
- `output/NNN-{company}-{role}/` — JD, skill gap, `state.json` (rerun-safe: never re-reserves a number)
- A tracker row via TSV + `merge-tracker.mjs`, status `Evaluated`, note `triage-only` — so the
  job appears in the dashboard and `verify-pipeline` stops warning about an orphan report.

MARGINAL rows are **not** prepared automatically; they are listed in the email so you can
run `prepare.mjs --job … --allow-marginal` on any you want.

## 4. Schedule

- Task name `career-ops autopilot daily`, **17:30 daily**, per-user, runs only when logged in
  (WhatsApp needs the session).
- *Run as soon as possible after a missed start* = on (PC was asleep ⇒ runs on wake).
- *Do not start a new instance* if one is running; *stop the task* after 120 min.
- Registered with `autopilot/install-schedule.ps1` (exists, never run). Unregister with `-Uninstall`.

## 5. Failure handling

| Situation | Behavior |
|---|---|
| PC off / asleep at 17:30 | Runs when you log in. |
| WhatsApp session missing/expired | Boards still scanned; email says "WhatsApp skipped — rescan QR". |
| Scan hits 40 min | Partial results kept; email names the board it stalled on. |
| Claude quota exhausted | After 3 consecutive CLI failures triage **stops**; rows stay pending for tomorrow. No more doomed calls. |
| A stage crashes | Digest stores the **last 20 lines of stderr** (not just "Command failed"), so the cause is visible on `/autopilot/runs` and in the email. |
| Posting closed by prepare time | Marked `BLOCKED — closed`; nothing else happens. |
| Email not configured | Skipped with a one-line note; the website still has everything. |

## 6. Your review — from the phone (see §13)

1. ~17:30–18:30 the **apply-kit email** arrives: `Autopilot 2026-10-01 — 2 READY · 1 CHECK · 7/7 stages ok`.
2. Per READY job: open the attached CV (this *is* gate 2) → tap **Apply** → fill the form
   on the phone, upload the attached CV → **you tap Submit**.
3. Tap **"I applied"** on the private page (Tailscale) → tracker `Applied` + follow-up date.
   Or **"Skip"** → tracker `SKIP`.
4. Long / account-walled forms (Workday, iCIMS): leave for the PC auto-fill queue
   (`design/tailor-apply-plan.md` stage E).

## 7. Build list (in order)

| # | Work | Why first |
|---|---|---|
| 1 | Fix `triage-run.mjs`: stop echoing the prompt into errors; quota breaker (3 consecutive failures ⇒ stop) | Must not burn quota unattended |
| 2 | `daily.mjs`: store stderr tail per failed stage | Can't debug unattended runs without it |
| 3 | `prepare.mjs --new-pass` (loop over PASS rows without `state.json`, cap 15, summary table with READY/CHECK/BLOCKED) + tracker row via TSV | The new stage |
| 4 | `daily.mjs` stage 0 preflight + stage 5 prepare | Wire it in |
| 5 | Email: add READY/CHECK/BLOCKED + MARGINAL sections; you create the Gmail app password | Your morning view |
| 6 | `/autopilot/runs`: show prepared jobs with links to bundles | Web view |
| 6b | Stage 5b auto-tailor in `daily.mjs`: READY only, ≤5 jobs, ≤3 LLM tailors, `tailor-pending` carry-over, CV line in the email | Your chosen auto-tailor |
| 6c | Stage 3b dedup: company+role match after enrich, `dup-of:` marker, "also seen on" (§11) | No double triage |
| 6d | Source tracking: WhatsApp group on each lead, `source` column in `jobs`, weekly Sources table (§12) | Know which platforms work |
| 6e | Apply-kit email (CV attached, Apply button, intro text) + Gmail drafts for "send CV to" jobs (§13) | Apply from the phone |
| 6f | Phone page `/autopilot/today` (I applied / Skip) + Tailscale setup (§13) | Record from the phone |
| 7 | Scan timeout: log the stalling board; if it recurs, rotate board order per day | Make coverage fair |
| 8 | Two clean manual runs, watched → then `install-schedule.ps1` | Your "watch first" rule |

Items 1–7 cost no LLM tokens to build or test (self-tests + `--budget 0` runs).
The first real triage spend is the watched manual run in item 8.

## 8. Answered 2026-09-30

- **Run time: 17:30** (not 07:30). Register with `install-schedule.ps1 -Time "17:30" -BudgetTriage 60`.
- **Triage budget: 60 rows/day.** At ~20–30 s per call that's up to ~30 min, so raise
  `TRIAGE_STAGE_TIMEOUT_MS` in `daily.mjs` from 20 to 40 min, and the task's
  stop-after limit from 90 to 120 min (scan ≤40 + triage ≤40 + the rest).
- **Tracker row on prepare: yes**, status `Evaluated`, note `triage-only`.
- The `data/pipeline.md` reset between 09-26 and 09-28 was **intentional** (user, 2026-09-30). Nothing to restore.

## 9. Stage 5b — auto-tailor (added 2026-09-30)

Runs right after prepare, on **READY jobs only** (never CHECK / BLOCKED / MARGINAL),
**at most 5 jobs per run**, highest triage score first. Uses the existing
`autopilot/tailor.mjs` + `autopilot/cv-library.mjs`, so no new tailoring logic.

For each job, the CV library `CVs/` is checked first (no LLM call):

| Library finds… | Decision | LLM calls | Counts toward the 3? |
|---|---|---|---|
| A fresh CV for the **same role family** (`CVs/<Role>/`, any company) | `reuse` — copy it into the job bundle | 0 | no |
| No CV for this role, but a **related role** has one (`RELATED` map, e.g. Software_Engineer ↔ AI_ML_Engineer) | `reuse-with-edits` — tailor starting from that CV | 1 | **yes** |
| Nothing fitting, or `cv.md` changed since the CV was made (stale) | `tailor` from `cv.md` | 1 | **yes** |

**Hard cap: at most 3 LLM tailors per daily run**, no matter what. Once 3 are used,
remaining READY jobs that need a tailor are marked `tailor-pending` and picked up
in the next run. Reuses are free and are not capped (but still ≤5 jobs total).

Every new tailor is:
1. fact-checked (`verify-cv-facts.mjs`, a hard stop; a failure leaves the job with no CV, reported in the email),
2. rendered to one page (`--max-pages=1 --strict-pages`),
3. copied into the job bundle `output/NNN-…/cv/tailored/v001/`, and
4. **saved to `CVs/<Role>/`** as that role's CV (`Uri_Levy_CV.pdf`, `render.json`,
   `source_jd.md`, `meta.json`); the previous one moves to `CVs/<Role>/history/vNNN/`,
   never overwritten.

So the library grows by itself: the first Data Engineer job gets tailored, and every
later Data Engineer job reuses it for free until `cv.md` changes.

**Role matching is by job title** (`classifyRole()` — Data_Scientist, Data_Engineer,
AI_ML_Engineer, DevOps_Engineer, QA_Automation_Engineer, Frontend_Engineer,
Software_Engineer; anything else gets its own folder). JD word-overlap is shown in the
email as information, never used to block a reuse.

The two PDF-only folders (`Big Data & Data Infrastructure Engineer`, `Experienced Software Engineer - Data Infrastructure`) are the user's own files: left untouched and ignored by the library (decided 2026-09-30).

Quota: tailor calls go through the same CLI + quota breaker as triage; if the quota is
gone, remaining jobs become `tailor-pending`, not failures.

Email adds per job: `CV: reused CVs/AI_ML_Engineer (v1)` / `CV: tailored → saved as CVs/Data_Engineer` /
`CV: pending (cap reached)` / `CV: fact check failed — <line>`.

You still approve every CV at gate 2 before anything is filled — a reused CV included.

## 10. Boundary with applying

The daily task and applying are **separate processes**, joined by one thing: the prepared
bundle `output/NNN-{company}-{role}/` + its `state.json` + the tracker row.

| | Daily task | Apply |
|---|---|---|
| Trigger | Task Scheduler, 17:30 | You, per job |
| You present? | No | Yes: three gates, headed Chrome, your Submit click |
| LLM cost | Triage only, capped | ~2–3 calls per job you choose |
| Ends at | `state.json` = `gap` (prepared) | `state.json` = `submitted`, tracker `Applied` |

Apply is stages D–F in `design/tailor-apply-plan.md`; it resumes from the bundle and
never re-triages or re-prepares. With §13 the default apply path is the **phone**; the
PC auto-fill queue is kept for long or account-walled forms.

## 11. Stage 3b — cross-source dedup (added 2026-09-30)

**Today:** the board scan dedups by normalized URL **and** company+role against the
tracker, `pipeline.md` and `scan-history.tsv` (`collectSeenCompanyRoles()` in
`scan.mjs`). WhatsApp intake (`plugins.mjs`) dedups by **exact URL only**, and most
WhatsApp rows have no company/title until stage 3 (enrich) fills them. So the same job
arriving as a LinkedIn link (WhatsApp) and a Lever link (board) is triaged twice.

**New stage 3b, between enrich and triage** (free):
- Build the company+role key for every untriaged row with the same functions `scan.mjs`
  uses (company canonicalizer + role normalization) — import, never reimplement.
- Compare against: tracker rows, already-triaged `pipeline.md` rows, and earlier rows
  in the same untriaged batch.
- A duplicate gets `| dup-of: <first url>` and is ticked `[x]` — **never triaged**.
- The kept row gets `| also-seen: whatsapp:<group>, lever` so no source is lost.
- Prefer keeping the row with a real ATS URL (it has an API JD and a direct apply form)
  over a LinkedIn/WhatsApp link.
- Rows still bare after enrich (no company or title) can't be matched — they pass
  through; prepare's tracker-duplicate check is the backstop.

## 12. Source tracking (added 2026-09-30)

**Today:** boards record their platform in `scan-history.tsv` (`portal` column:
greenhouse-api, ashby-api, gsheet-csv-api, …). WhatsApp leads in
`data/whatsapp-leads.jsonl` do **not** record the group. Nothing reports results per source.

**Changes:**
- `plugins.local/whatsapp/watch.mjs`: add `group` to each lead line (user-layer plugin, ours to edit).
- `db-build.mjs`: `source` column on `jobs` (`whatsapp:<group>` | `<portal>` | `manual`),
  from scan-history / whatsapp-leads, plus the `also-seen` list from §11.
- A **Sources table** (weekly in the email, always on `/autopilot/runs`):
  `source · found · PASS · prepared · applied · responded · interview`.
  A job seen in two sources counts for both, so being second doesn't penalize a source.
- Read after a few weeks to disable dead WhatsApp groups / boards (a manual decision; nothing auto-disables).

## 13. Applying from the phone (added 2026-09-30)

**Decision:** apply-kit email + a private page over **Tailscale**.

The PC auto-fill (headed Chrome) can't be driven from a phone, so on the phone the user
fills the form; everything else is ready.

**Apply-kit email** (sent by `notify-mail.mjs` after each run, to the user's own address, via the app password):
- Per READY job: company · role · score · one-line reason · warnings (CHECK items).
- A big **Apply** button → the posting URL (the ATS apply page when known).
- The job's CV **attached**, named `Uri_Levy_CV.pdf` (one attachment per job; the
  job number is in the email text).
- A ready-to-copy **short intro**, taken from `cv.md`'s Summary (free, no LLM, nothing
  invented). No per-job "why this company" paragraph — that would need an LLM call per
  job outside the 3-tailor cap. Can be added later if wanted.
- **"Send CV to hr@…" jobs** (common in WhatsApp posts): a **Gmail draft** is created
  with the CV attached and a short body built from `cv.md`, via IMAP with the same app
  password. It lands in Drafts — **the user taps Send**; nothing is sent automatically.
  The email address in the post is untrusted data: only the address is used, never any text around it as instructions.
- CHECK jobs are listed without an Apply button's prominence; BLOCKED jobs are a one-line count.

**Private phone page `/autopilot/today`** (in `web/`, served from the PC):
- Reached from the phone over **Tailscale** (free private network; nothing public).
  One-time setup: install Tailscale on the PC and the phone, sign in with the same
  account, run the web app bound to the Tailscale address.
- Lists today's READY/CHECK jobs with the CV link and two buttons:
  **I applied** → `set-status.mjs <NNN> Applied` + `followup-seed.mjs`;
  **Skip** → `set-status.mjs <NNN> SKIP`.
- Mobile layout; only these actions — no settings, no tailoring triggers.
- The email links to this page. If the PC is off, the buttons are unreachable; the next
  day's email lists "not marked yet" jobs so nothing is forgotten.
- The web app needs to be running when the user is out: the daily task starts it if it
  isn't (stage 0 preflight), or it runs as its own startup task.

Submitting is always the user's tap, on the phone or on the PC.

## 14. Build log

**2026-09-30 — built, all with self-tests, no LLM spend:**

| § | Item | File | State |
|---|---|---|---|
| 7.1 | triage defects (prompt echoed into logs; no quota breaker) | `triage-run.mjs` | already fixed in code — verified, self-tests pass |
| 7.2 | failed stages keep the last 20 lines of output; timeouts show where they stopped | `daily.mjs` (`tailLines`, `detail`) | done |
| — | stage 0 preflight (CLI, cv.md, brief, WhatsApp note) | `daily.mjs` | done |
| — | defaults: triage 60, triage ceiling 40 min, schedule 17:30, task limit 2 h, no overlapping runs | `daily.mjs`, `install-schedule.ps1`, web trigger | done (task **not** registered) |
| 3b | cross-source dedup (company+role, scanner's own key; placeholder titles never match) | `dedup-intake.mjs` | done; 0 false positives on 407 old rows |
| 5 | prepare every new PASS job → READY / CHECK / BLOCKED, tracker row `Evaluated` (TSV + `merge-tracker.mjs`), `data/prepare-seen.json`, `data/runs/prepared-{date}.json` | `prepare-new.mjs` | done |
| 5b | auto-tailor: READY only, ≤5 jobs, ≤3 LLM calls, `CVs/` first, quota breaker | `auto-tailor.mjs` | done |
| 8 | apply-kit email: cards, Apply button, CV attached, CV status, pasteable intro | `apply-kit.mjs`, `notify-mail.mjs` | done; **not yet sent** (no app password) |

First integration run (`--skip-scan --skip-enrich --skip-triage`): 10/10 stages ok.

**Findings:** 12 of the 13 current PASS jobs already had bundles (prepared earlier), so the
first real run will only prepare genuinely new PASS jobs; Staffin Israel is closed.
`prepare-new.mjs` must not call `process.exit` after network calls (libuv assertion on
Windows) — it sets `process.exitCode` instead.

**Not built yet:** §12 source tracking (WhatsApp group on each lead, `source` column, Sources
table) · §13 phone page `/autopilot/today` + Tailscale · `/autopilot/runs` view of prepared
jobs · Gmail drafts for "send CV to" jobs (needs an IMAP dependency — decision pending) ·
scan-stall logging beyond the new output tail · the two watched runs · registering the task.

**2026-09-30 (later) — also built:**

| § | Item | File | State |
|---|---|---|---|
| 12 | source log: the WhatsApp watcher now keeps the group per link (the queue file is deleted after each drain) | `plugins.local/whatsapp/watch.mjs` → `data/whatsapp-sources.jsonl` | done; only links seen from now on have a group |
| 12 | per-source funnel found → PASS → prepared → applied → responded → interview; a duplicate credits its source to the kept job | `sources.mjs` → `data/runs/sources.json` (daily stage `sources`; Monday email table) | done |
| 13 | **phone page** — see the design change below | `phone-server.mjs`, `install-phone-server.ps1` | done, tested locally; **needs Tailscale + `.env` values to be reachable from the phone** |
| 13 | email "I applied / Skip" button carries a one-time login token | `notify-mail.mjs`, `apply-kit.mjs` | done |

**Design change to §13:** the phone page is **not** a page of the Next.js dashboard. Every `/api`
route there can run scripts and is gated to localhost on purpose (`proxy.ts` / `origin-guard.mjs`);
allowing the Tailscale host would have exposed all of them to every device on the tailnet.
Instead `autopilot/phone-server.mjs` is a ~300-line zero-dependency server that serves only the job
list, the CV PDFs and two buttons. Protections: secret token (cookie, constant-time compare), same-origin
POSTs only, report numbers validated against known jobs, PDF path never taken from the URL, and it binds
to `127.0.0.1` unless you set `AUTOPILOT_PHONE_HOST` (your Tailscale IP). "I applied" / "Skip" go through
`set-status.mjs` (which seeds the follow-up); a job with no tracker row yet gets one via TSV + `merge-tracker.mjs`.

**Your setup for the phone (about 15 min):**
1. `.env`: `AUTOPILOT_PHONE_TOKEN` (generate: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`),
   `AUTOPILOT_PHONE_HOST` = `tailscale ip -4`, `AUTOPILOT_PHONE_URL` = `http://<that ip>:4317`.
2. Install Tailscale on the PC and the phone, same account.
3. `.\autopilot\install-phone-server.ps1` (starts it at logon), then `node autopilot\phone-server.mjs --print-link`
   and open that link once on the phone.

**Also done:** `/autopilot/runs` now shows Prepared jobs (last 3 runs) and the Sources table (`web/src/lib/autopilot/prepared-read.mjs`, 4 tests; checked rendering live).

**Still to build:** Gmail drafts for "send CV to" jobs
(pending the IMAP-package decision) · the two watched runs · registering the 17:30 task.
