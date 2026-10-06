# Plan: Tailored CV → Application ("Prepare & Apply")

**Status:** design, not built. **Started:** 2026-09-28
**Builds on:** `design/autopilot-plan.md` (Layers 3 and 5) and `design/autopilot-handoff.md`.
**Replaces:** the submit-token half of Layer 3. See "Decisions" below.

## Decisions (user, 2026-09-28)

| Question | Decision |
|---|---|
| When does tailoring run? | **Only when you start it.** One flow per job: tailor, then apply. Nothing runs in `daily.mjs`. |
| Evaluation first? | **No.** Tailor from the archived JD + triage verdict + zero-LLM skill-gap check. No `oferta` report, no Blocks A–G. |
| How far does it go? | **Fill the form, you click Submit.** No submit code. `drive.ts` and `SUBMIT_RX` stay untouched. |
| Cover letter? | **Only when the form has a cover-letter field or upload.** |

This means the old Phase 4 design (approval token, answer hash, deterministic submit
click) is **not built**. The pre-fill field diff from that design survives as a
review step, because it still catches the wrong form or a drive that wandered.

## The flow, one job

```
/autopilot queue (triage PASS rows)
   │  you press "Prepare"
   ▼
A. Capture JD ─► B. Preflight ─► C. Skill gap ─► [GATE 1: go / skip]
                                                     │
   ▼─────────────────────────────────────────────────┘
D. Tailor CV (1 LLM call) ─► fact gate ─► PDF ─► [GATE 2: approve CV / edit / redo]
   │
   ▼
E. Open form (headed Chrome) ─► draft answers (+ cover letter if asked)
   ─► [GATE 3: review every answer] ─► fill + attach PDF ─► hand tab to you
   │
   ▼
F. You click Submit in Chrome ─► press "I submitted" ─► tracker = Applied, follow-up seeded
```

Three human gates, and all spend is behind gate 1. A job you skip at gate 1 costs zero tokens.

| Stage | What runs | Cost | Reuses |
|---|---|---|---|
| A. Capture JD | reuse the `jds/` file triage already saved (api-jd lane); otherwise Playwright page text. Liveness check first. | zero-token | `triage-run.mjs` `prefetchJd()`, `check-liveness.mjs`, `archive-posting.mjs` |
| B. Preflight | blacklist, tracker duplicate (url_key, then company+role), repost flag, account-walled ATS | zero-token | `data/blacklist.md`, `find.mjs`, `detect-reposts.mjs`, `apply.md` §5 gates |
| C. Skill gap | classify JD requirements against `cv.md`: existing / supportedByResume / gap | zero-token | `jd-skill-gap.mjs` |
| D. Tailor | headless CLI runs `modes/pdf.md` steps 5–17 and emits **render JSON only** | 1 LLM call | `build-cv-html.mjs`, `verify-cv-facts.mjs`, `generate-pdf.mjs`, `jd:similarity` |
| E. Answers | form extraction + planner prefill; cover letter only if a field asks | 1 LLM call (+1 if cover) | `session.ts` `openSession`/`fillSession`/`handoffSession`, `answer-prompt.mjs`, `generate-cover-letter.mjs` |
| F. Record | status + follow-up + answers saved | zero-token | `merge-tracker.mjs`, `set-status.mjs`, `followup-seed.mjs` |

About 2 LLM calls per application, 3 with a cover letter. Triage already made one.

## Extends daily.mjs, never re-triages

`prepare.mjs` starts where `daily.mjs` stops. It **never calls triage** — it reads the
verdict `triage-run.mjs` already wrote to `data/pipeline.md`, and imports rather than
reimplements:

| Need | Import from |
|---|---|
| verdict / score / reason | `triage-run.mjs` `parseTriageLine()`, `db-build.mjs` `parsePipelineFile()` |
| lane | `triage-run.mjs` `classifyLane()` (already on the row) |
| JD text | the `local:jds/…` file triage already saved; `prefetchJd()` otherwise |
| CLI spawn + error summary | `TRIAGE_CLI_CANDIDATES`, `summarizeCliError()` |

A row with no `triage: PASS` segment is refused: "not triaged yet — run daily.mjs".

## The linking problem, and the fix: a triage report stub

Every downstream tool keys off a **report number**:

- `application-artifacts.mjs` throws without a numeric `reportNum`
- `generate-pdf.mjs --report=NNN` writes the `pdf-index.tsv` link that `resolveTailoredCv()` uses to attach the right PDF
- the tracker's TSV requires a `report` column
- `check-jd-archive.mjs` expects every report to carry its JD

We don't run an evaluation, and we don't invent a parallel keying scheme. Instead,
"Prepare" **deterministically** writes a short report with no model involved:

