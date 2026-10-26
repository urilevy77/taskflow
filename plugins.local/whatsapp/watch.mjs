// @ts-check
// whatsapp/watch.mjs — long-running watcher for the whatsapp ingest plugin.
//
// Two modes:
//
//   node plugins.local/whatsapp/watch.mjs                 — live: leave it
//     running (a terminal tab, `screen`/`tmux`, or a background process) and
//     it queues links as they're posted, from here on.
//
//   node plugins.local/whatsapp/watch.mjs --backfill[=N|auto]  — one-shot:
//     scans each watched group's history for job links, queues them, then
//     exits. Bare --backfill (or =auto) resumes from the last completed scan
//     (recorded in data/whatsapp-last-scan.json); with no record it reads the
//     last 4 days. An explicit N is honoured. The window is ALWAYS capped at 4
//     days — anything older is not scanned. Safe to re-run — links already in
//     the pipeline are deduped by the ingest hook/engine, not here.
//
//   node plugins.local/whatsapp/watch.mjs --list-groups  — one-shot: prints
//     every group you are in as a ready-to-paste config/plugins.yml line, then
//     exits. Needs no groups configured — use it to pick which to watch.
//
// First run prints a QR code — scan it from WhatsApp on your phone
// (Settings > Linked Devices > Link a Device). The session is cached in
// data/whatsapp-session/ (gitignored, local-only) so you only do this once.
//
// It watches the group chats named in config/plugins.yml → whatsapp.groups
// (exact chat name, case-insensitive) and appends one JSON line per job-looking
// link to data/whatsapp-leads.jsonl. It never writes to pipeline.md itself —
// run `node plugins.mjs run whatsapp` (or let a scheduled loop do it) to drain
// that queue into the pipeline with the engine's normal dedup.
//
// Scope, deliberately: this reads message text only, from chats YOU name, to
// find URLs. It never sends/replies, never reads DMs unless you list a DM as
// a "group", and a message with no URL (a pasted job description with no
// link) is not captured in v1 — forward those as a normal pipeline URL, or
// paste the JD directly and ask for an evaluation.
//
// whatsapp-web.js is unofficial (drives WhatsApp Web, not a sanctioned
// Business API) — the same category of tool the invite-only WhatsApp MCP
// servers are built on. Fine for personal, read-only automation on your own
// account; don't use it to send bulk messages.

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { extractUrls, isCleanUrl, companyFromUrl } from './_helpers.mjs';

const { Client, LocalAuth } = pkg;

const ROOT = process.cwd();
const SESSION_DIR = path.join(ROOT, 'data', 'whatsapp-session');

// whatsapp-web.js's own "latest" auto-fetch regularly lags a live WhatsApp
// Web release, which breaks its injected Store hooks with an opaque
// "r: r" evaluate error on the very first Client call (getChats, etc). Pinning
// to a known-good build from the community-maintained wa-version index avoids
// that race. If this starts failing again after a WhatsApp Web update, bump
// it to the newest entry at https://github.com/wppconnect-team/wa-version/tree/main/html.
const WA_WEB_VERSION = '2.3000.1047947458-alpha';
const QUEUE_PATH = path.join(ROOT, 'data', 'whatsapp-leads.jsonl');
const PLUGINS_CONFIG_PATH = path.join(ROOT, 'config', 'plugins.yml');

/**
 * Watched groups come as either a bare chat name (string, matched
 * case-insensitively against getChats() at ready time) or a
 * `{ name, jid }` object — the jid is exact and preferred: WhatsApp group
 * names can contain emoji/RTL text that round-trips unreliably, where the
 * `@g.us` id is stable. `jid` alone (no name) is also accepted.
 */
function loadWatchedGroups() {
  if (!existsSync(PLUGINS_CONFIG_PATH)) {
    throw new Error('config/plugins.yml not found — copy config/plugins.example.yml and add a whatsapp block.');
  }
  const cfg = yaml.load(readFileSync(PLUGINS_CONFIG_PATH, 'utf-8')) || {};
  const groups = cfg?.plugins?.whatsapp?.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error('config/plugins.yml → plugins.whatsapp.groups is empty. List the group jids (or names) to watch.');
  }
  return groups.map((g) => {
    if (typeof g === 'string') return { name: g.trim(), jid: null };
    const name = typeof g?.name === 'string' ? g.name.trim() : null;
    const jid = typeof g?.jid === 'string' ? g.jid.trim() : null;
    if (!name && !jid) throw new Error(`config/plugins.yml → plugins.whatsapp.groups has an entry with neither name nor jid: ${JSON.stringify(g)}`);
    return { name, jid };
  });
}

