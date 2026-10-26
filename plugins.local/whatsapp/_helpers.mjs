// @ts-check
// Pure, side-effect-free WhatsApp lead helpers. Mirrors plugins/gmail/_helpers.mjs's
// URL-cleaning approach (own copy: this plugin lives in plugins.local/, never
// auto-updated, so it must not depend on a bundled plugin's internals shifting
// under it). Files prefixed with _ are never discovered as plugins.

/**
 * Extract all http/https URLs from a WhatsApp message body. Dedups.
 * @param {string} body
 * @returns {string[]}
 */
export function extractUrls(body) {
  if (!body) return [];
  const urls = [];
  const regex = /https?:\/\/[^\s"'<>()]+/gi;
  let match;
  while ((match = regex.exec(body)) !== null) {
    urls.push(match[0].replace(/[.,;:!?)\]]+$/, ''));
  }
  return [...new Set(urls)];
}

const ASSET_EXT_RE = /\.(jpe?g|png|gif|svg|webp|avif|ico|bmp|mp4|webm|mp3|wav|pdf)(\?|#|$)/i;

/**
 * Is this a link worth queuing (not a WhatsApp-internal asset, tracker, or
 * chat-invite link)?
 * @param {string} url
 * @returns {boolean}
 */
export function isCleanUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const lowerUrl = url.toLowerCase();
    const badKeywords = [
      'chat.whatsapp.com', 'wa.me', 'click', 'track', 'utm_', 'bit.ly/unsubscribe',
    ];
    if (badKeywords.some(kw => lowerUrl.includes(kw))) return false;
    if (ASSET_EXT_RE.test(u.pathname + u.search)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort company name from a known ATS URL (greenhouse/lever/ashby slug).
 * @param {string} url
 * @returns {string}
 */
export function companyFromUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const parts = pathname.split('/').filter(Boolean);
    if (/(^|\.)greenhouse\.io$/.test(hostname) || /(^|\.)lever\.co$/.test(hostname)) {
      return parts[0] || '';
    }
    if (/(^|\.)ashbyhq\.com$/.test(hostname)) {
      return parts[0] || '';
    }
  } catch { /* malformed → no company */ }
  return '';
}
