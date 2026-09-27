/**
 * IP / CIDR validation for the organization security settings (Administration module 18, x176).
 *
 * The IP allowlist is the security substance of this slice: a caller sets a list of network ranges,
 * and — in a later identity slice — a login from outside them is refused. That later enforcement is
 * only as safe as this validation is strict, so the boundary is here: every entry a PUT proposes must
 * be a syntactically valid IPv4/IPv6 address or CIDR block, and a malformed one (or too many) rejects
 * the whole write. Nothing partially valid is ever stored — an allowlist with one unparseable row is
 * a lockout waiting to happen, so the request fails as a unit with no write.
 *
 * This module is pure: no I/O, no tenant, no capability — just parsing and canonicalisation, unit
 * tested directly. The controller owns authorize/tenant/persistence and calls {@link validateIpAllowlist}.
 */

/** The most entries an allowlist may hold. A bound, so a single request cannot store an unbounded blob. */
export const MAX_IP_ALLOWLIST_ENTRIES = 50;

/** The success/failure result of validating a proposed allowlist. On success, the canonical entries. */
export type IpAllowlistValidation =
  | { readonly ok: true; readonly value: string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Validate a proposed IP allowlist. Returns the canonical, de-duplicated entries on success, or a
 * human-readable reason on the first failure. The input must be an array of strings; each entry must be
 * a valid IPv4/IPv6 address or CIDR block; and the list must not exceed {@link MAX_IP_ALLOWLIST_ENTRIES}.
 * Blank/whitespace-only entries are dropped (a trailing empty line in an editor is not an error), but a
 * non-empty entry that does not parse fails the whole list.
 */
export function validateIpAllowlist(input: unknown): IpAllowlistValidation {
  if (!Array.isArray(input)) {
    return { ok: false, message: 'The IP allowlist must be a list of addresses or CIDR ranges.' };
  }

  const seen = new Set<string>();
  const value: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') {
      return { ok: false, message: 'Every allowlist entry must be text.' };
    }
    const trimmed = raw.trim();
    if (trimmed === '') continue; // A blank line is dropped, not an error.
    const canonical = canonicaliseEntry(trimmed);
    if (canonical === null) {
      return {
        ok: false,
        message: `"${trimmed}" is not a valid IP address or CIDR range.`,
      };
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      value.push(canonical);
    }
  }

  if (value.length > MAX_IP_ALLOWLIST_ENTRIES) {
    return {
      ok: false,
      message: `An allowlist may have at most ${MAX_IP_ALLOWLIST_ENTRIES} entries.`,
    };
  }

  return { ok: true, value };
}

/**
 * The canonical form of one entry (an address or a `address/prefix` CIDR block), or `null` if it does
 * not parse. IPv6 is lower-cased; the prefix length is bounded by the family (0-32 for IPv4, 0-128 for
 * IPv6). This is not a normaliser of the host bits — `10.0.0.5/24` is accepted as written; it only
 * proves the entry is syntactically a valid address or range.
 */
export function canonicaliseEntry(entry: string): string | null {
  const slash = entry.indexOf('/');
  if (slash === -1) {
    const family = addressFamily(entry);
    if (family === null) return null;
    return family === 6 ? entry.toLowerCase() : entry;
  }

  const address = entry.slice(0, slash);
  const prefixText = entry.slice(slash + 1);
  const family = addressFamily(address);
  if (family === null) return null;
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  const max = family === 4 ? 32 : 128;
  if (prefix > max) return null;
  const canonicalAddress = family === 6 ? address.toLowerCase() : address;
  return `${canonicalAddress}/${prefix}`;
}

/** The family of a bare address (`4` or `6`), or `null` if it is neither. */
function addressFamily(address: string): 4 | 6 | null {
  if (isIpv4(address)) return 4;
  if (isIpv6(address)) return 6;
  return null;
}

/** A dotted-quad IPv4 address: four octets 0-255, no leading zeros (so `01.1.1.1` is rejected). */
export function isIpv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part[0] === '0') return false; // No leading zeros.
    if (Number(part) > 255) return false;
  }
  return true;
}

/**
 * An IPv6 address, including the `::` zero-run compression and a trailing embedded IPv4 (`::ffff:1.2.3.4`).
 * A single `::` may appear once; without it there must be exactly eight hextet groups; with it, fewer
 * than eight (the `::` fills the gap). An embedded IPv4 tail counts as two groups.
 */
export function isIpv6(address: string): boolean {
  if (address.length === 0) return false;
  const doubleColon = address.indexOf('::');
  if (doubleColon !== address.lastIndexOf('::')) return false; // At most one `::`.

  if (doubleColon === -1) {
    return groupsValid(address.split(':'), true);
  }

  const head = address.slice(0, doubleColon);
  const tail = address.slice(doubleColon + 2);
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  if (!groupsValid(headGroups, false) || !groupsValid(tailGroups, false)) return false;

  // The `::` must actually compress at least one group: head + tail must be fewer than eight.
  const tailCount =
    tailGroups.length > 0 && isIpv4(tailGroups[tailGroups.length - 1]!)
      ? tailGroups.length + 1
      : tailGroups.length;
  const headCount =
    headGroups.length > 0 && isIpv4(headGroups[headGroups.length - 1]!)
      ? headGroups.length + 1
      : headGroups.length;
  return headCount + tailCount < 8;
}

/**
 * Validate a run of `:`-separated IPv6 groups. Each must be 1-4 hex digits, except the last, which may
 * instead be an embedded IPv4 (counting as two groups). When `full`, the run must total exactly eight
 * groups (no `::` was present).
 */
function groupsValid(groups: readonly string[], full: boolean): boolean {
  if (groups.length === 0) return !full;
  let count = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i]!;
    const isLast = i === groups.length - 1;
    if (isLast && group.includes('.')) {
      if (!isIpv4(group)) return false;
      count += 2;
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false;
    count += 1;
  }
  return full ? count === 8 : count <= 8;
}
