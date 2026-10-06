#!/usr/bin/env node
// @ts-check
// apply-kit.mjs — builds the phone-friendly "apply kit" part of the daily email
// (design/daily-task-design.md §13). Pure builders + one file finder; sends nothing.
//
// Per READY / CHECK job the email carries: company · role · score · why it fits · warnings,
// a big Apply button (the posting), the tailored CV as an attachment, and — when a phone URL
// is configured — a link to the "I applied / Skip" page. The user fills the form and taps
// Submit; nothing here applies to anything.
//
//   node autopilot/apply-kit.mjs --self-test

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = getCareerOpsRoot();

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Only real web links become buttons — rows can come from WhatsApp, i.e. untrusted text. */
export const safeHttpUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u ?? '').trim()) ? String(u).trim() : null);

/** The first paragraph of cv.md's "## Summary" — the ready-to-paste intro. No LLM, nothing invented. */
export function summaryFromCv(cvMd) {
  const m = String(cvMd ?? '').match(/^##\s+Summary\s*\r?\n+([\s\S]*?)(?=\r?\n##\s|(?![\s\S]))/im);
  return m ? m[1].trim().split(/\r?\n\s*\r?\n/)[0].replace(/\s*\r?\n\s*/g, ' ').trim() : '';
}

/** Newest tailored CV in a job bundle: output/NNN-…/cv/tailored/vNNN/cv.pdf. */
export function findBundleCv(bundle, root = ROOT) {
  if (!bundle) return null;
  const dir = join(root, bundle, 'cv', 'tailored');
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^v\d+$/.test(d.name)).map((d) => d.name).sort().reverse();
  for (const v of versions) {
    const pdf = join(dir, v, 'cv.pdf');
    if (existsSync(pdf)) return pdf;
  }
  return null;
}

const fileSafe = (s) => String(s ?? '').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'job';
export const cvAttachmentName = (company) => `Uri_Levy_CV_${fileSafe(company)}.pdf`;

const COLORS = { READY: '#1a7f37', CHECK: '#9a6700', BLOCKED: '#8c959f' };

/** One line about the CV: attached (and how it was made), pending, or failed. */
export function cvLine(rec, cvFile) {
  const c = rec.cv ?? null;
  if (cvFile) {
    const how = c?.status === 'reused' ? ` · reused from ${esc(c.library ?? 'CVs/')}` : c?.status === 'tailored' ? ' · tailored for this role' : '';
    return `📎 CV attached: <b>${esc(cvFile)}</b>${how}`;
  }
  if (c?.status === 'pending') return `📄 CV pending — ${esc(c.note ?? 'will be made in the next run')}`;
  if (c?.status === 'failed') return `⚠ CV not made — ${esc(c.note ?? 'tailoring failed')}`;
  return '📄 No tailored CV yet for this job';
}

function card(rec, { cvFile, phoneUrl }) {
  const url = safeHttpUrl(rec.url);
  const color = COLORS[rec.label] ?? '#555';
  const btn = (href, text, bg) => `<a href="${esc(href)}" style="display:block;text-align:center;padding:14px 10px;margin:8px 0;border-radius:10px;background:${bg};color:#fff;font-weight:700;font-size:17px;text-decoration:none">${esc(text)}</a>`;
  const gaps = (rec.gaps ?? []).slice(0, 6);
  return `<div style="border:1px solid #d0d7de;border-left:6px solid ${color};border-radius:10px;padding:12px 14px;margin:14px 0">
<div style="font-size:12px;font-weight:700;color:${color}">${esc(rec.label)} · ${rec.score != null ? esc(Number(rec.score).toFixed(1)) + '/5' : ''}${rec.location ? ' · ' + esc(rec.location) : ''}</div>
<div style="font-size:18px;font-weight:700;margin:2px 0">${esc(rec.company)} — ${esc(rec.title)}</div>
<div style="font-size:14px;color:#444">${esc(rec.triage_reason)}</div>
${(rec.reasons ?? []).map((r) => `<div style="font-size:13px;color:#9a6700;margin-top:4px">⚠ ${esc(r)}</div>`).join('')}
${gaps.length ? `<div style="font-size:12px;color:#666;margin-top:4px">Possible gaps: ${esc(gaps.join(', '))}</div>` : ''}
<div style="font-size:13px;margin-top:6px">${cvLine(rec, cvFile)}</div>
${url ? btn(url, 'Apply ›', '#0969da') : '<div style="font-size:13px;color:#8c959f">(no safe link — open from the report)</div>'}
${safeHttpUrl(phoneUrl) ? btn(/** @type {string} */ (safeHttpUrl(phoneUrl)), 'I applied / Skip', '#57606a') : ''}
</div>`;
}

