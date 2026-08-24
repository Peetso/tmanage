import { describe, expect, it } from 'vitest';
import { isUuid, isUuidV7, timestampFromUuidV7, uuidv7 } from './uuid-v7.js';
import {
  abbreviateContentHash,
  assertContentHash,
  contentHashEquals,
  isContentHash,
} from './content-hash.js';

describe('uuidv7', () => {
  it('produces well-formed v7 UUIDs', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = uuidv7();
      expect(isUuid(id)).toBe(true);
      expect(isUuidV7(id)).toBe(true);
    }
  });

  it('embeds the supplied timestamp recoverably', () => {
    const when = Date.UTC(2026, 7, 16, 10, 30, 0);

    expect(timestampFromUuidV7(uuidv7(when)).getTime()).toBe(when);
  });

  it('sorts lexicographically in creation order, which is the point of v7', () => {
    const early = uuidv7(Date.UTC(2026, 0, 1));
    const mid = uuidv7(Date.UTC(2026, 5, 1));
    const late = uuidv7(Date.UTC(2026, 11, 31));

    expect([late, early, mid].sort()).toEqual([early, mid, late]);
  });

  it('handles a timestamp above 2^32 ms without truncating the high bits', () => {
    // ~2038 and beyond exceed 32 bits; a naive `>>>` implementation silently wraps here.
    const far = Date.UTC(2098, 0, 1);

    expect(timestampFromUuidV7(uuidv7(far)).getTime()).toBe(far);
  });

  it('does not collide within a single millisecond', () => {
    const fixed = Date.UTC(2026, 7, 16);
    const ids = new Set(Array.from({ length: 5_000 }, () => uuidv7(fixed)));

    expect(ids.size).toBe(5_000);
  });

  it('rejects an out-of-range timestamp rather than emitting a malformed id', () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError);
    expect(() => uuidv7(1.5)).toThrow(RangeError);
  });

  it('rejects a v4 UUID as v7 while still accepting it as a UUID', () => {
    const v4 = '9b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d';

    expect(isUuid(v4)).toBe(true);
    expect(isUuidV7(v4)).toBe(false);
  });
});

describe('content hash', () => {
  const hash = 'a'.repeat(64);

  it('accepts only a lowercase hex SHA-256 digest', () => {
    expect(isContentHash(hash)).toBe(true);
    expect(isContentHash('A'.repeat(64))).toBe(false);
    expect(isContentHash('a'.repeat(63))).toBe(false);
    expect(isContentHash('z'.repeat(64))).toBe(false);
  });

  it('throws on an invalid digest rather than letting it reach an approval record', () => {
    expect(() => assertContentHash('deadbeef')).toThrow(TypeError);
  });

  it('compares full digests, not prefixes', () => {
    const other = `${'a'.repeat(63)}b`;

    expect(contentHashEquals(hash, hash)).toBe(true);
    expect(contentHashEquals(hash, other)).toBe(false);
    // A truncated form must never compare equal to the full digest.
    expect(contentHashEquals(hash, hash.slice(0, 8))).toBe(false);
  });

  it('renders the abbreviated display form used by the design system', () => {
    const seeded = assertContentHash(`8f2c${'0'.repeat(56)}d41a`);

    expect(abbreviateContentHash(seeded)).toBe('8f2c·d41a');
  });
});
