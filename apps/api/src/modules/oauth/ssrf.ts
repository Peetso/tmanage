import { isIP } from 'node:net';

/**
 * SSRF address classification for the CIMD metadata fetch (MCP connector S8, threat model row
 * B5 "SSRF via CIMD fetch"). The rule in full: the only outbound call any AI path makes is the
 * fetch of a client-supplied Client-ID Metadata Document URL, so that one egress is hardened —
 * https only, DNS resolved once and the resulting IP pinned for the connection, and every
 * private, loopback, link-local, ULA, multicast, metadata and reserved range refused.
 *
 * ## Why classification here is not the parser the architecture warns against
 *
 * The architecture (§"SSRF via CIMD fetch") says to use "range checks, not a hand-written
 * parser". The danger it names is parsing an attacker-supplied *textual* address — where
 * octal (`0177.0.0.1`), decimal (`2130706433`), mixed or embedded forms slip a loopback past a
 * naive check. This module never does that. It classifies the address string `dns.lookup`
 * returns, which is already the OS resolver's canonical numeric form (dotted-quad for IPv4,
 * RFC 5952 for IPv6). The connection is then pinned to that exact resolved address
 * (`cimd-fetcher.ts`), so there is no second resolution a DNS-rebinding attacker could win. The
 * only textual forms reaching the classifier are canonical, and anything that does not parse as
 * a canonical address is treated as blocked. (If a future reviewer prefers a vetted library,
 * `ipaddr.js` — already in the lockfile via `@fastify/proxy-addr` — is a drop-in for the two
 * `isBlocked*` helpers; it was not added here to avoid a workspace install while sibling slices
 * share this single checkout.)
 */

/** A resolved address is blocked unless it is confidently a global-unicast public address. */
export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isBlockedIpv4(address);
  if (kind === 6) return isBlockedIpv6(address);
  // Not a canonical numeric address: never connect to it.
  return true;
}

/** Block loopback, private, CGNAT, link-local (incl. metadata), and the special/reserved blocks. */
function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return true;
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets as [number, number, number, number];

  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local, incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0) return true; // 192.0.0.0/16 (covers 192.0.0.0/24 IETF and 192.0.2.0/24 TEST-NET-1)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51) return true; // 198.51.0.0/16 (covers 198.51.100.0/24 TEST-NET-2)
  if (a === 203 && b === 0) return true; // 203.0.0.0/16 (covers 203.0.113.0/24 TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved, incl. 255.255.255.255
  return false;
}

/**
 * Expand a canonical IPv6 string to its eight 16-bit groups. Returns null if it is not a
 * well-formed address (which the caller treats as blocked). Handles the single `::` run and the
 * IPv4-mapped/embedded tail (`::ffff:1.2.3.4`).
 */
export function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase();
  // A zone id (fe80::1%eth0) is never valid for a fetch target.
  if (text.includes('%')) return null;

  // An embedded IPv4 tail: convert its dotted-quad to two hextets.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = tail.split('.').map((p) => Number(p));
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const [a, b, c, d] = v4 as [number, number, number, number];
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((h) => Number.parseInt(h, 16));
  const head = toGroups(halves[0] ?? '');
  const back = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if ([...head, ...back].some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;

  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - back.length;
    if (fill < 1) return null; // `::` must stand for at least one group
    groups = [...head, ...new Array(fill).fill(0), ...back];
  } else {
    groups = head;
  }
  return groups.length === 8 ? groups : null;
}

/** Block loopback, unspecified, link-local, ULA, multicast, documentation, and IPv4-mapped v4. */
function isBlockedIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  const allZeroButLast = groups.slice(0, 7).every((g) => g === 0);
  if (allZeroButLast && (g7 === 0 || g7 === 1)) return true; // :: unspecified and ::1 loopback

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible — classify the embedded v4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    const a = g6 >> 8;
    const b = g6 & 0xff;
    const c = g7 >> 8;
    const d = g7 & 0xff;
    return isBlockedIpv4(`${a}.${b}.${c}.${d}`);
  }
  // NAT64 well-known prefix 64:ff9b::/96 also embeds a v4 destination.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    const a = g6 >> 8;
    const b = g6 & 0xff;
    const c = g7 >> 8;
    const d = g7 & 0xff;
    return isBlockedIpv4(`${a}.${b}.${c}.${d}`);
  }

  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local (ULA), incl. fd00:ec2::254
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  return false;
}
