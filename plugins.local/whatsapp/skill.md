---
name: career-ops-plugin-whatsapp
description: How to pull job links shared in your own WhatsApp groups into the career-ops pipeline.
license: MIT
---

# whatsapp plugin (local, unofficial)

Two pieces:

- `watch.mjs` — a long-running process holding a live WhatsApp Web session
  (via `whatsapp-web.js`). It watches the group chats you name and appends
  one JSON line per job-looking link to `data/whatsapp-leads.jsonl`.
- `index.mjs` (the `ingest` hook) — drains that queue file into the pipeline.
  Fast, no network of its own; the engine dedups against `data/pipeline.md`.

## Setup

1. `npm install` (pulls in `whatsapp-web.js` + `qrcode-terminal`), then
   `node plugins.mjs enable whatsapp --confirm`.
2. Find your groups: `node plugins.local/whatsapp/watch.mjs --list-groups`
   (scan the QR on first use) prints every group as a ready-to-paste line.
   Copy `config/plugins.example.yml` → `config/plugins.yml` if you haven't,
   and add the ones to watch:
   ```yaml
   plugins:
     whatsapp:
       enabled: true
       groups:
         - { name: "Job Alerts NYC", jid: "1203xxxxxxxxxxxx@g.us" }   # jid is exact/preferred
         - "AI Jobs Berlin"                                          # bare name also accepted (matched at connect time)
   ```
   `jid` is the stable WhatsApp group id (survives renames/emoji-in-name
   issues that a plain name match doesn't); `name` is just for logging when a
   jid is present, or the match key when it's not.
3. Scan the QR code once (Settings > Linked Devices > Link a Device on your
   phone) with either mode below — whichever you run first:
   ```
   node plugins.local/whatsapp/watch.mjs                 # live, keeps running
   node plugins.local/whatsapp/watch.mjs --backfill       # one-shot, last 7 days, then exits
   node plugins.local/whatsapp/watch.mjs --backfill=14    # one-shot, last 14 days
   ```
   The session is cached in `data/whatsapp-session/` (gitignored) so you only
   scan once, regardless of which mode you use afterward. `--backfill` has no
   "since a date" API to call, so it pages through each group's recent
   history (500 messages at a time, capped at 5000) until it passes the
   cutoff — re-running it is safe, since duplicate links are deduped by the
   ingest hook/engine, not here.
4. Any time (after a backfill run, or while the live watcher has been running), drain the queue into the pipeline:
   ```
   node plugins.mjs run whatsapp
   ```
   Then `/career-ops pipeline` to evaluate the new leads as usual.

## Scope (v1)

- Only messages containing an `http(s)://` link are captured. A pasted job
  description with no link is not picked up — forward the posting's URL
  instead, or paste the JD text directly into a chat with the AI agent.
- Read-only: never sends, replies, or reacts. Only reads messages in the
  chats you explicitly list.
- `whatsapp-web.js` is unofficial (drives WhatsApp Web, not a sanctioned
  Business API) — the same category of tool most personal WhatsApp MCP
  bridges are built on. Fine for this read-only, low-volume use; don't repurpose
  it for bulk sending.

## Data it produces

`Job[]` (`{ title, url, company, location }`) — `title`/`company` are best-effort
(literal "Job lead (WhatsApp)" / guessed from a known ATS URL slug); the full
evaluation in `oferta`/`pipeline` fills in the real title and company from the
JD itself. The engine de-dups against the pipeline before appending.
