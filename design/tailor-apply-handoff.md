# Tailor & Apply — Handoff

**Written:** 2026-09-29, end of the session that designed this flow and built step 1.
**Read first:** `design/tailor-apply-plan.md` (the agreed design + build log).
**Background:** `design/autopilot-handoff.md` (Phases 0–2, binding constraints) and
`design/autopilot-plan.md`.

---

## 1. User decisions (binding, 2026-09-28/29)

| Topic | Decision |
|---|---|
| Trigger | Tailoring runs **only when the user starts it**: tailor, then apply, as one flow. Nothing is added to `daily.mjs`. |
| Evaluation | **None.** Tailor from the archived JD + triage verdict + zero-LLM skill gap. No `oferta`, no Blocks A–G. |
| Submit | **Fill the form; the user clicks Submit.** No submit code. `web/src/lib/apply/drive.ts` / `SUBMIT_RX` stay untouched. The old Phase-4 token design is dropped. |
| Cover letter | Only when the form has a cover-letter field or upload. |
| CV length | **Strictly one page.** House rule in `modes/_custom.md` → `--max-pages=1 --strict-pages`. Trim content; never shrink fonts or margins. |
| Tailoring source | Always `cv.md`, never `output/cv-uri-levy-generic.html`. The generic CV has claims `cv.md` doesn't back up ("20-30+ agents", GCP), so the fact gate would block them. |
| Agent count | Keep it **unquantified**. |
| `cv.md` summary | Replaced 2026-09-28 with option B (no role label). `cv-sync-check.mjs` passes. |
| Re-triage | **Never.** The user was explicit: `daily.mjs` owns triage. `prepare.mjs` reads the verdict and refuses rows that don't have one. |

Constraints carried over from `autopilot-handoff.md` §3 still apply: no evaluations,
no submissions, never edit system-layer files, never walk `career-ops/`, ask before
LLM spend.

## 2. What was built

**`autopilot/prepare.mjs`** — stages A–C, zero LLM tokens, 38 self-tests
(`node autopilot/prepare.mjs --self-test`).

```
node autopilot/prepare.mjs --job <url|fragment> [--pipeline <file>] [--dry-run] [--allow-marginal] [--json]
```

- **A. Capture JD**, in order: the `jds/` file triage already saved (sha1 suffix, same
  as `prefetchJd()`), then `fetchJdViaKnownApi`, then the **Recruitee offers API**
  (new; full JD for free), then the page (JSON-LD, else page text). Liveness is decided
  on the same fetch. A closed posting stops the run.
- **B. Preflight** checks: blacklist (`data/blacklist.md` doesn't exist yet, so it's
  skipped), tracker duplicates (company + title-token overlap ≥ 0.6; Applied or later
  is a stop), account-walled hosts (Workday, iCIMS, LinkedIn → a warning), reposts
  via `detect-reposts.mjs`, and **experience asks** (new; quotes "N+ years" lines
  with required/preferred).
