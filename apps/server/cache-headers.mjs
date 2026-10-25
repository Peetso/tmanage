// The Cache-Control the single-process server lets through to Hostinger's CDN (hcdn).
// Kept apart from server.mjs so it can be unit-tested without starting the application.
//
// Live fact (deploy-live/live-check-9c6d816c/fixes/M1.md, 2026-10-23): `next start` marks every
// prerendered page `s-maxage=31536000`, and hcdn honours it — after a deploy, /contact and
// /customers kept serving the previous build's bodies (hcdn HIT, two Age values for one URL).
// So a page (HTML, or the RSC payload a client navigation fetches for it) may sit in a shared
// cache for a minute at most and is revalidated after that; content-hashed /_next/static assets
// keep their one-year immutable cache, because a new build ships new names.

/** A page any visitor may share: browsers always revalidate, the CDN keeps it a minute. */
export const PAGE_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';

/** Content-hashed build assets: one year, never revalidated (matches apps/web static-headers). */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** What an API response carries when its route set no Cache-Control of its own. */
export const API_DEFAULT_CACHE_CONTROL = 'no-store';

/** The longest a shared cache may keep anything the web child serves outside /_next/static. */
export const MAX_SHARED_SECONDS = 60;

const STATIC_PREFIX = '/_next/static/';

/**
 * The saved-locale cookie (apps/web/src/lib/i18n/locale-cookie.ts). The root layout does not read
 * it today (the public pages stay prerendered, release no-go 70645c82; the browser applies the
 * locale), but it is the one request input a page could be rendered from, so as a guard every page
 * varies by `Cookie`, and a page served to a request carrying it is never put in a shared cache.
 * Visitors without the cookie keep the short shared policy.
 */
export const LOCALE_COOKIE = 'tmanage_locale';

/** What a page rendered for a saved locale leaves with when the web child sent a shared policy. */
export const LOCALE_PAGE_CACHE_CONTROL = 'private, no-store';

function pathOf(url) {
  return (url ?? '').split('?')[0];
}

function headerText(value) {
  return Array.isArray(value) ? value.join(', ') : String(value ?? '');
}

/** True when the policy already keeps the response out of shared caches. */
function isPrivate(cacheControl) {
  return /(^|[\s,])(private|no-store)([\s,=]|$)/i.test(cacheControl);
}

/** The largest shared-cache lifetime the policy allows, in seconds (s-maxage, else max-age). */
function sharedSeconds(cacheControl) {
  const s = /(?:^|[\s,])s-maxage\s*=\s*"?(\d+)/i.exec(cacheControl);
  if (s) return Number(s[1]);
  const m = /(?:^|[\s,])max-age\s*=\s*"?(\d+)/i.exec(cacheControl);
  return m ? Number(m[1]) : 0;
}

function isPage(upstreamHeaders) {
  const type = headerText(upstreamHeaders['content-type']).toLowerCase();
  return type.includes('text/html') || type.includes('text/x-component');
}

/**
 * The `cache-control` a proxied web response leaves with, or undefined to keep the upstream one.
 *
 * - `/_next/static/*`: kept; given the immutable year if the web child sent none.
 * - A private or no-store policy (an authenticated, dynamic page): kept as it is.
 * - HTML / RSC: always {@link PAGE_CACHE_CONTROL}, whatever lifetime Next asked for.
 * - Anything else allowed in a shared cache for more than {@link MAX_SHARED_SECONDS}: capped to
 *   {@link PAGE_CACHE_CONTROL}, so no `public/` file or route handler outlives a deploy either.
 */
export function webCacheControl(url, upstreamHeaders) {
  const upstream = headerText(upstreamHeaders['cache-control']);
  if (pathOf(url).startsWith(STATIC_PREFIX)) {
    return upstream === '' ? IMMUTABLE_CACHE_CONTROL : undefined;
  }
  if (isPrivate(upstream)) return undefined;
  if (isPage(upstreamHeaders)) return PAGE_CACHE_CONTROL;
  if (sharedSeconds(upstream) > MAX_SHARED_SECONDS) return PAGE_CACHE_CONTROL;
  return undefined;
}

/** True when a `Cookie` request header carries the saved-locale cookie. */
export function hasLocaleCookie(cookieHeader) {
  return headerText(cookieHeader)
    .split(';')
    .some((part) => part.split('=')[0].trim() === LOCALE_COOKIE);
}

/** `vary` with `Cookie` added once (case-insensitive), keeping what the web child listed. */
function varyWithCookie(upstreamVary) {
  const listed = headerText(upstreamVary)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (listed.some((entry) => entry === '*' || entry.toLowerCase() === 'cookie')) {
    return listed.join(', ');
  }
  return [...listed, 'Cookie'].join(', ');
}

/**
 * Headers to merge over a proxied web response (an empty object when nothing changes).
 *
 * On top of {@link webCacheControl} a page (HTML or RSC) always carries `Vary: Cookie`, and when
 * the request carried the locale cookie it is `private, no-store` unless the web child already
 * made it private (Next does for every dynamic page). Should a page ever be rendered from the
 * saved locale, one visitor's Arabic page still cannot be served from the CDN to another visitor,
 * even by a cache that ignores `Vary`.
 */
export function webCacheHeaders(url, upstreamHeaders, requestHeaders = {}) {
  const value = webCacheControl(url, upstreamHeaders);
  const headers = value === undefined ? {} : { 'cache-control': value };
  if (pathOf(url).startsWith(STATIC_PREFIX) || !isPage(upstreamHeaders)) return headers;
  headers.vary = varyWithCookie(upstreamHeaders.vary);
  const effective = value ?? headerText(upstreamHeaders['cache-control']);
  if (hasLocaleCookie(requestHeaders.cookie) && !isPrivate(effective)) {
    headers['cache-control'] = LOCALE_PAGE_CACHE_CONTROL;
  }
  return headers;
}

/**
 * Give an API response a no-store default before it is routed. Fastify passes the route's own
 * headers to `writeHead`, which overrides a value set here, so a route that chose a policy keeps
 * it, and one that chose nothing is never stored by the CDN.
 */
export function applyApiCacheDefault(res) {
  if (!res.hasHeader('cache-control')) res.setHeader('cache-control', API_DEFAULT_CACHE_CONTROL);
}