// The drain (plugins.mjs -> index.mjs) DELETES the queue file, so the group a link came from would be
// lost. This append-only log keeps it, keyed by URL, for autopilot's per-source funnel (design §12).
const SOURCES_PATH = path.join(ROOT, 'data', 'whatsapp-sources.jsonl');

function appendLead(lead, group) {
  mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  appendFileSync(QUEUE_PATH, JSON.stringify(lead) + '\n', 'utf-8');
  if (group) appendFileSync(SOURCES_PATH, JSON.stringify({ url: lead.url, group, ts: lead.ts }) + '\n', 'utf-8');
}

// A backfill never looks further back than this, however long it has been since
// the last scan or whatever --backfill=N asks for. Older leads are assumed stale.
const MAX_BACKFILL_DAYS = 4;
// Overlap on the resume point so a message posted while the last run was
// finishing isn't lost; the pipeline dedup absorbs the repeats.
const RESUME_OVERLAP_MS = 60 * 60 * 1000;
const LAST_SCAN_PATH = path.join(ROOT, 'data', 'whatsapp-last-scan.json');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse `--backfill` / `--backfill=auto` / `--backfill=N`. Returns null (live mode), 'auto', or a day count. */
function parseBackfillDays(argv) {
  const arg = argv.find(a => a === '--backfill' || a.startsWith('--backfill='));
  if (!arg) return null;
  const eq = arg.indexOf('=');
  if (eq === -1) return 'auto';
  const raw = arg.slice(eq + 1);
  if (raw === 'auto') return 'auto';
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--backfill days must be a positive number or "auto", got "${raw}"`);
  return n;
}

function readLastScanMs() {
  try {
    const t = Date.parse(JSON.parse(readFileSync(LAST_SCAN_PATH, 'utf-8')).lastScanAt);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null; // missing or corrupt → treated as "never scanned"
  }
}

function writeLastScan(ms) {
  mkdirSync(path.dirname(LAST_SCAN_PATH), { recursive: true });
  writeFileSync(LAST_SCAN_PATH, JSON.stringify({ lastScanAt: new Date(ms).toISOString() }, null, 2) + '\n', 'utf-8');
}

/**
 * Decide how far back this backfill reads. 'auto' resumes from the last
 * successful scan; an explicit N is honoured. Either way it is capped at
 * MAX_BACKFILL_DAYS. `startedMs` is captured BEFORE any message is fetched and
 * is what gets recorded on success, so nothing posted mid-run falls in a gap.
 */
function resolveBackfillWindow(requested, now = Date.now(), lastScanMs = readLastScanMs()) {
  const floorMs = now - MAX_BACKFILL_DAYS * DAY_MS;
  let sinceMs;
  let why;
  if (requested === 'auto') {
    if (lastScanMs === null) {
      sinceMs = floorMs;
      why = 'no previous scan recorded';
    } else {
      sinceMs = Math.max(lastScanMs - RESUME_OVERLAP_MS, floorMs);
      why = sinceMs === floorMs
        ? `last scan was ${new Date(lastScanMs).toISOString()}, older than the ${MAX_BACKFILL_DAYS}-day cap`
        : `resuming from last scan at ${new Date(lastScanMs).toISOString()}`;
    }
  } else {
    sinceMs = Math.max(now - requested * DAY_MS, floorMs);
    why = requested > MAX_BACKFILL_DAYS ? `requested ${requested}d, capped at ${MAX_BACKFILL_DAYS}d` : `requested ${requested}d`;
  }
  return { cutoffMs: sinceMs, startedMs: now, days: (now - sinceMs) / DAY_MS, why };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `ready` fires before WhatsApp Web's internal chat Store has necessarily
 * finished populating — calling getChats() immediately is a known
 * whatsapp-web.js race that throws an opaque in-page "r: r" evaluate error.
 * Retry with backoff rather than a single fixed delay, since load time varies
 * with account size/connection speed.
 */
async function getChatsWithRetry(client, attempts = 2, delayMs = 3000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    try {
      return await client.getChats();
    } catch (err) {
      lastErr = err;
      console.warn(`whatsapp: getChats() not ready yet (attempt ${i + 1}/${attempts}) — ${err.message}`);
    }
  }
  throw lastErr;
}

/** Resolve configured groups against the live chat list. jid match preferred; name is a fallback/label. */
async function resolveWatchedChats(client, watched) {
  console.log('whatsapp: loading full chat list (first run can take a few minutes)…');
  const chats = await getChatsWithRetry(client);
  console.log(`whatsapp: loaded ${chats.length} total chat(s), matching against ${watched.length} configured group(s)…`);
  const groupChats = chats.filter(c => c.isGroup);
  const byJid = new Map(groupChats.map(c => [c.id._serialized, c]));
  const byName = new Map(groupChats.map(c => [c.name.trim().toLowerCase(), c]));

  const resolved = [];
  for (const g of watched) {
    const chat = (g.jid && byJid.get(g.jid)) || (g.name && byName.get(g.name.toLowerCase()));
    if (chat) resolved.push(chat);
    else console.warn(`  ⚠️  no group chat found for ${g.jid ? `jid "${g.jid}"` : `name "${g.name}"`} — it may have been left, renamed, or the account differs from where this jid was captured`);
  }
  return resolved;
}

/**
 * One-shot: scan each watched chat's recent history for job links posted in
 * the last `days` days, queue them, then let the caller destroy the client.
 *
 * whatsapp-web.js has no "messages since a date" API — fetchMessages only
 * takes a count — so this fetches a generous, growing batch and stops paging
 * a chat once it reaches a message older than the cutoff (or a hard cap, so
 * one ancient, quiet chat can't hang the whole run).
 */
async function runBackfill(client, watched, { cutoffMs, days, why }) {
  const HARD_CAP = 5000;
  const PAGE = 500;

  console.log(`whatsapp: backfilling since ${new Date(cutoffMs).toISOString()} (${days.toFixed(1)} day(s); ${why}) across configured group(s):`);
  const chats = await resolveWatchedChats(client, watched);

  let totalQueued = 0;
  for (const [i, chat] of chats.entries()) {
    console.log(`[${i + 1}/${chats.length}] ${chat.name}: scanning…`);

    let limit = PAGE;
    let messages = [];
    // Grow the fetch until the oldest message returned predates the cutoff,
    // or we hit the hard cap — fetchMessages re-fetches from scratch each
    // call (no cursor), so this is O(cap) work in the worst case, not O(cap²).
    while (limit <= HARD_CAP) {
      messages = await chat.fetchMessages({ limit });
      console.log(`[${i + 1}/${chats.length}] ${chat.name}: fetched ${messages.length} message(s) (limit ${limit})`);
      const oldest = messages[0];
      if (!oldest || oldest.timestamp * 1000 <= cutoffMs || messages.length < limit) break;
      limit += PAGE;
    }

    const inWindow = messages.filter(m => m.timestamp * 1000 >= cutoffMs);
    let queuedForChat = 0;
    for (const msg of inWindow) {
      const urls = extractUrls(msg.body).filter(isCleanUrl);
      for (const url of urls) {
        appendLead({
          title: 'Job lead (WhatsApp)',
          url,
          company: companyFromUrl(url),
          location: '',
          ts: new Date(msg.timestamp * 1000).toISOString(),
        }, chat.name);
        queuedForChat++;
        console.log(`  → [${chat.name}] ${new Date(msg.timestamp * 1000).toISOString()} — ${url}`);
      }
    }
    totalQueued += queuedForChat;
    console.log(`  ✓ ${chat.name}: ${inWindow.length} message(s) in window, ${queuedForChat} link(s) queued`);
  }
  console.log(`whatsapp: backfill done — ${totalQueued} link(s) queued. Run \`node plugins.mjs run whatsapp\` to drain into the pipeline.`);
}

