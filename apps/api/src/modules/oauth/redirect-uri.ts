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
