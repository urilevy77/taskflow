# Cloud autopilot — off the PC

Status: **DROPPED 2026-10-06** — the user keeps running the scan on the PC; only the phone-reachable web app is wanted. Kept for reference.

## Goal

Every day at 17:30 Asia/Jerusalem, without this PC: run the autopilot (WhatsApp + boards → triage → prepare → tailor),
email a short summary, and publish the run report to a site reachable from the phone.

## Decisions

| Question | Decision |
|---|---|
| Where it runs | Google Cloud **e2-micro** (free tier) |
| WhatsApp | Kept — the live watcher runs 24/7 on the VM; the 17:30 run drains its queue |
| LLM (triage, tailor) | Claude subscription token (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`) |
| Site address | Free subdomain — DuckDNS (`<name>.duckdns.org`) + Caddy (automatic HTTPS) |

## Architecture

```
 phone ──https──▶ Caddy (:443, Let's Encrypt) ──▶ phone-server.mjs (127.0.0.1:4317)
                                                    /run, /run/<date>   run report
                                                    /                   apply page (CV, I applied / Skip)

 systemd services on the VM
   whatsapp-watch.service   node plugins.local/whatsapp/watch.mjs      (live, always on → data/whatsapp-leads.jsonl)
   phone-server.service     node autopilot/phone-server.mjs            (always on)
   autopilot-daily.timer    OnCalendar=*-*-* 17:30 Asia/Jerusalem → daily.mjs --whatsapp-live
                            → drain queue + board scan → … → email (link = https://<name>.duckdns.org/run/<date>?t=…)
                            → data-sync push
```

## e2-micro constraints (1 GB RAM)

- 1 GB is tight: Chromium (WhatsApp) stays resident; the 17:30 run adds Playwright (liveness, PDF).
  Mitigation: 3 GB swapfile; daily run is sequential already. Fallback if it thrashes: pause the watcher during
  the run and let its auto-backfill cover the gap, or move to a 2 GB machine.
- Free tier is US regions only (us-west1 / us-central1 / us-east1). WhatsApp sees a US datacenter IP — unknown
  whether that raises unlink risk; read-only use on your own groups.
- **To verify at setup:** whether the external IPv4 address is billed (~$3–4/mo) on the free-tier VM.
- Billing account (card) is required even for free tier; set a budget alert at $1.

## Data

The VM becomes the owner of user-layer data (`data/`, `reports/`, `output/`, `cv.md`, `config/`, `modes/_profile.md`).
After each run it commits them to a **private** GitHub repo; the PC pulls before working locally.
`data/whatsapp-session/` (181 MB) is NOT synced — the VM links its own WhatsApp device (QR once).

## Code changes needed

1. `daily.mjs`: `--whatsapp-live` mode — skip the backfill step, only drain the queue (the watcher is already running).
2. `notify-mail.mjs`: report link from `AUTOPILOT_PUBLIC_URL` (fallback `AUTOPILOT_PHONE_URL`).
3. `phone-server.mjs`: trust `X-Forwarded-*` from Caddy for the same-origin check; login rate limit (it is public now).
4. `deploy/`: systemd units, Caddyfile, `setup-vm.sh`, `data-sync.sh`.

## What only the user can do

1. Create a Google Cloud account + billing, create the e2-micro VM (guided step by step).
2. Create a DuckDNS subdomain and token.
3. Run `claude setup-token` and paste the token into the VM's `.env`.
4. Scan the WhatsApp QR from the phone once.
5. Create the private data repo on GitHub (and fix local `gh auth login` — currently returns 401).
