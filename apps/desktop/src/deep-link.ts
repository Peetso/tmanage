/**
 * Deep-link routing for the TManage desktop companion (module 22).
 *
 * `42-INTERACTION-MOTION-RESPONSIVE-AND-RTL` §"Desktop" requires that a deep link
 * "restore organization, project, view, object, and safe Lens tab" — i.e. a
 * `tmanage://` URL must resolve to the *same web route* the browser would open, on
 * the TManage origin and nowhere else. This module is the pure translation layer:
 * it never touches Electron, so it is unit-testable in a plain Node environment.
 *
 * ## Grammar
 *
 * A deep link carries only a path (plus optional query/hash) into the app:
 *
 *   tmanage://acme/projects/42        -> <origin>/acme/projects/42
 *   tmanage:///acme/home              -> <origin>/acme/home   (empty authority)
 *   tmanage://open/acme/inbox?tab=1   -> <origin>/open/acme/inbox?tab=1
 *
 * The authority segment is deliberately ignored rather than trusted: a hostile
 * `tmanage://evil.example.com/...` must not become a navigation to another origin.
 * We keep only `pathname + search + hash` and re-root it against the app origin,
 * then assert the result still lives on that origin before returning it.
 */

export const DEEP_LINK_PROTOCOL = 'tmanage';
const SCHEME_PREFIX = `${DEEP_LINK_PROTOCOL}://`;

/**
 * Translate a single `tmanage://` deep link into an absolute https/http URL on the
 * TManage origin, or `null` when the input is not a deep link we can safely route.
 *
 * `null` is returned for: a non-`tmanage:` scheme, an unparseable URL, or any result
 * that would escape the app origin (defence in depth — by construction it cannot,
 * but the check makes that a property, not a hope).
 */
export function resolveDeepLink(deepLink: string, appBaseUrl: string): string | null {
  if (typeof deepLink !== 'string') return null;
  const trimmed = deepLink.trim();
  // Case-insensitive scheme check; reject anything that is not exactly our protocol.
  if (!trimmed.toLowerCase().startsWith(SCHEME_PREFIX)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${DEEP_LINK_PROTOCOL}:`) return null;

  let base: URL;
  try {
    base = new URL(appBaseUrl);
  } catch {
    return null;
  }

  // `new URL('tmanage://acme/home')` parses `acme` as the host and `/home` as the path.
  // The host is a user-facing label, not an origin, so fold it back into the path:
  // the route the user means is `/acme/home`, not `/home`.
  const authority = parsed.host; // host:port form; empty for tmanage:///...
  const rawPath = parsed.pathname.startsWith('/') ? parsed.pathname : `/${parsed.pathname}`;
  const path = authority ? `/${authority}${rawPath === '/' ? '' : rawPath}` : rawPath;

  let target: URL;
  try {
    // Resolve the path-only string against the app origin. Because `path` always begins
    // with '/', the authority of `base` is preserved and the deep link cannot redirect
    // the window to a foreign origin.
    target = new URL(`${path}${parsed.search}${parsed.hash}`, base);
  } catch {
    return null;
  }

  if (target.origin !== base.origin) return null;
  return target.toString();
}

/**
 * Pick the first `tmanage://` argument out of a process/argv array.
 *
 * On Windows a deep link reaches an already-running instance as an extra element in
 * `app.requestSingleInstanceLock`'s `additionalData`/`argv`, and reaches a cold start
 * as a `process.argv` tail entry. Both are just string arrays, so one pure helper
 * serves both paths.
 */
export function findDeepLinkArg(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.toLowerCase().startsWith(SCHEME_PREFIX)) {
      return arg;
    }
  }
  return null;
}
