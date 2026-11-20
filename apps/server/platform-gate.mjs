// PLATFORMFIX (live 2026-11-16): `/platform` rendered the Platform admin shell and its menu to a
// signed-out visitor for seconds before the browser was sent to sign-in. The page itself is
// client-side and asks the API who may see it, so the shell was on screen before the answer.
//
// This process holds the API in-process, so it asks the API's own Platform admin guard
// (`GET /v1/platform/me`, step-up and two-step exempt) BEFORE the web child renders anything:
//
//   * no session cookie, or the API answers 401  -> 307 to /sign-in?next=<the platform page>
//     ... UNLESS the browser still holds the readable CSRF cookie (AUTHSTATE, live 2026-11-19).
//     The access cookie lives 15 minutes and the refresh cookie is sent only to
//     /v1/sessions/refresh, never with a page request, so after a pause a VALID session answers
//     401 here. That request is now handed to the web child, whose shared session check
//     (SignedInGate, then PlatformAccessGate) refreshes first and draws no Platform chrome before
//     the API has said this person is an admin. Before, it was sent to sign-in, where the
//     sign-in page made the same mistake and showed a signed-in owner the empty form.
//   * the API answers 200 (an admin) or 403 (an admin who must confirm or turn on two-step)
//                                                -> the page renders as before
//   * 404 (not an admin, or Platform admin off) or another definite 4xx -> the ordinary 404 page,
//     so the answer never confirms that the area exists. Fails closed.
//   * no answer, a 5xx, a 429 or a 408 (AUTHSTATE, ENGINEERING-RULES §1.3: unknown, e.g. a deploy
//     restart) -> handed to the web child, which says "can't reach TManage, retrying" and draws no
//     Platform chrome until the API has answered (SignedInGate, PlatformAccessGate). Never sign-in,
//     never 404, and no cookie is touched: a restart is neither a sign-out nor a denial.
//
// The check carries only the visitor's cookie, host and forwarding headers, and runs under the
// visitor's own address (`remoteAddress`), so rate limits and audit see the real client.

const PLATFORM_PATH = /^\/platform(?:\/[^?#]*)?$/u;
/** Same shape as the web's allowed return path (apps/web/src/lib/sign-in-return.ts). */
const RETURN_PATH = /^\/platform(?:\/[A-Za-z0-9_-]{1,64}){0,6}$/u;
const FORWARDED_HEADERS = [
  'cookie',
  'host',
  'user-agent',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-real-ip',
];

/** True for `/platform` and every page under it (the query is ignored). */
export function isPlatformPath(url) {
  const path = String(url ?? '').split('?')[0] ?? '';
  return PLATFORM_PATH.test(path);
}

/** The sign-in address for a platform page: the page comes back only if it is a plain path. */
export function platformSignInLocation(url) {
  const path = String(url ?? '').split('?')[0] ?? '';
  return RETURN_PATH.test(path) ? `/sign-in?next=${encodeURIComponent(path)}` : '/sign-in';
}

/** The default readable CSRF cookie: `SESSION_COOKIE_NAME` (`tmanage_session`) + `_csrf`. */
export const DEFAULT_CSRF_COOKIE = 'tmanage_session_csrf';

/** True when the `Cookie` header carries a cookie named `name` (a non-empty value). */
export function hasCookie(header, name) {
  return String(header ?? '')
    .split(';')
    .some((part) => {
      const [key, ...value] = part.trim().split('=');
      return key === name && value.join('=') !== '';
    });
}

/**
 * The API's answer to `GET /v1/platform/me` as the gate's decision. `refreshable`: the request
 * carries the readable CSRF cookie, so a 401 may only be an expired access cookie.
 */
export function platformDecision(status, refreshable = false) {
  if (status === 200 || status === 403) return 'open';
  if (status === 401) return refreshable === true ? 'open' : 'sign-in';
  if (status >= 500 || status === 429 || status === 408) return 'unknown';
  return 'not-found';
}

/**
 * `inject(options)`: Fastify's `inject` (light-my-request), answering `{ statusCode }`.
 * `proxyToWeb(req, res)`: the web child. Returns `(req, res) => void`.
 */
export function createPlatformGate({
  inject,
  proxyToWeb,
  log = () => {},
  csrfCookieName = DEFAULT_CSRF_COOKIE,
}) {
  const signIn = (req, res) => {
    res.writeHead(307, { location: platformSignInLocation(req.url), 'cache-control': 'no-store' });
    res.end();
  };
  const notFound = (req, res) => {
    req.url = '/_not-found';
    proxyToWeb(req, res);
  };
  return (req, res) => {
    const cookie = req.headers['cookie'];
    if (typeof cookie !== 'string' || cookie.trim() === '') {
      signIn(req, res);
      return;
    }
    const headers = {};
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    Promise.resolve(
      inject({
        method: 'GET',
        url: '/v1/platform/me',
        headers,
        remoteAddress: req.socket?.remoteAddress ?? '127.0.0.1',
      }),
    )
      .then((answer) => platformDecision(answer.statusCode, hasCookie(cookie, csrfCookieName)))
      .catch((error) => {
        log(`platform gate: check failed (${error?.message ?? 'unknown'}); handed to the web`);
        return 'unknown';
      })
      .then((decision) => {
        if (decision === 'open' || decision === 'unknown') proxyToWeb(req, res);
        else if (decision === 'sign-in') signIn(req, res);
        else notFound(req, res);
      });
  };
}