/**
 * @param {Array<Record<string, any>>} records  today's prepared records (prepare-new.mjs)
 * @param {{ phoneUrl?: string, cvSummary?: string, findCv?: (rec: any) => string | null }} [opts]
 * @returns {{ counts: {READY:number, CHECK:number, BLOCKED:number}, html: string, text: string, attachments: {filename: string, path: string}[] }}
 */
export function buildApplyKit(records, { phoneUrl = '', cvSummary = '', findCv = (r) => findBundleCv(r.bundle) } = {}) {
  const counts = { READY: 0, CHECK: 0, BLOCKED: 0 };
  for (const r of records) if (r.label in counts) counts[r.label] += 1;

  const offered = [...records.filter((r) => r.label === 'READY'), ...records.filter((r) => r.label === 'CHECK')];
  const attachments = [];
  const cards = [];
  const textLines = [];
  for (const rec of offered) {
    const pdf = findCv(rec);
    const cvFile = pdf ? cvAttachmentName(rec.company) : null;
    if (pdf && cvFile) attachments.push({ filename: cvFile, path: pdf });
    cards.push(card(rec, { cvFile, phoneUrl }));
    textLines.push(`[${rec.label}] ${rec.company} — ${rec.title} (${rec.score ?? '?'}/5)\n  ${rec.triage_reason}${(rec.reasons ?? []).map((x) => `\n  ! ${x}`).join('')}\n  ${safeHttpUrl(rec.url) ?? '(no safe link)'}${cvFile ? `\n  CV: ${cvFile} (attached)` : ''}`);
  }

  const blocked = records.filter((r) => r.label === 'BLOCKED');
  const html = `${cards.join('')}${blocked.length ? `<p style="font-size:13px;color:#57606a">${blocked.length} job(s) blocked (already applied, closed, blacklisted or no usable JD): ${blocked.map((b) => esc(`${b.company} — ${b.reasons?.[0] ?? ''}`)).join('; ')}</p>` : ''}${cvSummary ? `<div style="border:1px dashed #b6bcc3;border-radius:10px;padding:10px 12px;margin:14px 0;font-size:14px"><b>Intro you can paste</b> (from your cv.md summary):<br>${esc(cvSummary)}</div>` : ''}`;
  const text = `${textLines.join('\n\n')}${blocked.length ? `\n\n${blocked.length} blocked: ${blocked.map((b) => `${b.company} (${b.reasons?.[0] ?? ''})`).join('; ')}` : ''}${cvSummary ? `\n\nIntro you can paste:\n${cvSummary}` : ''}`;
  return { counts, html, text, attachments };
}

/** Compact HTML table of the per-source funnel (autopilot/sources.mjs rows). Empty input → ''. */
export function sourcesTableHtml(rows, limit = 10) {
  const top = (rows ?? []).slice(0, limit);
  if (!top.length) return '';
  const td = 'padding:3px 6px;text-align:right;border-bottom:1px solid #eee';
  const body = top.map((r) => `<tr><td style="padding:3px 6px;border-bottom:1px solid #eee">${esc(r.source)}</td>${[r.found, r.pass, r.prepared, r.applied, r.responded, r.interview].map((n) => `<td style="${td}">${n}</td>`).join('')}</tr>`).join('');
  return `<h3>Sources (all time)</h3><table style="border-collapse:collapse;font-size:12px"><tr style="color:#57606a"><th align="left">source</th><th>found</th><th>PASS</th><th>prep</th><th>applied</th><th>resp</th><th>intv</th></tr>${body}</table>`;
}

// ---------------------------------------------------------------------------

