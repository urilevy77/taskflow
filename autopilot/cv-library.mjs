#!/usr/bin/env node
/**
 * autopilot/cv-library.mjs — role-folder CV library for the tailor step.
 *
 *   CVs/<Role>/Uri_Levy_CV.pdf   the canonical tailored CV for this role family
 *   CVs/<Role>/render.json       what it was built from (regenerable, revisable)
 *   CVs/<Role>/source_jd.md      the JD it was tailored for (the similarity anchor)
 *   CVs/<Role>/meta.json         cv.md hash, source report, version, date
 *   CVs/<Role>/history/vNNN/     earlier canonical CVs — never overwritten silently
 *   CVs/_Base/                   the general CV, built from cv.md (fallback)
 *
 * Reuse is by ROLE FAMILY, not by job description: any job whose title maps to a role that already has
 * a fresh CV reuses it, whatever the company. lookup() decides with no LLM call:
 *   reuse             → the role's own CV exists and cv.md hasn't changed since → copy it, zero cost
 *   reuse-with-edits  → no CV for this role, but a RELATED role has one → tailor FROM that CV's
 *                       render.json (1 LLM call) and save the result as this role's CV
 *                       Keeping the JD overlap score is advisory only; it never blocks a reuse.
 *   tailor            → no CV for the role or a related role, or cv.md changed (stale) → tailor from cv.md
 *
 *   node autopilot/cv-library.mjs list
 *   node autopilot/cv-library.mjs classify "<job title>"
 *   node autopilot/cv-library.mjs check --job <report#|fragment>     (dry lookup, no writes)
 *   node autopilot/cv-library.mjs promote --job <report#|fragment> [--version v002]
 *   node autopilot/cv-library.mjs --self-test
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, renameSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { jaccardSimilarity } from '../jd-similarity.mjs';
import { flagValue, hasFlag } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

export const BASE_ROLE = '_Base';
const LIB_NAME = 'CVs';

/**
 * Roles whose CV is a sound starting point for another role, in preference order. Used only when the
 * target role has no CV of its own. Deliberately small: a wrong neighbour costs a worse first draft.
 */
export const RELATED = {
  Software_Engineer: ['Data_Engineer', 'AI_ML_Engineer'],
  Data_Engineer: ['Software_Engineer'],
  AI_ML_Engineer: ['Software_Engineer', 'Data_Engineer'],
  Data_Scientist: ['AI_ML_Engineer', 'Data_Engineer'],
  DevOps_Engineer: ['Software_Engineer'],
  Frontend_Engineer: ['Software_Engineer'],
  QA_Automation_Engineer: ['Software_Engineer'],
};

export const libraryDir = (root = getCareerOpsRoot()) => join(root, LIB_NAME);
export const roleDir = (role, root = getCareerOpsRoot()) => join(libraryDir(root), role);

export const cvHash = (text) => createHash('sha1').update(String(text ?? '').replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 12);

// ── Role classification (title-based, deterministic, ordered: first match wins) ──────────

const ROLE_RULES = [
  ['Data_Scientist', /\bdata scien/i],
  ['Data_Engineer', /\bdata (engineer|infrastructure|platform|pipeline|architect)|\bbig data\b|\betl\b|\banalytics engineer|\bdata ?warehouse|\bdwh\b/i],
  ['AI_ML_Engineer', /\b(ai|ml|llm|genai|nlp|mlops)\b|machine learning|generative|deep learning|computer vision|applied scien/i],
  ['DevOps_Engineer', /\bdevops\b|\bsre\b|site reliability|platform engineer|infrastructure engineer|cloud engineer|\bdevsecops\b/i],
  ['QA_Automation_Engineer', /\bqa\b|\bsdet\b|quality assurance|test automation|automation engineer|\btest engineer/i],
  ['Frontend_Engineer', /front.?end|\bui engineer|\bweb developer/i],
  ['Software_Engineer', /back.?end|full.?stack|software|developer|\bswe\b|r&d engineer|\bengineer\b/i],
];

