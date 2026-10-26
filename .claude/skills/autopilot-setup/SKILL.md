---
name: autopilot-setup
description: >-
  Guided first-time setup of the Job Autopilot on a new person's PC — checks
  prerequisites, personalizes career-ops from THEIR CV, configures the daily
  run email, the optional phone site (Cloudflare Pages + Access), and the
  Windows daily schedule. Use when someone just cloned this repo and says
  "set up the autopilot", "set up my workspace", or runs /autopilot-setup.
  Free tiers only; never submits applications.
user_invocable: true
user-invocable: true
---

# autopilot-setup — set up the Job Autopilot for a new user

You are setting up this repo for a person who just cloned it. They are NOT the
person who built it. Work through the phases below in order, one at a time.
At the start, run the checks in Phase 0 and show a short checklist of what is
done and what is left, then continue from the first open item. Re-running this
skill later must pick up where it stopped — always detect state, never assume.

Talk simply. Explain each step in one or two sentences before doing it, and say
what the person has to do by hand (sign-ups, clicks in a browser).

## Hard rules

1. **Never spend money.** Free tiers only (see CLAUDE.md "Never spend money").
   If any sign-up asks for a payment method, stop: the person decides and
   enters it themselves; you never pick a paid plan, add-on, or pay-as-you-go.
2. **Secrets stay out of the chat.** Passwords, app passwords and API tokens go
   into `.env` — ask the person to open `.env` and paste the value themselves.
   Never ask them to paste a secret into the conversation, never echo `.env`
   values back, never commit `.env`.
3. **Their data only.** Everything personal is built from what THIS person
   provides (their CV, their answers). If you find leftover personal files from
   someone else (`cv.md`, `config/profile.yml`, `portals.yml`,
   `modes/_profile.md`, anything in `data/` other than `.gitkeep`, `CVs/`),
   stop and ask before using or deleting them.
4. **No evaluations, no submissions.** The autopilot finds and filters jobs and
   prepares material. It never applies anywhere. Don't change that.
5. **LLM triage is opt-in.** Default the schedule to `-SkipTriage` (zero token
   cost). Turn triage on only if the person asks and has a Claude subscription
   with the `claude` CLI logged in; explain it uses their subscription quota.

## Phase 0 — Detect state

Run these and summarize as a ✓/✗ checklist:

```bash
node --version                      # need 22+
git status --short | head
node doctor.mjs --json              # missing / unpersonalized personal files
test -f .env && echo ".env exists" || echo "no .env"
node autopilot/publish-site.mjs --check   # Cloudflare site checklist (fine if all ✗)
```

PowerShell (the scheduled task):

```powershell
Get-ScheduledTask -TaskName "career-ops autopilot daily" -ErrorAction SilentlyContinue
```

Checklist items: Node + dependencies · CV · profile · portals/title filter ·
experience limit · `.env` + email · first manual run · phone site (optional) ·
phone taps sync (optional) · daily schedule.

## Phase 1 — Install

- Node 22+ missing → point them to https://nodejs.org (LTS installer), then reopen the terminal.
- `npm install`
- `npx playwright install chromium` (used for PDFs and some job pages).
- Create `.env` from the example if missing: `cp .env.example .env`.

## Phase 2 — Make it theirs (most important step)

Follow the onboarding in AGENTS.md "First Run — Onboarding" for the files
`node doctor.mjs --json` reports as missing or unpersonalized:

1. **CV → `cv.md`.** Ask them to paste their CV (or drop a PDF/DOCX into
   `documents/` and use the `intake` mode). Never invent experience.
2. **Profile → `config/profile.yml`** (copy from `config/profile.example.yml`):
   name, email, location, target roles, salary range, `spend_tier`.
3. **Targeting → `modes/_profile.md`**: personalize it from their CV, so scores
   don't use the template author's targeting.
4. **Job boards → `portals.yml`** (copy from `templates/portals.example.yml` if
   missing). Set `title_filter.positive` / `negative` to THEIR target titles and
   `location_filter` to where they want to work. Ask which country/city.
5. **Experience limit.** The autopilot drops jobs that ask for more years than
   `MAX_YEARS` in `autopilot/experience.mjs` (shipped as 2, for junior roles).
   Ask: "What's the most years of experience a job may ask for and still be
   worth showing you?" Update `MAX_YEARS`. If they are senior and want no limit,
   the daily run skips this stage with `--skip-exp-gate` (`-SkipExpGate` when
   registering the schedule in Phase 6). Also loosen the junior-only words in
   `portals.yml`'s `title_filter.negative` (e.g. "Senior", "Lead") to match.
