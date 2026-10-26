#!/usr/bin/env node
// @ts-check
// marks-sync.mjs — brings the taps made on the phone ("I applied", "Skip", "Move to Pass", "I followed up",
// "Retire") from the site's store (Cloudflare KV, written by site-worker.mjs) to the PC, and records each one
// through the same paths the copy-a-command box used:
//
//   apply:<report#>   applied | skip              → phone-server.mjs applyMarks      (set-status.mjs / merge-tracker.mjs)
//   lead:<hash>       applied | skip | pass       → phone-server.mjs applyLeadMarks  (pass: prepared + site republished — by the daily run's later stages, or here when run alone)
//   fu:<tracker#>     followed | retire           → followups.mjs applyFollowupMarks (data/follow-ups.md)
//
// A mark leaves the store only once it was recorded (or can never be: a job that is gone, a malformed key).
// One that FAILED — tracker busy, say — stays and is retried by the next run. Nothing here submits anything.
//
// Config (.env — `--setup` fills it in): AUTOPILOT_MARKS_KV_ID, AUTOPILOT_ACCESS_TEAM, AUTOPILOT_ACCESS_AUD.
// Unset → "not configured", never an error: the site keeps showing the copy-a-command box.
//
//   node autopilot/marks-sync.mjs --setup       create the store, find the Access team + app id, write .env
//   node autopilot/marks-sync.mjs               pull + record; jobs moved to Pass are then prepared and the site
//                                               republished, so they show on the Apply page right away
//   node autopilot/marks-sync.mjs --in-daily    pull + record only (the daily run's "marks" stage: its own
//                                               prepare and publish stages follow)
//   node autopilot/marks-sync.mjs --dry-run     show what is waiting, record nothing
//   node autopilot/marks-sync.mjs --self-test

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import dotenv from 'dotenv';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { validateMark } from './site-worker.mjs';
import { wrangler, siteUrl } from './publish-site.mjs';
import { syncConfig } from './sync-config.mjs';
import { applyMarks, applyLeadMarks } from './phone-server.mjs';
import { applyFollowupMarks } from './followups.mjs';

const ROOT = getCareerOpsRoot();
export { syncConfig };

/** First JSON value in wrangler's output (it prints banners around it). */
export function extractJson(out) {
  const text = String(out ?? '');
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    const a = text.indexOf(open), b = text.lastIndexOf(close);
    if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* try the other bracket */ } }
  }
  return null;
}

/** `wrangler kv bulk get` output (an object keyed by name, or a list of { key, value }) → Map(name → parsed value). */
export function parseBulkGet(out) {
  const j = extractJson(out);
  const pairs = Array.isArray(j) ? j.map((e) => [e?.key ?? e?.name, e?.value]) : j && typeof j === 'object' ? Object.entries(j).map(([k, v]) => [k, v && typeof v === 'object' && 'value' in v ? v.value : v]) : [];
  const map = new Map();
  for (const [k, v] of pairs) {
    if (typeof k !== 'string') continue;
    try { map.set(k, typeof v === 'string' ? JSON.parse(v) : v); } catch { map.set(k, null); }
  }
  return map;
}

/**
 * Records every waiting mark. `values` is Map("m:<kind>:<id>" → { action }). → { lines, remove: [store keys to delete], kept }
 * `apply` is injectable for the self-test.
 */
