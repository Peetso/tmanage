/**
 * Redirect-URI validation — MCP-CONNECTOR-ARCHITECTURE §4.1 and threat model row B1 ("Open
 * redirect, redirect-URI attack"). The rules, in full:
 *
 * - **Exact string match** against the client's registered or CIMD-published `redirect_uris`.
 *   No wildcards, no prefix match, no extra path segment.
 * - **https only**, with one exception: loopback `http://localhost` and `http://127.0.0.1`,
 *   which may differ only in port from a registered loopback URI (Claude Code, Cursor desktop
 *   bind an ephemeral port). Loopback matching is scheme + host + path, any port.
 * - **No fragment** ever (RFC 6749 §3.1.2).
 * - An invalid `client_id` or a redirect that matches nothing means **no redirect at all** — the
 *   caller shows an error page rather than bouncing the browser somewhere unverified.
 *
 * S7 implements the exact-match and loopback rules the authorize endpoint and its conformance
 * tests (T-OA-03) depend on. S8 layers the DCR/CIMD registration of those URIs on top.
 */

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

interface ParsedRedirect {
  readonly scheme: string;
  readonly host: string;
  readonly path: string;
  readonly isLoopback: boolean;
}

function parse(uri: string): ParsedRedirect | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  // A fragment is never permitted in a redirect URI, registered or requested.
  if (url.hash !== '') return null;
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const host = url.hostname.toLowerCase();
  return { scheme, host, path: url.pathname, isLoopback: LOOPBACK_HOSTS.has(host) };
}

/** Is this a redirect scheme TManage will ever accept? https always; http only for loopback. */
export function isAllowedRedirectScheme(uri: string): boolean {
  const parsed = parse(uri);
  if (!parsed) return false;
  if (parsed.scheme === 'https') return true;
  return parsed.scheme === 'http' && parsed.isLoopback;
}

/**
 * Does `requested` match one of the client's `registered` redirect URIs?
 *
 * For a non-loopback URI this is exact string equality. For a loopback URI the port is allowed to
 * differ (and only the port): scheme, host and path must still match a registered loopback URI.
 * A requested URI with a disallowed scheme or a fragment matches nothing.
 */
export function matchesRegisteredRedirect(
  requested: string,
  registered: readonly string[],
): boolean {
  if (!isAllowedRedirectScheme(requested)) return false;
  // Exact match covers every https case and an identical loopback URI.
  if (registered.includes(requested)) return true;

  const req = parse(requested);
  if (!req || !req.isLoopback || req.scheme !== 'http') return false;
  // Loopback: same scheme, host and path, any port.
  return registered.some((candidate) => {
    const reg = parse(candidate);
    return (
      reg !== null &&
      reg.isLoopback &&
      reg.scheme === 'http' &&
      reg.host === req.host &&
      reg.path === req.path
    );
  });
}

/** Thrown when a client registers redirect URIs that break the rules above (S8, T-DCR-01). */
export class InvalidRedirectUrisError extends Error {
  override name = 'InvalidRedirectUrisError';
}

/** The most redirect URIs one client may register — a generous cap that still bounds a row. */
export const MAX_REDIRECT_URIS = 10;

/**
 * Validate the `redirect_uris` a client supplies at registration (DCR body, or a CIMD document's
 * `redirect_uris`). The set is the exact allow-list the authorize endpoint will later match
 * against, so it is checked to the same standard here: a non-empty array of strings, each an
 * absolute URI with an allowed scheme (https, or http only for loopback) and no fragment. A
 * `javascript:`, `data:`, http-non-loopback or fragment-bearing URI is rejected outright — never
 * silently dropped, so a client cannot believe a bad URI was accepted. Returns the de-duplicated
 * list in input order.
 */
export function validateRegistrationRedirectUris(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new InvalidRedirectUrisError('redirect_uris must be a non-empty array.');
  }
  if (raw.length > MAX_REDIRECT_URIS) {
    throw new InvalidRedirectUrisError(`At most ${MAX_REDIRECT_URIS} redirect_uris are allowed.`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry === '') {
      throw new InvalidRedirectUrisError('Each redirect_uri must be a non-empty string.');
    }
    if (!isAllowedRedirectScheme(entry)) {
      throw new InvalidRedirectUrisError(
        `redirect_uri is not an https URI (or a loopback http URI) without a fragment: ${entry}`,
      );
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}