6. Create the tracker if missing (`data/applications.md`, AGENTS.md Step 4).

## Phase 3 — Daily email (recommended)

The daily run emails a report of new jobs. It needs a Gmail **app password**
(not their normal password):

1. They need 2-Step Verification on their Google account, then open
   https://myaccount.google.com/apppasswords and create one named "autopilot".
2. Ask them to put these in `.env` themselves (uncomment the lines):
   `AUTOPILOT_MAIL_USER` (their Gmail), `AUTOPILOT_MAIL_PASS` (the 16-letter
   app password), `AUTOPILOT_MAIL_TO` (where reports go — usually the same).
3. It gets tested at the end of Phase 4 (`--send-latest` mails the newest run,
   so it needs one run first).

Skipping email is fine — the run still works; results are in `data/runs/`.

## Phase 4 — First run, by hand

```bash
node autopilot/daily.mjs --dry-run          # shows the stage plan, runs nothing
node autopilot/daily.mjs --skip-triage      # real run, zero LLM cost; can take 10+ minutes
```

Afterwards, show them how many jobs were found and `data/pipeline.md`. If
email is set up, the run mails the report itself; if it didn't arrive, resend
with `node autopilot/notify-mail.mjs --send-latest` and read the error. If a stage failed, read its error from the run output / `data/runs/`
and fix it before moving on. Notes:
- WhatsApp group scanning is a private local plugin that is NOT in this repo;
  the scan skips it on its own. That's expected — don't try to build it.
- Goozali (Israeli tech companies) runs in report-only mode by default.

## Phase 5 — Phone site (optional, free)

A private website with the latest jobs, an Apply page and follow-ups, readable
from the phone. Ask if they want it; if not, skip to Phase 6.

1. **Cloudflare account** (free): https://dash.cloudflare.com/sign-up.
2. Log in from the PC: `npx wrangler login` (opens the browser).
3. Pick a project name — lowercase letters, digits, dashes, e.g.
   `<firstname>-autopilot`. Put in `.env`:
   `AUTOPILOT_SITE_PROJECT=<name>` and
   `AUTOPILOT_SITE_URL=https://<name>.pages.dev`.
4. Create the Pages project: `npx wrangler pages project create <name> --production-branch main`.
5. **Protect it before anything is uploaded** — the site holds their CV and job
   list. In the Cloudflare dashboard → Zero Trust (choose the **Free** plan; it
   is $0 for up to 50 users — if it asks for a card, rule 1 applies) →
   Access → Applications → Add → Self-hosted:
   - domain `<name>.pages.dev` **and** a second domain `*.<name>.pages.dev`
     (preview addresses);
   - policy: Allow → Emails → only their own email.
   `publish-site.mjs` refuses to upload while the site is unprotected, so this
   is enforced, not just advised.
6. Check: `node autopilot/publish-site.mjs --check` → all ✓.
7. Publish: `node autopilot/publish-site.mjs`, then have them open the URL on
   their phone and log in with the emailed code.

**Phone taps sync** (the "I applied" / "Skip" / "I followed up" buttons save
by themselves instead of showing a command to copy):
`node autopilot/marks-sync.mjs --setup` — creates a free Cloudflare KV store and
fills `AUTOPILOT_MARKS_KV_ID`, `AUTOPILOT_ACCESS_TEAM`, `AUTOPILOT_ACCESS_AUD`
in `.env`. Then publish again: `node autopilot/publish-site.mjs`.

## Phase 6 — Run every day (Windows)

Default — no LLM, zero cost:

```powershell
.\autopilot\install-schedule.ps1 -SkipTriage -DryRun     # show it first
.\autopilot\install-schedule.ps1 -SkipTriage             # register, daily 17:30
.\autopilot\install-schedule.ps1 -SkipTriage -Time "08:00"
```

The PC must be on (or wake up — a missed run starts when the PC wakes). Log:
`data/runs/task-scheduler.log`. Remove with `-Uninstall`.

If they chose "no experience limit" in Phase 2, add `-SkipExpGate`.

On macOS/Linux there is no installer — use the cron/launchd recipes in
`docs/AUTOMATION.md` with `node autopilot/daily.mjs --skip-triage`.

## Phase 7 — Done

Show the final checklist and a 5-line "how to use it":
- Every day at the set time it scans and emails new jobs.
- Open the site (if set up) on the phone → Apply page → apply yourself, tap "I applied".
- Paste any job link into Claude Code to evaluate it (`/career-ops`).
- `/career-ops tracker` shows applications; follow-ups appear on the site.
- Re-run `/autopilot-setup` anytime to check or fix the setup.