const LEVEL_WORDS = /\b(senior|sr|junior|jr|staff|principal|lead|mid|entry|intern|student|i{1,3}|iv|v)\b\.?/gi;

/** Map a job title to a role-folder name. Unmatched titles become their own (sanitised) folder. */
export function classifyRole(title) {
  const t = String(title ?? '');
  for (const [role, rx] of ROLE_RULES) if (rx.test(t)) return role;
  const cleaned = t.split(/\s[-–—|]\s|,|\(/)[0].replace(LEVEL_WORDS, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 4);
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('_') : 'Other';
}

// ── Library reads ──────────────────────────────────────────────────────────

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };

export function readEntry(role, root) {
  const dir = roleDir(role, root);
  const meta = readJson(join(dir, 'meta.json'));
  if (!meta) return null;
  const pdf = join(dir, meta.file);
  if (!existsSync(pdf)) return null;
  return { role, dir, meta, pdf, renderPath: join(dir, 'render.json'), sourceJd: existsSync(join(dir, 'source_jd.md')) ? readFileSync(join(dir, 'source_jd.md'), 'utf-8') : '' };
}

export function list(root) {
  const lib = libraryDir(root);
  if (!existsSync(lib)) return [];
  return readdirSync(lib, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => readEntry(d.name, root)).filter(Boolean);
}

/**
 * Decide whether an existing CV covers this job. Pure read — never writes.
 * → { decision: 'reuse'|'reuse-with-edits'|'tailor', role, reason, score?, entry? }
 * `role` is always the job's own role folder; `entry` is the CV being reused/adapted (may be a related role's).
 */
export function lookup({ title, jd, cvMd, root }) {
  const role = classifyRole(title);
  const fresh = (e) => e && e.meta.cv_hash === cvHash(cvMd);
  const overlap = (e) => (jd && e.sourceJd ? jaccardSimilarity(jd, e.sourceJd) : undefined);
  const own = readEntry(role, root);
  if (own) return fresh(own) ? { decision: 'reuse', role, reason: 'role-match', score: overlap(own), entry: own } : { decision: 'tailor', role, reason: 'stale-cv', entry: own };
  for (const rel of RELATED[role] ?? []) {
    const e = readEntry(rel, root);
    if (fresh(e)) return { decision: 'reuse-with-edits', role, reason: `related-role:${rel}`, score: overlap(e), entry: e };
  }
  return { decision: 'tailor', role, reason: 'no-cv-for-role' };
}

// ── Library writes ─────────────────────────────────────────────────────────

const ARTIFACTS = ['render.json', 'source_jd.md', 'meta.json'];

/**
 * Store a CV as the role's canonical one. An existing canonical CV moves to history/vNNN/ first.
 * `renderJson` is the object (or JSON string) the PDF was built from.
 */
export function save({ role, pdf, renderJson, jd, cvMd, root, meta = {} }) {
  const dir = roleDir(role, root);
  mkdirSync(dir, { recursive: true });
  const prev = readEntry(role, root);
  if (prev) {
    const hist = join(dir, 'history', `v${String(prev.meta.version ?? 1).padStart(3, '0')}`);
    mkdirSync(hist, { recursive: true });
    for (const f of [prev.meta.file, ...ARTIFACTS]) if (existsSync(join(dir, f))) renameSync(join(dir, f), join(hist, f));
  }
  const json = typeof renderJson === 'string' ? JSON.parse(renderJson) : renderJson;
  const name = String(json?.candidate?.name ?? '').trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_-]/gu, '');
  const file = `${name || 'CV'}${name ? '_CV' : ''}.pdf`;
  copyFileSync(pdf, join(dir, file));
  writeFileSync(join(dir, 'render.json'), `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(join(dir, 'source_jd.md'), String(jd ?? ''));
  const full = { role, file, version: (prev?.meta.version ?? 0) + 1, saved_at: new Date().toISOString().slice(0, 10), cv_hash: cvHash(cvMd), ...meta };
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(full, null, 2)}\n`);
  return readEntry(role, root);
}