- **C.** `jd-skill-gap.mjs` classifier, then the **triage-only stub report** (report
  number from `reserve-report-num.mjs`, sentinel released), then the bundle via
  `application-artifacts.mjs`, `jd/current.md`, and `state.json` (keyed by `url_key`,
  so a rerun resumes and doesn't re-reserve a number).
- JD lines aimed at an AI are quoted as anomalies, never followed.

Verified: `verify-pipeline.mjs` 0 errors (one expected "orphan report" warning until
a tracker row exists), `check-jd-archive.mjs` accepts the stub, `db-build.mjs`
self-tests pass.

Also edited: `modes/_custom.md` (one-page rule), `cv.md` (summary),
`design/tailor-apply-plan.md`.

## 3. Current state

- **Ib1** (Senior Backend Engineer, Tel Aviv): report `reports/120-ib1-2026-09-28.md`,
  bundle `output/120-ib1-senior-backend-engineer-il/`. **Waiting on the user's gate-1
  decision.** The JD *requires* 4+ years (the CV shows ~15 months). Real gaps: AWS,
  Kubernetes, Jenkins, Linux. The recommendation given was to lean towards skip. If
  skipped: add a tracker `SKIP` row via a TSV in `batch/tracker-additions/` +
  `merge-tracker.mjs`, linking `[120](reports/120-ib1-2026-09-28.md)`.
- **`data/pipeline.md` was mostly reset between 09-26 and 09-28** (1413→222 done,
  407→92 pending; the Ib1 and two Mobileye PASS rows vanished). The Ib1 row survives
  in `data/pipeline.md.bak-2026-09-26-israel` (the run used `--pipeline` on it). Cause
  unknown: `filter.js` would have kept those rows; `enrich-leads.mjs` +
  `pipeline.md.pre-enrich.bak` are recent. **The user was asked if it was intentional
  and hasn't answered.** Don't restore anything without asking.
- **11 PASS rows** are in the current `pipeline.md` (+8 MARGINAL, 17 untriaged):
  QualityAI, toko, Bellboy Robotics, Staffin Israel, Vi, NVIDIA (Workday), IAI,
  STRAIX, Mobileye (Lever), VAST Data, Google SWE II. Vi is already tracker #115
  Applied, and `prepare.mjs` blocks it correctly.

## 4. Where the user wants to go

The user asked how to run **all PASS jobs** through tailoring and applying. The agreed
shape (not yet approved to build; the user chose to hand off instead):

```
node autopilot/prepare.mjs --all-pass          # A–C for every PASS row, free, one summary table
   → gate 1 as one list (tailor / skip per job)
node autopilot/prepare.mjs --tailor-approved   # D for the ticked ones — 1 LLM call each; ASK before running
   → gate 2 as one list (approve each PDF)
/autopilot apply queue                          # E: open each form, fill, user clicks Submit, next
```

Submitting always stays a per-job human click. Tell the user this plainly again if
they ask for "fully automatic".

## 5. Next steps, in order

1. Get answers: the Ib1 gate-1 decision, and whether the `pipeline.md` reset was intentional.
2. Build `--all-pass` (loop `prepare()` over PASS rows, sequentially, with a summary
   table). Confirm with the user, then run it on the 11 rows. It's free.
3. Stage D (tailor), per `tailor-apply-plan.md` §D:
   - reuse check first (`npm run jd:similarity`);
   - then one headless CLI call via `spawn-cli.mjs` that emits **render JSON only** (`pdf.md` steps 5–17);
   - then `build-cv-html.mjs`;
   - then `verify-cv-facts.mjs` as a hard stop;
   - then `generate-pdf.mjs --format=a4 --report=NNN --max-pages=1 --strict-pages` into `cv/tailored/v001/`.
   Reuse `triage-run.mjs`'s `TRIAGE_CLI_CANDIDATES` / `summarizeCliError()` and its
   3-consecutive-failure quota breaker. State the call count and ask before any batch spend.
4. The web stepper for the gates plus stage E (the existing `session.ts`
   `openSession` / `fillSession` / `handoffSession`, prefill route, field read-back diff), then F.
5. `db-build.mjs`: add `kind` to `reports` so triage-only scores are never averaged
   with A–G scores.

## 6. Gotchas found this session

- `pipeline.md` is **CRLF**, and `.` in a JS regex never matches `\r`. Split on `/\r?\n/`
  (fixed in `prepare.mjs`, with a regression test).
- `jd-skill-gap.mjs` extracts capitalized tokens, so its gap list has noise ("We",
  "Self", "Exceptional") and misses aliases ("RESTful" vs "REST APIs"). It's system
  layer, so present it as is.
- Triage scores can miss hard knock-outs (Ib1 PASSed at 3.8 over "4+ years
  Required"). That's why gate 1 surfaces the experience asks.
- A grep over the whole repo times out (the nested `career-ops/` copy + `node_modules`).
  Scope searches to explicit paths.
