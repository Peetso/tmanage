import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { leadingZeroBits, searchPow, sha256, solvePow } from '../src/lib/public-form-pow';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const nodeSha = (text: string) => createHash('sha256').update(text, 'utf8').digest();

describe('public form proof-of-work (browser half)', () => {
  it('hashes exactly like node:crypto, across block boundaries', () => {
    for (const text of ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'salt:1a2b']) {
      expect(hex(sha256(new TextEncoder().encode(text)))).toBe(nodeSha(text).toString('hex'));
    }
  });

  it('finds a solution the server-side check accepts', async () => {
    const salt = 'test-salt_ABC';
    const bits = 12;
    const solution = await solvePow(salt, bits, { batch: 5_000 });
    expect(solution).not.toBeNull();
    expect(leadingZeroBits(nodeSha(`${salt}:${solution}`))).toBeGreaterThanOrEqual(bits);
    // Same candidate order as the API's reference solver: the first hit in a plain search.
    expect(searchPow(salt, bits, 0, 1_000_000)).toBe(solution);
  });
});