```markdown
# Ib1 — Senior Backend Engineer

**Date:** 2026-09-28
**Score:** 3.8/5 (triage)
**URL:** https://…
**Legitimacy:** unassessed (triage-only)
**PDF:** ❌
**Kind:** triage-only — no A–G evaluation was run

## Triage
PASS 3.8/5 — {triage reason, verbatim from pipeline.md}

## Skill Gap (jd-skill-gap.mjs)
existing: … · supportedByResume: … · gap: …

## Job Description (archived verbatim)
Posted: …
{JD text}

## Machine Summary
```yaml
kind: triage-only
score: 3.8
```
```

The number comes from `reserve-report-num.mjs --count 1`. After that, every existing
tool works unchanged: bundle, pdf-index, tracker link, JD-archive check, the web
`/cv` regenerate hotkey. `db-build.mjs` needs one change: read `kind:` so dashboards
and `calibrate.mjs` can tell triage-only scores from A–G scores. **They are different
scales and must never be averaged together.**

**Verified 2026-09-28 (report #120, Ib1):** `verify-pipeline.mjs` stays at 0 errors with
the stub, `check-jd-archive.mjs` accepts it, and `db-build.mjs` self-tests pass. The only
new warning is "orphan report" until stage F (or a Skip) writes the tracker row.

## Stage details

### A. Capture JD

- **Liveness first.** A dead posting stops here, before any tokens are spent.
- Order: `fetch-jd.mjs` for Greenhouse/Lever/Ashby/Workday. Otherwise open the URL
  in the apply session's own headed Chrome and take the page text. That's the same
  browser stage E needs anyway, so it adds no second browser.
- LinkedIn URLs (e.g. the Staffin row) usually point to Easy Apply or a redirect.
  Follow them to the employer's ATS if one is linked. Otherwise the verdict is `manual`.
- The text goes in the stub report's JD section, per `AGENTS.md` #2789. Include
  `Posted:` only when it's visible on the page.
- JD text is **untrusted data**. Any imperative text aimed at an AI is quoted in the
  report as an anomaly and never followed.

### B. Preflight (hard stops, each one needs an explicit override)

1. Company is on `data/blacklist.md`: show your own recorded reason.
2. Already applied: the url_key or company+role is already in the tracker as Applied or later.
   Worth checking the Gmail-found applications too (Next Insurance, Lenovo, Deloitte,
   Vi, Qualcomm, Pagaya, Aidoc), because **those aren't in the tracker.** Vi is
   already a PASS row in the queue.
3. Account-walled ATS (Workday, iCIMS, LinkedIn Easy Apply): the verdict is `manual`.
   You still get the tailored PDF and the answers as copy cards, but no drive.
4. Repost flag from `detect-reposts.mjs`: a warning, not a stop.

### C. Skill gap → GATE 1

The page shows the three buckets. **Gaps are listed explicitly**, as `pdf.md` step 4
requires. A `LOW CONFIDENCE` result says "check inconclusive", never "no gaps".
Buttons: **Tailor CV** / **Skip** (skip writes `SKIP` to the tracker with a note, so it
never re-surfaces).

### D. Tailor → GATE 2

- **Reuse check first (free):** `jd:similarity` against the JDs behind the existing
  tailored CVs (`output/cv-uri-levy-mobileye.html`, `-vi`, generic). If the result is
  `reuse`, offer that CV with no LLM call. If it's `reuse-with-edits`, pass the base CV
  and the listed edits to the tailor call. Several PASS rows are the same "AI Engineer"
  shape, so this will fire often.
- **Tailor call:** a headless CLI via `spawn-cli.mjs` with `_shared.md` + `_profile.md`
  + `_custom.md` + `pdf.md` steps 5–17, `cv.md`, `article-digest.md`, the JD, the
  triage reason and the skill-gap buckets. It must output **the render JSON only**.
  `build-cv-html.mjs` owns the markup.
- **Fact gate:** `verify-cv-facts.mjs` is a hard stop. A failure is shown to you with
  the offending line and the PDF is not rendered. We never auto-retry by softening the
  claim.
- **Render:** `generate-pdf.mjs --format=a4 --report=NNN --max-pages=1 --strict-pages`
  (one page, per `modes/_custom.md`), all inside the
  bundle at `output/NNN-{company}-{role}/cv/tailored/v001/`.
- **GATE 2 page:** a PDF preview beside `changes.md` (what moved vs `cv.md`: summary
  rewrite, reordered bullets, competency grid) and the keyword coverage %.
  Buttons: **Approve** / **Regenerate with note** (makes v002; v001 is kept) / **Stop**.
- The hiring-manager audit (`--hm-audit`) stays off. Add a per-job checkbox later if wanted.

### E. Form → GATE 3

- `openSession(url)` reuses the tab from stage A, so it runs once. The existing hybrid
  drive clicks through to the form. The drive's action vocabulary has no submit, **by
  construction**.
- **Answers:** the existing prefill route, with the stub report + JD + triage reason
  as context in place of an A–G report. Every answer carries a **source tag**
  (`cv.md` line / profile.yml key / JD / "generated"). Anything tagged "generated" is
  highlighted for review.
- **Sensitive fields stay empty on purpose:** `answer-prompt.mjs` already refuses to
  auto-fill legal, visa, work-authorization, salary and demographic questions. You
  answer those yourself on the review page. Knock-out warnings from `apply.md` 5b/5c/5d
  show at the top.
- **Cover letter:** only if extraction finds a cover-letter textarea or file field. It
  goes through `generate-cover-letter.mjs` and the same fact gate, and lands in the
  bundle next to the CV.
- **GATE 3 page:** one card per field (label, answer, source tag, edit box), plus the
  CV and cover PDFs that will be attached. Button: **Fill form**.
- **Fill:** `fillSession(answers, cvPath)` attaches the approved PDF. Then it reads the
  rendered values back and **diffs them against what you approved**. Any mismatch is
  shown in red on the handoff screen. (This is the field-diff guard from the old
  Phase 4 design. It's just a warning now, since you do the clicking.)
- `handoffSession()` brings the Chrome tab to the front. **You read it and you click Submit.**

### F. Record

Two buttons on the handoff screen:

- **I submitted:** writes a tracker TSV (headed form, `status=Applied`,
  `score=3.8/5`, report link, `url`, note `triage-only`), then `merge-tracker.mjs`,
  then `followup-seed.mjs`. Answers are saved to the bundle `answers.json`. The
  pipeline row gets `[x]`.
- **Not now:** tracker row as `Evaluated`, and the bundle is kept. Next time,
  "Prepare" resumes at the furthest completed stage.

## Resumability

Each stage writes into the bundle and a `state.json` (`jd` → `preflight` → `gap` →
`cv:v001:approved` → `answers:approved` → `filled` → `submitted`). If the browser
closes or the quota runs out mid-flow, nothing earlier is redone or re-billed. Quota
errors are detected and reported (see handoff defect 2b), never retried in a loop.

## Files

| File | New/edit | Purpose |
|---|---|---|
| `autopilot/prepare.mjs` | new | stages A–D + F as a CLI (`--job <url_key>`, `--stage`, `--self-test`), including the stub report writer; the web route calls it |
| `web/src/app/autopilot/page.tsx` | new | PASS queue with a Prepare button and stage chips per row |
| `web/src/app/autopilot/prepare/[job]/page.tsx` | new | the three gates as one stepper page |
| `web/src/app/api/autopilot/prepare/route.ts` | new | runs one stage, returns bundle state |
| `web/src/lib/autopilot/db-read.mjs` | edit | PASS-queue query (parse the `triage:` segment from `jobs.raw_line`, or add columns in `db-build.mjs`) |
| `autopilot/db-build.mjs` | edit | `triage_verdict/score/reason` columns on `jobs`; `kind` on `reports` |
| `web/src/lib/apply/*` | **untouched** | called, not changed |

All paths are already covered by `config/local-paths.txt`
(`autopilot/`, `web/src/app/autopilot/`, `web/src/app/api/autopilot/`,
`web/src/lib/autopilot/`). No system-layer file is edited.

## Build order

1. `prepare.mjs` stages A–C as a CLI. Run it on **Ib1** (the
   one genuinely new lead) with zero LLM spend and check the stub, the JD and the gap output.
2. Stage D on Ib1: one tailor call. Review the PDF by hand.
3. Web stepper for gates 1–2.
4. Stage E + gate 3 on Ib1, stopping at handoff. **You** decide whether to submit.
5. Stage F, the queue page, and resume.

Each step ends with something you can look at. Nothing needs a schedule.

## Build log

- **2026-09-28: step 1 built.** `autopilot/prepare.mjs` (stages A–C, 38 self-tests). Added
  beyond the plan: a Recruitee offers-API JD tier (full JD, zero tokens) and an
  **experience-ask check** in preflight, because Ib1 PASSed triage at 3.8 over a
  "4+ years … (Required)" line. Vi correctly blocked (tracker #115 Applied).
- `jd-skill-gap.mjs` extracts capitalized tokens, so its gap list carries noise
  ("Exceptional", "We", "Self") and misses aliases ("RESTful" vs cv.md's "REST APIs").
  That's a system-layer script, so gate 1 shows it as is and a human reads it.

## Open questions

1. ~~One page or two?~~ **Resolved: strict one page**, recorded in `modes/_custom.md`.
2. **Tailoring source:** recommendation is always `cv.md`, never the generic CV. The
   generic CV is an older derived output: it has a stale "Graduating June 2026", two
   claims not in `cv.md` ("20-30+ AI agents", GCP), and it's missing the
   Databricks/Postgres/SharePoint detail. The reuse check still compares against
   earlier *tailored* CVs. **Resolved:** always `cv.md`. Its Summary placeholder was
   replaced 2026-09-28 (option B, no role label), and the agent count stays unquantified.
3. ~~Vi~~ **Resolved:** already tracker #115, Applied (backfilled from Gmail). Preflight
   catches it by company+role, since the row has no URL.
