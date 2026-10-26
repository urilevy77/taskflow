// site-worker.mjs — the Cloudflare Pages worker behind the static site: stores the "I applied" / "Skip" /
// "Move to Pass" / "I followed up" taps made on the phone, so they no longer have to be copied to the PC by hand.
//
// publish-site.mjs copies this file to data/site/_worker.js (Pages "advanced mode") and ships a
// _routes.json that sends ONLY /api/* here — every page and PDF is still served as plain static files.
// Pages workers cannot import, so this file is self-contained; its named exports exist for the self-test.
//
//   POST /api/marks   { kind, id, action }   store (or, with action "undo", remove) one mark
//   GET  /api/marks                          { marks: { "<kind>:<id>": "<action>" } } — what is waiting
//
// The PC drains the store (autopilot/marks-sync.mjs → wrangler kv) and records each mark through the same
// paths as before (set-status.mjs, merge-tracker.mjs, follow-ups.md). Nothing here touches the tracker.
//
// Auth: the site is behind Cloudflare Access. Access puts a signed JWT in Cf-Access-Jwt-Assertion; this
// worker VERIFIES it (signature, expiry, audience, issuer) instead of trusting that the header exists, so a
// mistake in the Access rule cannot expose the endpoint. Without ACCESS_TEAM + ACCESS_AUD + the MARKS KV
// binding it answers 503 and the pages fall back to the copy-a-command box.
//
//   node autopilot/site-worker.mjs --self-test

/** What each kind of mark may be, and what its id looks like. */
export const KINDS = {
  apply: { id: /^\d{1,6}$/, actions: ['applied', 'skip'] },           // an Apply-page job, by report number
  lead: { id: /^[0-9a-f]{10}$/, actions: ['applied', 'skip', 'pass'] }, // a Filtered-page lead, by short URL hash
  fu: { id: /^\d{1,6}$/, actions: ['followed', 'retire'] },            // a follow-up, by tracker row number
};

/** Pure: a parsed request body → { kind, id, action } or { error }. */
export function validateMark(body) {
  const b = body && typeof body === 'object' ? body : {};
  const spec = Object.prototype.hasOwnProperty.call(KINDS, b.kind) ? KINDS[b.kind] : null;
  if (!spec) return { error: 'unknown kind' };
  if (typeof b.id !== 'string' || !spec.id.test(b.id)) return { error: 'bad id' };
  if (b.action !== 'undo' && !spec.actions.includes(b.action)) return { error: 'bad action' };
  return { kind: b.kind, id: b.id, action: b.action };
}

export const markKey = (kind, id) => `m:${kind}:${id}`;

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

// ── Cloudflare Access JWT ─────────────────────────────────────────────────────────────────────────
const b64uBytes = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const b64uJson = (s) => JSON.parse(new TextDecoder().decode(b64uBytes(s)));

/** → true when `token` is a valid, unexpired Access token for this app. `getKeys()` → the team's JWKS `keys` array. */
export async function verifyAccessJwt(token, { team, aud, getKeys, now = Math.floor(Date.now() / 1000) }) {
  try {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 3 || !team || !aud) return false;
    const head = b64uJson(parts[0]);
    if (head.alg !== 'RS256') return false;
    const jwk = (await getKeys()).find((k) => k.kid === head.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)))) return false;
    const p = b64uJson(parts[1]);
    const audOk = Array.isArray(p.aud) ? p.aud.includes(aud) : p.aud === aud;
    return audOk && p.iss === `https://${team}.cloudflareaccess.com` && typeof p.exp === 'number' && p.exp > now && (p.nbf == null || p.nbf <= now + 60);
  } catch { return false; }
}

let keyCache = { team: '', at: 0, keys: [] };
async function teamKeys(team) {
  if (keyCache.team === team && Date.now() - keyCache.at < 3_600_000) return keyCache.keys;
  const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  keyCache = { team, at: Date.now(), keys: (await res.json()).keys ?? [] };
  return keyCache.keys;
}

