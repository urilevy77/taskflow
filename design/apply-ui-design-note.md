# Design Note: A UI Layer for career-ops

**Status:** proposal, not yet built. **Owner:** you + Claude, iterate here.
**Started:** 2026-09-21

## The problem

Right now career-ops is entirely chat + markdown + a terminal TUI
(`dashboard/`). Three things are harder than they need to be:

1. **Filling out applications** (`/apply`) is copy-paste-driven: you paste
   form questions into chat, get answers back in chat, then copy each one
   into the browser by hand. There's no single screen showing "here's the
   form, here's the answer for each field, click to copy."
2. **Understanding the pipeline** end-to-end (scan → triage → oferta →
   apply → tracker → outcome) means reading `AGENTS.md`'s mode table and
   mentally stitching together what a dozen `.mjs` scripts do. There's no
   single picture of "where is everything right now, and what feeds what."
3. **Tracking status** means reading a markdown table (`data/applications.md`)
   or using the TUI (`dashboard/`), which is functional but text-dense —
   no at-a-glance funnel, no visual signal for stale rows or overdue
   follow-ups.

## What already exists (don't rebuild this)

`dashboard/` is a working Go/Bubble Tea TUI: filter tabs, sort modes,
grouped/flat views, report previews, inline status picker. It's isolated
from the Node core and reads `applications.md` directly. It already solves
a chunk of pain point #3. Anything proposed below should **extend** it or
sit next to it, not replace it.

Supporting data already exists too — this is mostly a rendering problem,
not a data problem:

- `stats.mjs` — lifetime funnel, portal coverage, scan trends (JSON)
- `funnel-velocity.mjs` — stage-by-stage velocity vs. benchmarks (JSON)
- `company-history.mjs` — per-company evidence card (JSON)
- `followup-cadence.mjs` / `data/follow-ups.md` — what's due and when

## Proposed shape: three screens, one app

A small local web app (not another TUI — "easier to look at" argues for a
browser, not a terminal) that runs alongside the existing Node scripts.
It's a **read/assist layer**, never a submit path — same "never click
submit" rule as everything else in this project.

### 1. Apply Assist screen

The main pain point. Flow:

- Pick a tracked application (or paste a JD/URL for a new one).
- Paste or screenshot the form's questions.
- Each question renders as a card: question text, generated answer
  (from the same `apply` mode logic, called as a subprocess/agent), a
  **Copy** button, and a confidence/source note (which report or `cv.md`
  fact it drew from — surfaces fabrication risk instead of hiding it).
- A visible "not yet reviewed" vs. "copied" state per card, so you can see
  at a glance what's left before you finish the form yourself in the
  actual browser tab.

This does not read or fill the real form (no scraping the ATS page) —
it stays a side-panel you keep open next to the browser tab, which keeps
"never auto-submit" trivially true by construction.

### 2. Pipeline Map screen

A single diagram of the whole system as a funnel, not a table:

```
scan → pipeline inbox → triage → oferta/auto-pipeline → applications.md
  → follow-up cadence → interview → offer → outcome
```

Each stage shows a live count (from `stats.mjs`/`funnel-velocity.mjs`)
and, on click, the list of rows currently in it. This is the "understand
all the functioning" piece — it's the mode table from `AGENTS.md`,
rendered as a live diagram instead of prose you have to hold in your head.

### 3. Tracker screen

Mostly the existing TUI's feature set, re-rendered as a web table/board:
filter by status, sort, group by company, click into a report. Add two
things the TUI doesn't have room for: a visual overdue-follow-up badge
(from `followup-cadence.mjs`) and a compact funnel strip at the top.

## Open questions (need your call before building)

- **Stack:** plain static HTML/JS served by a tiny local Node server
  (zero new deps, fits the existing `.mjs` style), vs. something richer.
  Recommendation: static HTML/JS + a couple of small `.mjs` JSON-serving
  endpoints — matches every other script in this repo and needs no build
  step.
- **Where it lives:** new top-level `ui/` (sibling to `dashboard/`), kept
  optional/isolated the same way `dashboard/` is isolated from Node core.
- **Launch:** `npm run serve:ui`, opens `localhost:PORT` — same pattern as
  `npm run serve:dashboard`.
- **Scope for v1:** all three screens, or ship Apply Assist alone first
  since it's the sharpest pain point?

## Suggested phasing

1. Apply Assist screen only, backed by the existing `apply` mode — this
   is the highest-leverage, lowest-risk piece (no new data plumbing,
   `apply.md`'s logic is reused as-is).
2. Pipeline Map, backed by `stats.mjs` + `funnel-velocity.mjs` (already
   emit JSON — just needs a small HTTP wrapper and a diagram renderer).
3. Tracker screen, once 1 and 2 prove the app shell is worth keeping.

## Next step

Tell me which phase to start on, and confirm the stack choice above —
then this moves from design note to a plan.
