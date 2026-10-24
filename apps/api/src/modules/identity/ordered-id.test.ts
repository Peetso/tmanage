import { describe, expect, it } from 'vitest';
import { isUuidV7 } from '@tmanage/domain';
import { orderedUuidv7 } from './ordered-id.js';

describe('orderedUuidv7', () => {
  /**
   * The id-002 flake: `mfa_factor_enrolled` and `recovery_codes_issued` are written in the
   * same millisecond, and plain v7 ids then tie-break by chance. A burst this size lands
   * many ids in each millisecond, so a random tail would fail this nearly every run.
   */
  it('sorts in the order it was called, even within one millisecond', () => {
    const ids = Array.from({ length: 5_000 }, () => orderedUuidv7());

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('still emits well-formed v7 ids', () => {
    for (let i = 0; i < 500; i += 1) expect(isUuidV7(orderedUuidv7())).toBe(true);
  });
});
