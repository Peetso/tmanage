/**
 * SEC-ALERTS item 7 — IP address ranges as fixed-width keys, shared by the worker (which parses
 * the downloaded block lists and stores ranges) and the API (which looks an address up). Pure
 * (AR-1, DM-1): no I/O, no `node:` import; one home for the parsing rule (AR-8).
 *
 * Every address is a 128-bit number; IPv4 is mapped into `::ffff:0:0/96` (RFC 4291 §2.5.5.2), so
 * one sorted table holds both families. A key is the 32-character lower-case hex of that number:
 * fixed width, so string order equals numeric order and a range test is two string comparisons.
 */

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;
const V4_MAPPED_PREFIX = 0xffffn << 32n;

function v4ToBig(ip: string): bigint | null {
  const m = V4.exec(ip);
  if (m === null) return null;
  let n = 0n;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    n = (n << 8n) | BigInt(octet);
  }
  return n;
}

function v6ToBig(ip: string): bigint | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  let tail: bigint | null = null;
  const lastColon = text.lastIndexOf(':');
  if (text.slice(lastColon + 1).includes('.')) {
    tail = v4ToBig(text.slice(lastColon + 1));
    if (tail === null) return null;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const rest = halves.length === 2 && halves[1] !== '' ? (halves[1] ?? '').split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array.from({ length: fill }, () => '0'), ...rest];
  if (all.length !== 8) return null;
  let n = 0n;
  for (const group of all) {
    if (!/^[0-9a-f]{1,4}$/u.test(group)) return null;
    n = (n << 16n) | BigInt(parseInt(group, 16));
  }
  if (tail !== null) n = (n & ~0xffffffffn) | tail;
  return n;
}

/** The 128-bit number of an address (IPv4 mapped), or null when it is not an address. */
export function ipToBigInt(raw: string): bigint | null {
  const ip = raw.trim();
  if (ip === '') return null;
  const v4 = v4ToBig(ip);
  if (v4 !== null) return V4_MAPPED_PREFIX | v4;
  return ip.includes(':') ? v6ToBig(ip) : null;
}

export function ipRangeKey(n: bigint): string {
  return n.toString(16).padStart(32, '0');
}

/** The key of an address, or null. */
export function ipKey(raw: string): string | null {
  const n = ipToBigInt(raw);
  return n === null ? null : ipRangeKey(n);
}

export interface IpRange {
  readonly start: string;
  readonly end: string;
}

/**
 * One list line as a range: a CIDR (`1.2.3.0/24`, `2001:db8::/32`) or a single address. Comments
 * (`#`, `;`) and blank lines are null, and so is anything that is not an address.
 */
export function parseIpRange(line: string): IpRange | null {
  const text = line.split(/[#;]/u)[0]?.trim() ?? '';
  if (text === '') return null;
  const [address = '', prefixText] = text.split('/');
  const n = ipToBigInt(address);
  if (n === null) return null;
  const width = v4ToBig(address.trim()) !== null ? 32 : 128;
  const bits = prefixText === undefined ? width : Number(prefixText);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;
  const mask = (1n << BigInt(width - bits)) - 1n;
  const start = n & ~mask;
  return { start: ipRangeKey(start), end: ipRangeKey(start | mask) };
}

/**
 * Whether two ranges share at least one address (the sign-in door's block / allowlist / label
 * overlap checks). Keys are fixed width, so string order is numeric order.
 */
export function rangesOverlap(a: IpRange, b: IpRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** An address or CIDR an admin typed, in its one stored spelling (SEC-TRACKER, 0406). */
export interface CidrValue {
  /** `203.0.113.7/32`, `203.0.113.0/24`, `2001:db8::/48` (IPv6 lower-cased as typed). */
  readonly value: string;
  readonly range: IpRange;
  readonly family: 4 | 6;
  /** The prefix length (32 or 128 for a single address). */
  readonly bits: number;
  /** The network address as text, for a lookup by address. */
  readonly address: string;
}

/**
 * An address or CIDR as a platform admin types it, or null. A bare address becomes a /32 or /128.
 * The host bits must be zero (`203.0.113.7/24` is refused: the admin meant either the address or
 * `203.0.113.0/24`, and storing a guess would block a range nobody chose). One parse for the block
 * list (identity) and the source labels (security-signals), so both read a value the same way.
 */
export function parseCidrValue(raw: string): CidrValue | null {
  const text = raw.trim().toLowerCase();
  if (text === '' || text.length > 64 || /[#;\s]/u.test(text)) return null;
  const [address = '', prefixText, extra] = text.split('/');
  if (extra !== undefined) return null;
  if (prefixText !== undefined && !/^\d{1,3}$/u.test(prefixText)) return null;
  const n = ipToBigInt(address);
  if (n === null) return null;
  const family = v4ToBig(address) !== null ? 4 : 6;
  const width = family === 4 ? 32 : 128;
  const bits = prefixText === undefined ? width : Number(prefixText);
  if (bits > width) return null;
  const range = parseIpRange(`${address}/${String(bits)}`);
  if (range === null || range.start !== ipRangeKey(n)) return null;
  const canonical =
    family === 4
      ? address
          .split('.')
          .map((octet) => String(Number(octet)))
          .join('.')
      : address;
  return { value: `${canonical}/${String(bits)}`, range, family, bits, address: canonical };
}

/** An IPv4 numeric range (decimal `ip_from`, `ip_to`, the IP2Proxy CSV form) as a mapped range. */
export function ipV4NumericRange(from: string, to: string): IpRange | null {
  if (!/^\d{1,10}$/u.test(from) || !/^\d{1,10}$/u.test(to)) return null;
  const a = BigInt(from);
  const b = BigInt(to);
  if (a > 0xffffffffn || b > 0xffffffffn || a > b) return null;
  return { start: ipRangeKey(V4_MAPPED_PREFIX | a), end: ipRangeKey(V4_MAPPED_PREFIX | b) };
}

/**
 * A sorted, merged set of ranges with an O(log n) lookup. Built once per list version; overlaps
 * are merged at build time, so a lookup is one binary search and one comparison.
 */
export class IpRangeSet {
  private readonly starts: string[] = [];
  private readonly ends: string[] = [];

  constructor(ranges: Iterable<IpRange>) {
    const sorted = [...ranges].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    for (const range of sorted) {
      const last = this.ends.length - 1;
      const lastEnd = this.ends[last];
      if (lastEnd !== undefined && range.start <= lastEnd) {
        if (range.end > lastEnd) this.ends[last] = range.end;
        continue;
      }
      this.starts.push(range.start);
      this.ends.push(range.end);
    }
  }

  get size(): number {
    return this.starts.length;
  }

  hasKey(key: string): boolean {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.starts[mid] ?? '') <= key) lo = mid + 1;
      else hi = mid - 1;
    }
    const end = this.ends[hi];
    return end !== undefined && key <= end;
  }

  has(ip: string): boolean {
    const key = ipKey(ip);
    return key !== null && this.hasKey(key);
  }
}
