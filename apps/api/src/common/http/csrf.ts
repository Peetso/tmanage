import { createHmac } from 'node:crypto';
import { constantTimeEquals } from '../../modules/identity/session-token.js';

/**
 * CSRF protection for cookie-authenticated mutations — `04-SECURITY-PRIVACY` §3, SEC-03.
 *
 * Pure, like `session-token.ts`, so the whole control is testable without a server or a
 * request. See ADR-0004 for why the token is shaped this way.
 *
 * ## Why a token at all, when the cookies are already `SameSite`
 *
 * The access cookie is `SameSite=Lax` and the refresh cookie is `SameSite=Strict`, and `Lax`
 * already withholds cookies from cross-site form posts. That is a real defence and it is not
 * sufficient on its own:
 *
 * - `Lax` **does** send the cookie on a top-level cross-site `GET` navigation. Nothing in this
 *   API may mutate on `GET` — the guard enforces that by only exempting the safe methods — but
 *   a control that depends on every future route author remembering a convention is the kind
 *   of control ADR-0001 exists to replace.
 * - `SameSite` is same-*site*, not same-*origin*. A sibling subdomain is the same site.
 * - 04 §3 requires the control explicitly. It is not offered as something `SameSite` may cover.
 *
 * ## Why the token is bound to the session
 *
 * The token is `HMAC(CSRF_SECRET, sessionId)`, not an opaque random value echoed back.
 *
 * A plain double-submit cookie is defeated by *cookie tossing*: an attacker who controls any
 * sibling subdomain can set a cookie on the parent domain, so they can plant a CSRF cookie
 * whose value they know and then submit a matching header. They cannot plant the victim's
 * **session** cookie, so binding the token to the session id is what closes that: a token the
 * attacker planted is bound to their session, not the victim's, and the comparison fails.
 *
 * Signing it with `CSRF_SECRET` — a value `packages/config` requires to differ from
 * `SESSION_SECRET` in production — means the attacker cannot mint one for a session id they
 * have merely observed.
 *
 * ## What this token is not
 *
 * It is not a credential. It authorises nothing by itself, which is exactly why it is the one
 * cookie in this application that JavaScript may read (see `serializeReadableCookie`): the
 * client has to echo it in a header, and a value that can only be read by same-origin script
 * is precisely the thing a cross-origin attacker cannot obtain. Presented without the
 * `HttpOnly` session cookie it proves nothing and grants nothing.
 */

/** Kept in the token so a future scheme change cannot be produced by re-labelling this one. */
const CSRF_TOKEN_VERSION = 'v1';

/**
 * Derive the CSRF token for a session.
 *
 * Deterministic: the same session always yields the same token, so a client that lost the
 * cookie can be re-issued the identical value without invalidating a tab that still holds it.
 * The value is not secret in the way the session cookie is — it is readable by same-origin
 * script by design — but it is unforgeable without `CSRF_SECRET`.
 */
export function mintCsrfToken(sessionId: string, secret: string): string {
  const signature = createHmac('sha256', secret)
    .update(`${CSRF_TOKEN_VERSION}.${sessionId}`, 'utf8')
    .digest('base64url');
  return `${CSRF_TOKEN_VERSION}.${signature}`;
}

/**
 * Verify a presented token against the session the request actually authenticated as.
 *
 * The comparison is constant-time and the token is recomputed rather than parsed: there is no
 * attacker-controlled field to decode, so there is nothing to mis-parse. A token for a
 * different session simply does not match.
 */
export function verifyCsrfToken(
  presented: string | undefined,
  sessionId: string,
  secret: string,
): boolean {
  if (!presented) return false;
  return constantTimeEquals(presented, mintCsrfToken(sessionId, secret));
}

/**
 * The methods that may skip the check.
 *
 * Defined as the safe set rather than the unsafe one. An unfamiliar or future method — `PURGE`,
 * a proxy's `LINK` — is then guarded by default instead of being silently exempt, which is the
 * direction a mistake should fall.
 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/** The header the client echoes the cookie value in. Custom, so a form post cannot set it. */
export const CSRF_HEADER = 'x-csrf-token';