// ── CLI ────────────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const check = (n, c) => { if (c) pass++; else { fail++; console.log(`  ✗ ${n}`); } };
  const cls = (t, want) => check(`classify "${t}" → ${want} (got ${classifyRole(t)})`, classifyRole(t) === want);
  cls('Senior Backend Engineer - IL', 'Software_Engineer');
  cls('Software Engineer II', 'Software_Engineer');
  cls('Full Stack Developer', 'Software_Engineer');
  cls('Big Data / Data Infrastructure Engineer', 'Data_Engineer');
  cls('Senior Data Engineer', 'Data_Engineer');
  cls('Data Scientist', 'Data_Scientist');
  cls('AI Engineer', 'AI_ML_Engineer');
  cls('Machine Learning Engineer', 'AI_ML_Engineer');
  cls('Senior DevOps Engineer', 'DevOps_Engineer');
  cls('QA Automation Engineer', 'QA_Automation_Engineer');
  cls('Frontend Developer', 'Frontend_Engineer');
  cls('Solutions Architect - Tel Aviv', 'Solutions_Architect');
  cls('Senior Product Manager (Growth)', 'Product_Manager');
  cls('', 'Other');

  const root = mkdtempSync(join(tmpdir(), 'cvlib-'));
  try {
    const cvMd = '# Uri\nengineer of things';
    const jd = 'Backend engineer python fastapi postgres docker rest apis microservices team collaboration';
    check('lookup on empty library → tailor/no-cv-for-role', (() => { const r = lookup({ title: 'Backend Engineer', jd, cvMd, root }); return r.decision === 'tailor' && r.reason === 'no-cv-for-role'; })());
    const pdf = join(root, 'in.pdf'); writeFileSync(pdf, '%PDF-fake');
    const render = { candidate: { name: 'Uri Levy' }, summary: 'v1' };
    const e1 = save({ role: 'Software_Engineer', pdf, renderJson: render, jd, cvMd, root, meta: { source_report: '120' } });
    check('save writes Uri_Levy_CV.pdf', e1.meta.file === 'Uri_Levy_CV.pdf' && existsSync(join(root, 'CVs', 'Software_Engineer', 'Uri_Levy_CV.pdf')));
    check('save records hash + version 1', e1.meta.cv_hash === cvHash(cvMd) && e1.meta.version === 1);
    check('same role, same JD → reuse', lookup({ title: 'Software Engineer', jd, cvMd, root }).decision === 'reuse');
    const other = lookup({ title: 'Backend Developer II', jd: 'quarterly sales pipeline forecasting salesforce negotiation territory quota', cvMd, root });
    check('same role, DIFFERENT company/JD → still reuse (role-family reuse)', other.decision === 'reuse' && other.reason === 'role-match' && other.score < 0.2);
    check('senior title, same family → reuse', lookup({ title: 'Senior Backend Engineer - IL', jd: 'senior ' + jd, cvMd, root }).decision === 'reuse');
    const stale = lookup({ title: 'Software Engineer', jd, cvMd: `${cvMd} and a new job`, root });
    check('changed cv.md → stale-cv, tailor', stale.decision === 'tailor' && stale.reason === 'stale-cv');
    check('CRLF cv.md hashes the same', lookup({ title: 'Software Engineer', jd, cvMd: cvMd.split('\n').join('\r\n'), root }).decision === 'reuse');
    const rel = lookup({ title: 'Data Engineer', jd, cvMd, root });
    check('related role (Data ← Software) → reuse-with-edits from Software_Engineer', rel.decision === 'reuse-with-edits' && rel.reason === 'related-role:Software_Engineer' && rel.role === 'Data_Engineer' && rel.entry.role === 'Software_Engineer');
    check('stale related CV is not used', lookup({ title: 'Data Engineer', jd, cvMd: `${cvMd} changed`, root }).reason === 'no-cv-for-role');
    check('unrelated role with no CV → tailor', lookup({ title: 'Product Manager', jd, cvMd, root }).reason === 'no-cv-for-role');
    check('role with own CV beats related', (() => { save({ role: 'Data_Engineer', pdf, renderJson: render, jd, cvMd, root }); const r = lookup({ title: 'Data Engineer', jd, cvMd, root }); return r.decision === 'reuse' && r.entry.role === 'Data_Engineer'; })());
    const e2 = save({ role: 'Software_Engineer', pdf, renderJson: { ...render, summary: 'v2' }, jd, cvMd, root });
    check('resave → version 2, v1 archived, not lost', e2.meta.version === 2 && existsSync(join(root, 'CVs', 'Software_Engineer', 'history', 'v001', 'Uri_Levy_CV.pdf')) && readJson(join(root, 'CVs', 'Software_Engineer', 'history', 'v001', 'render.json')).summary === 'v1');
    check('list returns the entry', list(root).length === 2 && list(root).every((e) => e.role !== '_Base'));
  } finally { rmSync(root, { recursive: true, force: true }); }
  console.log(`cv-library.mjs self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--self-test')) process.exit(selfTest() ? 0 : 1);
  const cmd = args[0];
  const root = getCareerOpsRoot();
  if (cmd === 'list') {
    const rows = list(root);
    if (!rows.length) console.log('CVs/ is empty.');
    for (const r of rows) console.log(`${r.role.padEnd(24)} v${r.meta.version}  ${r.meta.saved_at}  ${relative(root, r.pdf)}${r.meta.cv_hash !== cvHash(existsSync(join(root, 'cv.md')) ? readFileSync(join(root, 'cv.md'), 'utf-8') : '') ? '  (STALE: cv.md changed)' : ''}`);
  } else if (cmd === 'classify') {
    console.log(classifyRole(args.slice(1).join(' ')));
  } else if (cmd === 'check' || cmd === 'promote') {
    const { findBundle } = await import('./tailor.mjs');
    const q = flagValue(args, '--job');
    const bundles = q ? findBundle(q) : [];
    if (bundles.length !== 1) { console.log(`✗ ${q ? `"${q}" matches ${bundles.length} bundles` : 'usage: --job <report#|fragment>'}`); process.exit(2); }
    const state = readJson(join(bundles[0], 'state.json'));
    const jdPath = join(bundles[0], 'jd', 'current.md');
    const jd = existsSync(jdPath) ? readFileSync(jdPath, 'utf-8') : '';
    const cvMd = readFileSync(join(root, 'cv.md'), 'utf-8');
    if (cmd === 'check') {
      const r = lookup({ title: state.role, jd, cvMd, root });
      console.log(`${state.role} → CVs/${r.role}/  ${r.decision}  (${r.reason}${r.score != null ? `, similarity ${r.score.toFixed(2)}` : ''})`);
    } else {
      const tdir = join(bundles[0], 'cv', 'tailored');
      const ver = flagValue(args, '--version') ?? readdirSync(tdir).filter((n) => /^v\d+$/.test(n)).sort().pop();
      const vdir = join(tdir, ver ?? '');
      if (!ver || !existsSync(join(vdir, 'cv.pdf'))) { console.log('✗ no tailored PDF to promote (run tailor.mjs first)'); process.exit(1); }
      const role = classifyRole(state.role);
      const e = save({ role, pdf: join(vdir, 'cv.pdf'), renderJson: readFileSync(join(vdir, 'render.json'), 'utf-8'), jd, cvMd, root, meta: { source_report: state.report_num, company: state.company, title: state.role, from: `${relative(root, vdir)}` } });
      console.log(`✓ promoted ${ver} → ${relative(root, e.pdf)} (v${e.meta.version})`);
    }
  } else {
    console.log('usage: cv-library.mjs list | classify "<title>" | check --job <n> | promote --job <n> [--version vNNN] | --self-test');
    process.exit(2);
  }
}