function selfTest() {
  let pass = 0, fail = 0;
  const check = (n, c) => { if (c) pass += 1; else { fail += 1; console.error(`FAIL: ${n}`); } };

  check('safeHttpUrl accepts https', safeHttpUrl('https://a.com/x?y=1') === 'https://a.com/x?y=1');
  check('safeHttpUrl rejects javascript:', safeHttpUrl('javascript:alert(1)') === null);
  check('safeHttpUrl rejects quotes', safeHttpUrl('https://a.com/"onmouseover=x') === null);

  check('summaryFromCv first paragraph', summaryFromCv('# N\n\n## Summary\n\nFirst line\nwraps here.\n\nSecond para.\n\n## Experience\n\nx') === 'First line wraps here.');
  check('summaryFromCv missing section', summaryFromCv('# N\n\n## Experience\n') === '');
  check('attachment name is file-safe', cvAttachmentName('IAI - Israel <Aerospace>') === 'Uri_Levy_CV_IAI_Israel_Aerospace.pdf');

  const recs = [
    { label: 'READY', company: 'Acme <b>', title: 'Backend Dev', score: 4.2, location: 'Tel Aviv', url: 'https://acme.com/j/1', triage_reason: 'fits', reasons: [], gaps: ['Go'], bundle: 'output/1-acme' },
    { label: 'CHECK', company: 'Beta', title: 'SWE', score: 3.6, url: 'javascript:evil()', triage_reason: 'ok', reasons: ['JD asks 3+ years'], gaps: [], bundle: null },
    { label: 'BLOCKED', company: 'Gamma', title: 'X', score: 4, url: 'https://g.com', reasons: ['already in the tracker as #5'] },
  ];
  const kit = buildApplyKit(recs, { phoneUrl: 'http://100.1.2.3:3000/?t=abc', cvSummary: 'I build <things>.', findCv: (r) => (r.bundle ? 'C:/x/cv.pdf' : null) });
  check('counts', kit.counts.READY === 1 && kit.counts.CHECK === 1 && kit.counts.BLOCKED === 1);
  check('one attachment (READY with a CV)', kit.attachments.length === 1 && kit.attachments[0].filename === 'Uri_Levy_CV_Acme_b.pdf');
  check('html escapes company', kit.html.includes('Acme &lt;b&gt;') && !kit.html.includes('Acme <b>'));
  check('unsafe url gets no button', !kit.html.includes('javascript:'));
  check('safe url becomes Apply button', kit.html.includes('href="https://acme.com/j/1"'));
  check('phone link is used as given (token included)', kit.html.includes('href="http://100.1.2.3:3000/?t=abc"'));
  check('unsafe phone link is dropped', !buildApplyKit(recs, { phoneUrl: 'javascript:x', findCv: () => null }).html.includes('I applied / Skip'));
  check('CHECK warning shown', kit.html.includes('JD asks 3+ years'));
  check('blocked summarised not carded', kit.html.includes('1 job(s) blocked') && !kit.html.includes('Gamma —') === false);
  check('intro escaped', kit.html.includes('I build &lt;things&gt;.'));
  check('text version has the URL', kit.text.includes('https://acme.com/j/1'));
  check('cvLine: reused', cvLine({ cv: { status: 'reused', library: 'CVs/Software_Engineer' } }, 'a.pdf').includes('reused from CVs/Software_Engineer'));
  check('cvLine: pending', cvLine({ cv: { status: 'pending', note: 'daily tailor cap reached (3)' } }, null).includes('daily tailor cap reached'));
  check('cvLine: failed', cvLine({ cv: { status: 'failed', note: 'claim not in cv.md' } }, null).startsWith('⚠ CV not made'));
  check('sources table renders and escapes', sourcesTableHtml([{ source: 'whatsapp:<AI>', found: 5, pass: 2, prepared: 2, applied: 1, responded: 0, interview: 0 }]).includes('whatsapp:&lt;AI&gt;') && sourcesTableHtml([]) === '');
  check('no phone link without phoneUrl', !buildApplyKit(recs, { findCv: () => null }).html.includes('I applied / Skip'));

  console.log(`apply-kit.mjs self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--self-test')) process.exitCode = selfTest() ? 0 : 1;
  else console.log('Usage: node autopilot/apply-kit.mjs --self-test');
}