/** Print every group chat as a ready-to-paste config/plugins.yml line, so a new user can pick which to watch. */
async function listGroups(client) {
  const chats = await getChatsWithRetry(client);
  const groups = chats.filter(c => c.isGroup).sort((a, b) => a.name.localeCompare(b.name));
  console.log(`\nwhatsapp: ${groups.length} group(s). Copy the ones to watch under plugins.whatsapp.groups in config/plugins.yml:\n`);
  for (const c of groups) console.log(`      - { name: ${JSON.stringify(c.name)}, jid: "${c.id._serialized}" }`);
}

/**
 * One full client lifecycle: connect, run either backfill-then-resolve or
 * live-listen-forever. Resolves `{ mode: 'backfill' }` once a backfill run
 * has queued its leads (caller destroys/exits); for live mode the returned
 * promise resolves once listening has started and the process just stays up
 * on Puppeteer's open handles. Rejects on auth failure or a connection error
 * (including the "Execution context was destroyed" WA-Web-reload race that
 * whatsapp-web.js's own internal readiness polling can hit before 'ready'
 * even fires — outside any of our own try/catches, so it surfaces here).
 */
function runSession(watched, backfillWindow, listOnly = false) {
  return new Promise((resolve, reject) => {
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
      // Puppeteer's default protocolTimeout (~180s) can be shorter than
      // WhatsApp Web's first-ever full chat-list sync on an account with many
      // chats/groups — getChats() times out mid-evaluate rather than erroring
      // cleanly. 5 minutes gives that one-time sync room; later runs are
      // faster once WA Web has its own local cache warm.
      puppeteer: { headless: true, protocolTimeout: 300_000 },
      webVersion: WA_WEB_VERSION,
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
      },
    });

    let settled = false;
    // A failed attempt's browser process can survive the page-context error
    // that killed it (that's a page event, not a browser crash) and keep
    // holding LocalAuth's userDataDir lock — the very next `new Client()` in
    // the retry loop then fails immediately with "browser already running".
    // Tear it down (bounded, in case destroy() itself hangs on a half-dead
    // page) before rejecting, so the next attempt gets a clean profile.
    const fail = async (err) => {
      if (settled) return;
      settled = true;
      await Promise.race([
        client.destroy().catch(() => {}),
        sleep(8000),
      ]);
      reject(err);
    };

    client.on('qr', (qr) => {
      console.log('\nScan this QR code from WhatsApp on your phone (Settings > Linked Devices > Link a Device):\n');
      qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', () => console.log('whatsapp: authenticated, session cached in data/whatsapp-session/'));
    client.on('auth_failure', (msg) => fail(new Error(`auth failure — ${msg}`)));
    client.on('disconnected', (reason) => { if (!settled) fail(new Error(`disconnected — ${reason}`)); });

    let watchedChatIds = null; // resolved once the client is ready and chats are listable
    let chatNames = new Map(); // jid -> group name, for the source log

    client.on('ready', async () => {
      try {
        if (listOnly) {
          await listGroups(client);
          settled = true;
          resolve({ mode: 'list', client });
          return;
        }
        if (backfillWindow !== null) {
          await runBackfill(client, watched, backfillWindow);
          settled = true;
          resolve({ mode: 'backfill', client });
          return;
        }

        const chats = await resolveWatchedChats(client, watched);
        watchedChatIds = new Set(chats.map(c => c.id._serialized));
        chatNames = new Map(chats.map(c => [c.id._serialized, c.name]));
        console.log('whatsapp: watching configured group(s):');
        for (const c of chats) console.log(`  ✓ ${c.name} (${c.id._serialized})`);
        console.log('whatsapp: ready, listening for new messages…');
        settled = true;
        resolve({ mode: 'live', client });
      } catch (err) {
        fail(err);
      }
    });

    client.on('message', (msg) => {
      if (!watchedChatIds || !watchedChatIds.has(msg.from)) return;

      const urls = extractUrls(msg.body).filter(isCleanUrl);
      if (urls.length === 0) return;

      for (const url of urls) {
        appendLead({
          title: 'Job lead (WhatsApp)',
          url,
          company: companyFromUrl(url),
          location: '',
          ts: new Date().toISOString(),
        }, chatNames.get(msg.from));
        console.log(`whatsapp: queued ${url}`);
      }
    });

    client.initialize().catch(fail);
  });
}

