// @ts-check
// experience.mjs — years-of-experience asks in a JD, shared by prepare.mjs (gate 1 stop) and
// experience-gate.mjs (the free daily-run filter). Pure, no I/O.
//
// Policy (Uri, 2026-10-24): junior roles only — a job whose MINIMUM years ask is above
// MAX_YEARS is dropped, whether the JD marks it required or preferred. No years stated → kept.

export const MAX_YEARS = 2;

// A company's own age ("Founded 12 years ago", "20 years of experience in the market") reads like an
// ask; no junior-or-not decision should hang on a number that large, so asks above this are ignored.
const MAX_PLAUSIBLE_ASK = 12;

const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const NUM = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)';
const toNum = (s) => (/^\d+$/.test(s) ? Number(s) : WORD_NUMBERS[s.toLowerCase()]);
// Up to 40 chars before a match, on the same line and sentence — a previous line's "(Required)" is not this ask's.
const lead = (text, index) => text.slice(Math.max(0, index - 40), index).split(/[\n.]/).pop() ?? '';

const EN_RX = new RegExp(`\\b${NUM}\\s*(?:\\+|(?:-|–|to)\\s*\\d{1,2})?\\s*(?:\\+\\s*)?(?:\\(\\d{1,2}\\)\\s*)?years?\\b[^.\\n]{0,160}`, 'gi');
const EN_CONTEXT = /experience|hands-on|background|building|developing|working|professional|industry|track record/i;
// Hebrew: "3 שנות ניסיון", "3+ שנות ניסיון", "ניסיון של 3 שנים", "שנתיים ניסיון" (two years), "ניסיון של שנה".
const HE_RX = /(?:(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?(?:שנות|שנים)|(שנתיים)|ניסיון\s+של\s+(?:(\d{1,2})\s*\+?\s*שנים|(שנה)))[^.\n]{0,120}/g;

function strengthOf(text) {
  if (/required|a must|must have|minimum|at least|חובה|לפחות/i.test(text)) return 'required';
  if (/preferred|advantage|nice to have|plus\b|bonus|יתרון/i.test(text)) return 'preferred';
  return 'unmarked';
}

/**
 * Years-of-experience asks in the JD, quoted with their strength marker. For a range ("1-3 years")
 * `years` is the minimum, which is what decides whether a junior can apply.
 * @returns {{years: number, strength: 'required'|'preferred'|'unmarked', snippet: string}[]}
 */
export function experienceAsks(jdText) {
  const text = String(jdText ?? '');
  const out = [];
  for (const m of text.matchAll(EN_RX)) {
    const years = toNum(m[1]);
    const before = lead(text, m.index ?? 0);
    const snippet = m[0].trim();
    if (!EN_CONTEXT.test(snippet) && !/experience[^.\n]*$/i.test(before)) continue;
    if (/\bago\b|\bold\b|in business|in the market|history|founded/i.test(snippet)) continue;
    if (!(years >= 0) || years > MAX_PLAUSIBLE_ASK) continue;
    out.push({ years, strength: strengthOf(`${before} ${snippet}`), snippet: snippet.slice(0, 140) });
  }
  for (const m of text.matchAll(HE_RX)) {
    const years = m[1] ? Number(m[1]) : m[2] ? 2 : m[3] ? Number(m[3]) : 1;
    const snippet = m[0].trim();
    const before = lead(text, m.index ?? 0);
    if (!/ניסיון/.test(`${before} ${snippet}`)) continue;
    if (years > MAX_PLAUSIBLE_ASK) continue;
    out.push({ years, strength: strengthOf(`${before} ${snippet}`), snippet: snippet.slice(0, 140) });
  }
  return out;
}

/**
 * The junior verdict for a JD: `drop` when any ask's minimum is above MAX_YEARS.
 * @returns {{verdict: 'drop'|'ok'|'unstated', minYears: number|null, worst: ReturnType<typeof experienceAsks>[number]|null}}
 */
export function juniorVerdict(jdText, maxYears = MAX_YEARS) {
  const asks = experienceAsks(jdText);
  if (!asks.length) return { verdict: 'unstated', minYears: null, worst: null };
  // The highest minimum is the binding one: "1+ years Python, 4+ years backend" asks 4.
  const worst = asks.reduce((a, b) => (b.years > a.years ? b : a));
  return { verdict: worst.years > maxYears ? 'drop' : 'ok', minYears: worst.years, worst };
}
