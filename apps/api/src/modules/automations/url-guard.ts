/**
 * SSRF / egress boundary for outbound webhook URLs — Automations module 17 (x166).
 *
 * A registered webhook is a URL the studio would one day have the server POST to. That makes the
 * registration surface an SSRF vector: a caller who could store `http://169.254.169.254/…` or
 * `https://localhost:6379/` would be asking the *server* to reach an address the caller cannot,
 * from inside the deployment's network. So the URL is judged at write time, here, and a URL this
 * function rejects is a 400 with no row written — a stored endpoint is always one already judged
 * safe to name.
 *
 * ## What this checks, and what it deliberately does not
 *
 * This is a **literal** guard: it parses the URL and inspects the scheme and the host as written.
 * It does not resolve DNS. A hostname that resolves to a private address at *delivery* time is a
 * TOCTOU problem a name-based write-time check cannot close — it is the delivery slice's job to
 * re-resolve and re-check at the moment it connects (Needs-Peter, with the egress/retry infra).
 * What this closes is the whole class an attacker controls directly: a non-https scheme, embedded
 * credentials, and any host written as an obviously-internal name or a private / loopback /
 * link-local / metadata IP literal.
 *
 * The rules, all of which reject:
 *
 * - **Not `https:`** — plaintext and non-HTTP schemes (`http`, `ftp`, `file`, `gopher`, …) are out.
 * - **Embedded credentials** — a `user:pass@host` URL is refused; a webhook target carries none.
 * - **An internal hostname** — `localhost`, any `*.localhost`, and mDNS `*.local`.
 * - **A private / loopback / link-local / CGNAT / metadata IP literal** — IPv4 and IPv6, including
 *   the cloud metadata address `169.254.169.254`, IPv4-mapped IPv6, and IPv6 ULA/link-local.
 */

/** The outcome of {@link checkWebhookUrl}: either the URL is allowed, or a reason it is not. */
export type UrlCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const ALLOW: UrlCheck = { ok: true };
function deny(reason: string): UrlCheck {
  return { ok: false, reason };
}

/** Parse an IPv4 literal to its four octets, or `null` if the string is not a dotted-quad. */
function parseIpv4(host: string): readonly number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Reject leading zeros / non-digits / out-of-range — a strict dotted-quad only.
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Whether an IPv4 address (as octets) is in a range that must never be a webhook target. */
function isBlockedIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

/**
 * Whether an IPv6 host (the bracketed literal's inner text) must never be a webhook target.
 * Covers `::`, `::1` loopback, `fc00::/7` unique-local, `fe80::/10` link-local, and IPv4-mapped
 * (`::ffff:a.b.c.d`) whose embedded IPv4 is itself blocked.
 */
function isBlockedIpv6(inner: string): boolean {
  const host = inner.toLowerCase();
  if (host === '::' || host === '::1') return true;
  // IPv4-mapped / IPv4-compatible: defer to the IPv4 rule on the trailing dotted-quad.
  const mapped = /(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mapped) {
    const v4 = parseIpv4(mapped[1] as string);
    if (v4 && isBlockedIpv4(v4)) return true;
  }
  const head = host.split(':', 1)[0] ?? '';
  if (
    head.startsWith('fe8') ||
    head.startsWith('fe9') ||
    head.startsWith('fea') ||
    head.startsWith('feb')
  ) {
    return true; // fe80::/10 link-local
  }
  if (head.startsWith('fc') || head.startsWith('fd')) return true; // fc00::/7 unique-local
  return false;
}

/**
 * Judge a candidate webhook URL. Returns `{ ok: true }` when the URL is a plausible public https
 * target, or `{ ok: false, reason }` naming the first rule it broke. The reason is for the API's
 * 400 detail; it names the class, never a resolved address.
 */
export function checkWebhookUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return deny('must be a valid absolute URL');
  }

  if (url.protocol !== 'https:') {
    return deny('must use https');
  }
  if (url.username !== '' || url.password !== '') {
    return deny('must not embed credentials');
  }

  // `URL.hostname` strips the brackets from an IPv6 literal; detect the bracket form from the href.
  const isBracketedV6 = url.href.includes(`[${url.hostname}]`) || raw.includes('[');
  const hostname = url.hostname.toLowerCase();
  if (hostname === '') {
    return deny('must name a host');
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    if (isBlockedIpv4(ipv4))
      return deny('must not point at a private, loopback or metadata address');
    return ALLOW;
  }

  if (hostname.includes(':') || isBracketedV6) {
    if (isBlockedIpv6(hostname)) {
      return deny('must not point at a private, loopback or metadata address');
    }
    return ALLOW;
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    return deny('must not point at an internal host');
  }

  return ALLOW;
}
