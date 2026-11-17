/**
 * UUIDv7 — the identifier policy for every tenant-owned table
 * (`23-ERD-AND-STATE-MACHINES.md` §3).
 *
 * ## Why v7 rather than v4
 *
 * v7 embeds a big-endian millisecond timestamp in its leading 48 bits, so identifiers sort
 * chronologically. For a table with a `(organization_id, created_at)` access pattern this
 * keeps B-tree inserts near the right edge of the index instead of scattering them, which
 * matters once a tenant's work-item table is large.
 *
 * ## Why this is still safe to expose
 *
 * The timestamp is not secret — it is the row's creation time, which the API returns anyway.
 * The remaining 74 bits are cryptographically random, so identifiers stay unguessable and
 * direct-ID enumeration (`25-AUTH-AND-TENANT-ISOLATION` §11) remains infeasible. Unguessability is
 * defence in depth regardless: every read is tenant-scoped and authorized, so knowing an
 * id does not grant access to it.
 *
 * ## Layout (RFC 9562 §5.7)
 *
 * ```
 *  0                   1                   2                   3
 *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |                        unix_ts_ms (48 bits)                   |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |          unix_ts_ms           |  ver  |      rand_a (12)      |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |var|                       rand_b (62 bits)                    |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * ```
 */

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

/** Reused across calls to avoid an allocation per id. Never read before being written. */
const scratch = new Uint8Array(16);

/**
 * Generate a UUIDv7.
 *
 * `timestampMs` is injectable purely so tests can assert monotonicity and layout against a
 * fixed clock. Production callers omit it.
 */
export function uuidv7(timestampMs: number = Date.now()): string {
  if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs > 0xff_ff_ff_ff_ff_ff) {
    throw new RangeError('uuidv7: timestampMs must be an integer within 48 unsigned bits');
  }

  // 74 random bits are needed; fill all 16 bytes and overwrite the structured ones.
  // Web Crypto (a CSPRNG in Node 22 and every browser) rather than `node:crypto`: this module is
  // in the package index, which browser bundles import (see client-safe-entry.test.ts).
  globalThis.crypto.getRandomValues(scratch);

  // Bytes 0-5: big-endian 48-bit millisecond timestamp.
  // `Math.floor(ms / 2**32)` keeps the high 16 bits outside 32-bit bitwise operators,
  // which would otherwise truncate silently.
  const high = Math.floor(timestampMs / 0x1_00_00_00_00);
  const low = timestampMs >>> 0;
  scratch[0] = (high >>> 8) & 0xff;
  scratch[1] = high & 0xff;
  scratch[2] = (low >>> 24) & 0xff;
  scratch[3] = (low >>> 16) & 0xff;
  scratch[4] = (low >>> 8) & 0xff;
  scratch[5] = low & 0xff;

  // Byte 6 high nibble: version 7. Low nibble stays random (rand_a).
  scratch[6] = ((scratch[6] as number) & 0x0f) | 0x70;
  // Byte 8 top two bits: RFC 9562 variant `10`. Remaining 62 bits stay random (rand_b).
  scratch[8] = ((scratch[8] as number) & 0x3f) | 0x80;

  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out += HEX[scratch[i] as number];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Any well-formed UUID, regardless of version. Use for values that arrive from the wire. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Specifically a v7 UUID with the correct variant bits. */
export function isUuidV7(value: string): boolean {
  if (!UUID_RE.test(value)) return false;
  if (value[14] !== '7') return false;
  const variant = value[19]?.toLowerCase() ?? '';
  return variant === '8' || variant === '9' || variant === 'a' || variant === 'b';
}

/** Recover the creation timestamp embedded in a v7 UUID. */
export function timestampFromUuidV7(value: string): Date {
  if (!isUuidV7(value)) throw new TypeError('not a UUIDv7');
  const hex = value.slice(0, 8) + value.slice(9, 13);
  return new Date(Number.parseInt(hex, 16));
}
