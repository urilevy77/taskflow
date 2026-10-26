// @ts-check
// WhatsApp group ingest — drains job links your `watch.mjs` watcher collected
// from your own WhatsApp groups into the pipeline.
//
// Split into two processes deliberately:
//   - watch.mjs is long-running (holds a live WhatsApp Web session via
//     whatsapp-web.js) and just appends one JSON line per link it sees to
//     data/whatsapp-leads.jsonl. It never touches pipeline.md.
//   - This ingest hook is what plugins.mjs actually calls, and it must return
//     within the engine's hook timeout — reading a small queue file takes
//     milliseconds, where launching/awaiting a WhatsApp session would not.
//     The engine (plugins.mjs) owns the pipeline write and its own URL dedup,
//     so a lead already in the pipeline is silently dropped there, not here.
//
// Enable in config/plugins.yml:
//   whatsapp: { enabled: true, groups: ["Job Alerts NYC", "AI Jobs Berlin"] }
// Run the watcher once (interactive, to scan the QR code the first time):
//   node plugins.local/whatsapp/watch.mjs
// Then drain the queue into the pipeline any time with:
//   node plugins.mjs run whatsapp

import { existsSync, readFileSync, renameSync, rmSync } from 'fs';
import path from 'path';

const QUEUE_PATH = path.join('data', 'whatsapp-leads.jsonl');

/** @type {{ ingest: (ctx: any) => Promise<object[]> }} */
export default {
  async ingest(ctx) {
    if (!existsSync(QUEUE_PATH)) {
      ctx.log('whatsapp: no queued leads (is watch.mjs running?)');
      return [];
    }

    // Atomic-ish handoff: rename first so a lead the watcher appends mid-read
    // lands in the NEXT file instead of being read half-written or lost.
    const claimPath = `${QUEUE_PATH}.${process.pid}.processing`;
    try {
      renameSync(QUEUE_PATH, claimPath);
    } catch (err) {
      ctx.log(`whatsapp: could not claim queue — ${err.message}`);
      return [];
    }

    let raw = '';
    try {
      raw = readFileSync(claimPath, 'utf-8');
    } finally {
      if (!ctx?.dryRun) {
        try { rmSync(claimPath); } catch { /* best-effort cleanup */ }
      }
    }

    const jobs = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const lead = JSON.parse(trimmed);
        if (lead && typeof lead.url === 'string' && /^https?:\/\//i.test(lead.url)) {
          jobs.push({
            title: lead.title || 'Job lead (WhatsApp)',
            url: lead.url,
            company: lead.company || '',
            location: lead.location || '',
          });
        }
      } catch {
        ctx.log(`whatsapp: skipping malformed queue line: ${trimmed.slice(0, 80)}`);
      }
    }

    // A dry run must not consume the queue — put it back so a real run still sees it.
    if (ctx?.dryRun) {
      try { renameSync(claimPath, QUEUE_PATH); } catch { /* best-effort */ }
    }

    return jobs;
  },
};