export async function processMarks(values, apply = { apply: applyMarks, lead: (m) => applyLeadMarks(m, { prepare: false }), fu: applyFollowupMarks }) {
  const lines = [];
  const remove = [];
  const groups = { apply: [], lead: [], fu: [] };
  for (const [name, value] of values) {
    const m = String(name).match(/^m:([a-z]+):(.+)$/);
    const v = m ? validateMark({ kind: m[1], id: m[2], action: value?.action }) : { error: 'bad key' };
    if (v.error || v.action === 'undo') { lines.push(`${name}: not a valid mark — dropped`); remove.push(name); continue; }
    groups[v.kind].push({ name, id: v.id, action: v.action });
  }
  const failed = (l) => /FAILED/.test(l);
  if (groups.apply.length) {
    const out = await apply.apply(groups.apply.map((g) => ({ num: Number(g.id), action: g.action })));
    lines.push(...out);
    groups.apply.forEach((g, i) => { if (out.length === groups.apply.length && !failed(out[i])) remove.push(g.name); });
  }
  for (const g of groups.lead) { // one at a time: its report lines are not one-per-mark
    const out = await apply.lead([{ id: g.id, action: g.action }]);
    lines.push(...out);
    if (!out.some(failed)) remove.push(g.name);
  }
  if (groups.fu.length) {
    const out = await apply.fu(groups.fu.map((g) => ({ num: Number(g.id), action: g.action })));
    lines.push(...out);
    groups.fu.forEach((g, i) => { if (out.length === groups.fu.length && !failed(out[i])) remove.push(g.name); });
  }
  return { lines, remove, kept: values.size - remove.length };
}

/** Outside the daily run: prepare the jobs just moved to Pass (prepare-new.mjs) and republish the site. */
async function prepareAndPublish() {
  const p = spawnSync(process.execPath, [join(ROOT, 'autopilot', 'prepare-new.mjs')], { cwd: ROOT, encoding: 'utf-8', timeout: 15 * 60_000 });
  const last = `${p.stdout ?? ''}${p.stderr ?? ''}`.trim().split(/\r?\n/).pop() ?? '';
  if (p.status !== 0) return [`prepare-new FAILED (exit ${p.status}) — the moved jobs will be prepared on the next daily run. ${last}`];
  const { publishSite } = await import('./publish-site.mjs');
  return [`prepare-new: ${last}`, await publishSite()];
}

const lastLines = (out, n = 3) => String(out ?? '').trim().split(/\r?\n/).slice(-n).join(' | ').slice(0, 300);

/** Pulls and records. → one summary line; throws on a store/network failure so the daily run shows the stage as failed. */
export async function pull({ env = process.env, dryRun = false, afterPass = null } = {}) {
  const cfg = syncConfig(env);
  if (!cfg) return 'not configured (run: node autopilot/marks-sync.mjs --setup) — marks still go through the copy-a-command box';
  const ns = ['--namespace-id', cfg.kvId, '--remote'];
  const listed = await wrangler(['kv', 'key', 'list', ...ns]);
  if (listed.code !== 0) throw new Error(`kv list failed: ${lastLines(listed.out)}`);
  const names = (extractJson(listed.out) ?? []).map((k) => k?.name).filter((n) => typeof n === 'string' && n.startsWith('m:'));
  if (!names.length) return 'no marks waiting';
  const dir = mkdtempSync(join(tmpdir(), 'marks-'));
  try {
    const keysFile = join(dir, 'keys.json');
    writeFileSync(keysFile, JSON.stringify(names));
    const got = await wrangler(['kv', 'bulk', 'get', keysFile, ...ns]);
    if (got.code !== 0) throw new Error(`kv get failed: ${lastLines(got.out)}`);
    const values = parseBulkGet(got.out);
    for (const n of names) if (!values.has(n)) values.set(n, null); // listed but unreadable → dropped as invalid
    if (dryRun) return `${names.length} mark(s) waiting: ${names.map((n) => `${n.slice(2)}=${values.get(n)?.action ?? '?'}`).join(', ')}`;
    const { lines, remove, kept } = await processMarks(values);
    for (const l of lines) console.log(`  ${l}`);
    if (afterPass && lines.some((l) => /: moved to PASS$/.test(l))) for (const l of await afterPass()) console.log(`  ${l}`);
    if (remove.length) {
      const delFile = join(dir, 'delete.json');
      writeFileSync(delFile, JSON.stringify(remove));
      const del = await wrangler(['kv', 'bulk', 'delete', delFile, ...ns, '--force']);
      if (del.code !== 0) throw new Error(`recorded ${remove.length} mark(s) but could not clear them from the store (they would be re-applied; already-done jobs are left alone): ${lastLines(del.out)}`);
    }
    return `${names.length} mark(s): ${remove.length} recorded${kept ? `, ${kept} kept for the next run` : ''}`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Pure: .env text with the missing keys appended (existing values are never changed). */
export function withEnvEntries(text, entries) {
  const have = new Set(String(text ?? '').split(/\r?\n/).map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1]).filter(Boolean));
  const add = Object.entries(entries).filter(([k]) => !have.has(k));
  if (!add.length) return { text, added: [] };
  const body = String(text ?? '');
  return { text: `${body}${body && !body.endsWith('\n') ? '\n' : ''}\n# Phone taps → PC (autopilot/marks-sync.mjs --setup)\n${add.map(([k, v]) => `${k}=${v}`).join('\n')}\n`, added: add.map(([k]) => k) };
}

