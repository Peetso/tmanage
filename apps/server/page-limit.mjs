// FIX6 Checkpoint A. A per-address limit for the pages that are rendered on every request
// (sign-in, sign-up, recover, setup, organizations, onboarding, sessions, platform). Each one
// runs server code (and most call the API) on every visit, so a script hammering them can tie up
// the one Node process the shared host gives us. The API already limits itself (RATE_LIMIT_*);
// these pages had nothing in front of them.
//
// The same token bucket and the same client-address rule as the CSP report receiver
// (csp-report.mjs): one process, in memory, the address read through TRUSTED_PROXY_ADDRESSES.
// Sized well above a person: a burst of 120 page requests (Next.js prefetches count), refilling
// at 60 a minute. Above that the page answers 429 with a short note in English and Arabic.

import { clientAddress, createReportLimiter, trustedProxyMatcher } from './csp-report.mjs';

export const PAGE_BURST = 120;
export const PAGE_PER_MINUTE = 60;

const LIMITED_PAGES = [
  '/sign-in',
  '/sign-up',
  '/portal-sign-in',
  '/recover',
  '/confirm-email',
  '/setup',
  '/organizations',
  '/onboarding',
  '/sessions',
  '/platform',
];

/** Whether a request URL is one of the limited pages (or below one), with or without `/ar`. */
export function isLimitedPagePath(url) {
  const raw = (url ?? '').split('?')[0] ?? '';
  const path = raw.startsWith('/ar/') ? raw.slice(3) : raw;
  return LIMITED_PAGES.some((page) => path === page || path.startsWith(`${page}/`));
}

const TOO_MANY = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Too many requests</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">Too many requests</h1><p>Please wait a minute, then try again.</p><p dir="rtl" lang="ar">طلبات كتير في وقت قصير. استنى دقيقة وجرّب تاني.</p></body></html>`;

/**
 * `(req, res) => boolean`: `true` when the request was over the limit and has been answered 429
 * here; `false` when it may go on to the web server.
 */
export function createPageLimiter({
  trustedProxies,
  limiter = createReportLimiter({ burst: PAGE_BURST, perMinute: PAGE_PER_MINUTE }),
} = {}) {
  const isTrusted = trustedProxyMatcher(trustedProxies);
  return (req, res) => {
    if (!isLimitedPagePath(req.url)) return false;
    if (limiter(clientAddress(req, isTrusted))) return false;
    res.writeHead(429, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '60',
      // The web server's headers are not on this answer, so it carries its own strict set.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : TOO_MANY);
    req.resume();
    return true;
  };
}
