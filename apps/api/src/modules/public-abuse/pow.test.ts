import { describe, expect, it } from 'vitest';
import {
  POW_DEFAULT_BITS,
  POW_MAX_BITS,
  adaptiveDifficulty,
  leadingZeroBits,
  powSalt,
  solvePow,
  verifyPow,
} from './pow.js';

/** UNIT-52-25 — proof-of-work: a solution verifies at its difficulty and not above. */

describe('proof-of-work', () => {
  it('verifies a found solution with one hash and refuses rubbish', () => {
    const salt = powSalt('secret', '01890000-0000-7000-8000-000000000001');
    const solution = solvePow(salt, 12);
    expect(solution).not.toBeNull();
    expect(verifyPow(salt, solution, 12)).toBe(true);
    expect(verifyPow(salt, 'not a solution!', 12)).toBe(false);
    expect(verifyPow(salt, 42, 12)).toBe(false);
    // Another challenge's salt does not accept it.
    expect(verifyPow(powSalt('secret', 'another'), solution, 12)).toBe(false);
  });

  it('counts leading zero bits', () => {
    expect(leadingZeroBits(Buffer.from([0x00, 0x0f, 0xff]))).toBe(12);
    expect(leadingZeroBits(Buffer.from([0x80]))).toBe(0);
  });

  it('raises difficulty under load and caps it', () => {
    expect(adaptiveDifficulty(10)).toBe(POW_DEFAULT_BITS);
    expect(adaptiveDifficulty(60)).toBe(POW_DEFAULT_BITS + 1);
    expect(adaptiveDifficulty(1_000_000)).toBe(POW_MAX_BITS);
  });
});