// WA Web occasionally reloads the page during its initial history sync right
// as whatsapp-web.js's own internal readiness polling is mid-evaluate,
// killing the puppeteer execution context — this is reported upstream as
// self-resolving on a plain retry, so retry the whole connection rather than
// surfacing it as a hard failure.
const TRANSIENT_ERROR_RE = /Execution context was destroyed|Target closed|Session closed|Protocol error/i;

async function main() {
  // --list-groups works before any group is configured: it is how a new user finds the jids.
  const listOnly = process.argv.includes('--list-groups');
  const watched = listOnly ? [] : loadWatchedGroups();
  const requested = listOnly ? null : parseBackfillDays(process.argv.slice(2));
  // Resolved once, outside the retry loop: a retry re-reads the SAME window and
  // the last-scan marker only moves after a run that actually completed.
  const backfillWindow = requested === null ? null : resolveBackfillWindow(requested);
  mkdirSync(SESSION_DIR, { recursive: true });

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await runSession(watched, backfillWindow, listOnly);
      if (result.mode === 'list') {
        await result.client.destroy();
        process.exit(0);
      }
      if (result.mode === 'backfill') {
        writeLastScan(backfillWindow.startedMs);
        await result.client.destroy();
        process.exit(0);
      }
      return; // live mode: resolved once listening started, stays up on Puppeteer's open handles
    } catch (err) {
      if (!TRANSIENT_ERROR_RE.test(err.message) || attempt === MAX_ATTEMPTS) throw err;
      console.warn(`whatsapp: transient connection error (attempt ${attempt}/${MAX_ATTEMPTS}) — ${err.message}. Retrying…`);
      await sleep(5000);
    }
  }
}

main().catch((err) => {
  console.error(`whatsapp watcher failed: ${err.message}`);
  process.exit(1);
});