/** Reads the Access team and app id off the logged-out site's login redirect. → { team, aud } or null. */
export async function detectAccess(url) {
  try {
    const res = await fetch(`${url}/`, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    const loc = new URL(res.headers.get('location') ?? '');
    const team = loc.hostname.match(/^([a-z0-9-]+)\.cloudflareaccess\.com$/)?.[1];
    const aud = loc.searchParams.get('kid') ?? '';
    return team && /^[0-9a-f]{64}$/.test(aud) ? { team, aud } : null;
  } catch { return null; }
}

async function setup() {
  const envFile = join(ROOT, '.env');
  dotenv.config({ path: envFile, quiet: true });
  const url = siteUrl();
  if (!url) { console.log('✗ AUTOPILOT_SITE_PROJECT is not set in .env — set up the site first (node autopilot/publish-site.mjs --check)'); return 1; }
  const entries = {};
  if (/^[0-9a-f]{32}$/.test(process.env.AUTOPILOT_MARKS_KV_ID ?? '')) console.log('✓ store already created');
  else {
    const made = await wrangler(['kv', 'namespace', 'create', 'autopilot-marks']);
    const id = made.out.match(/"?id"?\s*[:=]\s*"([0-9a-f]{32})"/)?.[1];
    if (made.code !== 0 || !id) { console.log(`✗ could not create the store: ${lastLines(made.out)}`); return 1; }
    entries.AUTOPILOT_MARKS_KV_ID = id;
    console.log(`✓ store created (${id})`);
  }
  if (syncConfig({ ...process.env, ...entries })) console.log('✓ Access team + app id already set');
  else {
    const acc = await detectAccess(url);
    if (!acc) { console.log(`✗ could not read the Access team / app id from ${url}'s login redirect — is the site behind Cloudflare Access? (set AUTOPILOT_ACCESS_TEAM and AUTOPILOT_ACCESS_AUD by hand)`); }
    else { entries.AUTOPILOT_ACCESS_TEAM = acc.team; entries.AUTOPILOT_ACCESS_AUD = acc.aud; console.log(`✓ Access team ${acc.team}, app id found`); }
  }
  const r = withEnvEntries(existsSync(envFile) ? readFileSync(envFile, 'utf-8') : '', entries);
  if (r.added.length) { writeFileSync(envFile, r.text); console.log(`✓ .env updated: ${r.added.join(', ')}`); }
  const ok = Boolean(syncConfig({ ...process.env, ...entries }));
  console.log(ok ? '\nDone. Next: node autopilot/publish-site.mjs   (deploys the worker; the pages then save taps by themselves)' : '\nNot finished — see the ✗ above.');
  return ok ? 0 : 1;
}

// ── self-test ──────────────────────────────────────────────────────────────────────────────────────
async function selfTest() {
  let failed = 0;
  const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++; };
  const good = { AUTOPILOT_MARKS_KV_ID: 'a'.repeat(32), AUTOPILOT_ACCESS_TEAM: 'my-team-1a', AUTOPILOT_ACCESS_AUD: 'b'.repeat(64) };
  check('syncConfig: complete → config; any missing/malformed → null', syncConfig(good)?.team === 'my-team-1a' && !syncConfig({ ...good, AUTOPILOT_ACCESS_AUD: 'short' }) && !syncConfig({ ...good, AUTOPILOT_ACCESS_TEAM: 'a b' }) && !syncConfig({}));
  check('extractJson: skips wrangler banners', extractJson('⛅️ wrangler 4.1\n[{"name":"m:apply:1"}]\n')?.[0]?.name === 'm:apply:1' && extractJson('no json') === null);
  const bulkObj = parseBulkGet('banner\n{"m:apply:1":{"value":"{\\"action\\":\\"skip\\"}"},"m:fu:2":"{\\"action\\":\\"retire\\"}","m:lead:x":"{bad"}');
  check('parseBulkGet: object shape, string or wrapped values, unparsable → null', bulkObj.get('m:apply:1')?.action === 'skip' && bulkObj.get('m:fu:2')?.action === 'retire' && bulkObj.get('m:lead:x') === null);
  check('parseBulkGet: list shape', parseBulkGet('[{"key":"m:apply:3","value":"{\\"action\\":\\"applied\\"}"}]').get('m:apply:3')?.action === 'applied');

  const seen = [];
  const fake = {
    apply: async (m) => { seen.push(['apply', m]); return m.map((x) => (x.num === 2 ? `#2 X: FAILED — tracker busy` : `#${x.num} X: ${x.action}`)); },
    lead: async (m) => { seen.push(['lead', m]); return [m[0].id === 'ffffffffff' ? 'ffffffffff: FAILED' : `${m[0].id}: done`]; },
    fu: async (m) => { seen.push(['fu', m]); return m.map((x) => `#${x.num}: ok`); },
  };
  const values = new Map([
    ['m:apply:1', { action: 'applied' }], ['m:apply:2', { action: 'skip' }],
    ['m:lead:3f2a9c01be', { action: 'pass' }], ['m:lead:ffffffffff', { action: 'skip' }],
    ['m:fu:7', { action: 'followed' }],
    ['m:apply:3', { action: 'pass' }],   // wrong action for the kind
    ['junk', null],
  ]);
  const r = await processMarks(values, fake);
  check('processMarks: recorded ones are removed, the FAILED ones stay', ['m:apply:1', 'm:lead:3f2a9c01be', 'm:fu:7'].every((k) => r.remove.includes(k)) && !r.remove.includes('m:apply:2') && !r.remove.includes('m:lead:ffffffffff'));
  check('processMarks: invalid marks are dropped, not retried forever', r.remove.includes('m:apply:3') && r.remove.includes('junk') && r.kept === 2);
  check('processMarks: invalid marks never reach the recorders', JSON.stringify(seen.find(([k]) => k === 'apply')[1].map((x) => x.num)) === '[1,2]');
  check('processMarks: a recorder that returns a different number of lines keeps its marks', (await processMarks(new Map([['m:apply:1', { action: 'skip' }]]), { ...fake, apply: async () => [] })).remove.length === 0);

  const e = withEnvEntries('A=1', { A: '2', B: '3' });
  check('withEnvEntries: appends only missing keys, keeps existing values', e.added.join() === 'B' && e.text.includes('A=1') && !e.text.includes('A=2') && e.text.includes('B=3') && withEnvEntries('A=1\n', { A: '9' }).added.length === 0);

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--self-test')) await selfTest();
  else if (hasFlag(args, '--setup')) process.exitCode = await setup();
  else {
    dotenv.config({ path: join(ROOT, '.env'), quiet: true });
    const afterPass = hasFlag(args, '--in-daily') ? null : prepareAndPublish;
    try { console.log(await pull({ dryRun: hasFlag(args, '--dry-run'), afterPass })); } catch (err) { console.error(String(err?.message ?? err)); process.exitCode = 1; }
  }
}