/** The request handler, with its collaborators injectable for the self-test. */
export async function handle(request, env, { verify = verifyAccessJwt, getKeys = () => teamKeys(env.ACCESS_TEAM) } = {}) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/marks') return json(404, { error: 'not found' });
  if (!env.MARKS || !env.ACCESS_TEAM || !env.ACCESS_AUD) return json(503, { error: 'sync not configured' });
  if (!(await verify(request.headers.get('cf-access-jwt-assertion'), { team: env.ACCESS_TEAM, aud: env.ACCESS_AUD, getKeys }))) return json(403, { error: 'not signed in' });

  if (request.method === 'GET') {
    const marks = {};
    let cursor;
    do {
      const page = await env.MARKS.list({ prefix: 'm:', cursor });
      for (const k of page.keys) {
        const v = await env.MARKS.get(k.name);
        try { marks[k.name.slice(2)] = JSON.parse(v).action; } catch { /* a malformed value is ignored, the PC drops it */ }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return json(200, { marks });
  }
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' });

  // A browser form on another site must not be able to post here with the user's cookie.
  const origin = request.headers.get('origin');
  if ((origin && origin !== url.origin) || request.headers.get('x-autopilot') !== '1') return json(403, { error: 'bad origin' });
  const raw = await request.text();
  if (raw.length > 512) return json(413, { error: 'too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'bad json' }); }
  const m = validateMark(body);
  if (m.error) return json(400, { error: m.error });
  if (m.action === 'undo') await env.MARKS.delete(markKey(m.kind, m.id));
  else await env.MARKS.put(markKey(m.kind, m.id), JSON.stringify({ action: m.action, at: new Date().toISOString() }), { expirationTtl: 60 * 86400 });
  return json(200, { ok: true });
}

export default { fetch: (request, env) => handle(request, env) };

// ── self-test ───────────────────────────────────────────────────────────────────────────────────────
async function selfTest() {
  let failed = 0;
  const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++; };

  check('validateMark: good marks of each kind', validateMark({ kind: 'apply', id: '134', action: 'applied' }).kind === 'apply' && validateMark({ kind: 'lead', id: '3f2a9c01be', action: 'pass' }).action === 'pass' && validateMark({ kind: 'fu', id: '9', action: 'retire' }).id === '9' && validateMark({ kind: 'fu', id: '9', action: 'undo' }).action === 'undo');
  check('validateMark: rejects wrong action for the kind, bad ids, unknown or inherited kinds', ['followed', 'pass'].every((a) => validateMark({ kind: 'apply', id: '1', action: a }).error) && validateMark({ kind: 'lead', id: 'XYZ', action: 'skip' }).error && validateMark({ kind: 'apply', id: '12345678', action: 'skip' }).error && validateMark({ kind: 'toString', id: '1', action: 'skip' }).error && validateMark({ kind: 'apply', id: 1, action: 'skip' }).error && validateMark(null).error);

  // A real RS256 round trip with a throwaway key.
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const now = 1_800_000_000;
  const sign = async (payload, kid = 'k1') => { const h = enc({ alg: 'RS256', kid }); const p = enc(payload); return `${h}.${p}.${b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${p}`)))}`; };
  const good = { aud: ['AUD1'], iss: 'https://me.cloudflareaccess.com', exp: now + 600 };
  const opts = { team: 'me', aud: 'AUD1', getKeys: async () => [jwk], now };
  check('jwt: valid token accepted', await verifyAccessJwt(await sign(good), opts));
  check('jwt: wrong audience, issuer, expired → rejected', !(await verifyAccessJwt(await sign({ ...good, aud: ['OTHER'] }), opts)) && !(await verifyAccessJwt(await sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }), opts)) && !(await verifyAccessJwt(await sign({ ...good, exp: now - 1 }), opts)));
  const t = await sign(good);
  const tampered = `${t.split('.')[0]}.${enc({ ...good, aud: ['AUD1'], exp: now + 99999 })}.${t.split('.')[2]}`;
  check('jwt: tampered payload, unknown kid, garbage, missing → rejected', !(await verifyAccessJwt(tampered, opts)) && !(await verifyAccessJwt(await sign(good, 'nope'), opts)) && !(await verifyAccessJwt('a.b.c', opts)) && !(await verifyAccessJwt(null, opts)));

  // The handler, against an in-memory KV.
  const store = new Map();
  const MARKS = { put: async (k, v) => { store.set(k, v); }, get: async (k) => store.get(k) ?? null, delete: async (k) => { store.delete(k); }, list: async ({ prefix }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
  const env = { MARKS, ACCESS_TEAM: 'me', ACCESS_AUD: 'AUD1' };
  const yes = { verify: async () => true }, no = { verify: async () => false };
  const post = (body, headers = {}) => new Request('https://site.pages.dev/api/marks', { method: 'POST', headers: { 'content-type': 'application/json', 'x-autopilot': '1', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  check('handler: signed-in POST stores the mark', (await handle(post({ kind: 'apply', id: '134', action: 'applied' }), env, yes)).status === 200 && JSON.parse(store.get('m:apply:134')).action === 'applied');
  check('handler: GET lists what is waiting', JSON.stringify((await (await handle(new Request('https://site.pages.dev/api/marks'), env, yes)).json()).marks) === '{"apply:134":"applied"}');
  check('handler: undo removes it', (await handle(post({ kind: 'apply', id: '134', action: 'undo' }), env, yes)).status === 200 && !store.has('m:apply:134'));
  check('handler: not signed in → 403 and nothing stored', (await handle(post({ kind: 'apply', id: '5', action: 'skip' }), env, no)).status === 403 && !store.has('m:apply:5'));
  check('handler: foreign Origin or missing marker header → 403', (await handle(post({ kind: 'apply', id: '5', action: 'skip' }, { origin: 'https://evil.example' }), env, yes)).status === 403 && (await handle(post({ kind: 'apply', id: '5', action: 'skip' }, { 'x-autopilot': '0' }), env, yes)).status === 403);
  check('handler: bad json 400, bad mark 400, oversized 413', (await handle(post('{'), env, yes)).status === 400 && (await handle(post({ kind: 'apply', id: 'x', action: 'skip' }), env, yes)).status === 400 && (await handle(post('x'.repeat(600)), env, yes)).status === 413);
  check('handler: unconfigured → 503, other path 404, other method 405', (await handle(post({}), { MARKS }, yes)).status === 503 && (await handle(new Request('https://site.pages.dev/other'), env, yes)).status === 404 && (await handle(new Request('https://site.pages.dev/api/marks', { method: 'DELETE' }), env, yes)).status === 405);
  check('handler: the real verifier rejects a request with no token', (await handle(post({ kind: 'apply', id: '5', action: 'skip' }), env, { getKeys: async () => [jwk] })).status === 403);

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
}

if (typeof process !== 'undefined' && process.argv?.includes('--self-test') && /site-worker\.mjs$/.test(process.argv[1] ?? '')) await selfTest();
