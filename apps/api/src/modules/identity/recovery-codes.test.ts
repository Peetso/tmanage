import { describe, expect, it } from 'vitest';
import {
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  findRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
} from './recovery-codes.js';

describe('generation', () => {
  it('produces ten codes and ten hashes, in the same order', () => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(hashes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const [index, code] of codes.entries()) {
      expect(hashes[index]).toBe(hashRecoveryCode(code));
    }
  });

  it('formats each code as two groups of five', () => {
    for (const code of generateRecoveryCodes().codes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    }
  });

  /**
   * The four characters Crockford drops are the ones that are misread off a screen or a
   * printout. If they can never appear in a code, the normaliser is free to map them onto
   * what they are mistaken for without any risk of collision.
   */
  it('never emits I, L, O or U', () => {
    const many = Array.from({ length: 40 }, () => generateRecoveryCodes().codes).flat();
    expect(many.join('')).not.toMatch(/[ILOU]/);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateRecoveryCodes().codes).flat());
    expect(seen.size).toBe(20 * RECOVERY_CODE_COUNT);
  });

  it('stores a SHA-256 hex digest, never the code', () => {
    const { codes, hashes } = generateRecoveryCodes();
    for (const [index, hash] of hashes.entries()) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).not.toContain(codes[index]!.replace('-', ''));
    }
  });

  it('honours a different count when asked', () => {
    expect(generateRecoveryCodes(3).codes).toHaveLength(3);
  });
});

describe('matching', () => {
  it('finds the index of the code that was presented', () => {
    const { codes, hashes } = generateRecoveryCodes();
    for (const [index, code] of codes.entries()) {
      expect(findRecoveryCode(code, hashes)).toBe(index);
    }
  });

  it('returns undefined for a code from another set', () => {
    const { hashes } = generateRecoveryCodes();
    const stranger = generateRecoveryCodes().codes[0]!;
    expect(findRecoveryCode(stranger, hashes)).toBeUndefined();
  });

  it('returns undefined against an empty set', () => {
    const code = generateRecoveryCodes().codes[0]!;
    expect(findRecoveryCode(code, [])).toBeUndefined();
  });

  it.each([
    ['lowercased', (code: string) => code.toLowerCase()],
    ['without its hyphen', (code: string) => code.replace('-', '')],
    ['with spaces instead', (code: string) => code.replace('-', ' ')],
    ['with surrounding whitespace', (code: string) => `  ${code}  `],
    ['pasted with a line break', (code: string) => `${code}\n`],
  ])('accepts a code %s', (_name, mangle) => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(findRecoveryCode(mangle(codes[3]!), hashes)).toBe(3);
  });

  /**
   * The confusable mapping. `1` can never be typed as `I` in a real code because `I` is not
   * in the alphabet, so folding `I` to `1` cannot turn one valid code into another.
   */
  it('forgives the characters people misread', () => {
    const { codes, hashes } = generateRecoveryCodes();
    const code = codes[0]!;
    const misread = code.replace(/1/g, 'I').replace(/0/g, 'O');
    expect(findRecoveryCode(misread, hashes)).toBe(0);
  });

  it.each(['', 'short', 'a'.repeat(RECOVERY_CODE_LENGTH + 1), '12345-678901'])(
    'refuses %o on length before hashing anything',
    (bad) => {
      const { hashes } = generateRecoveryCodes();
      expect(findRecoveryCode(bad, hashes)).toBeUndefined();
    },
  );

  /**
   * Single use is enforced by the caller marking the returned index, so the important
   * property here is that the index identifies exactly one code — a set where a match could
   * not be attributed to one row could not be marked used.
   */
  it('identifies exactly one code, so it can be marked used', () => {
    const { codes, hashes } = generateRecoveryCodes();
    const matches = codes.map((code) => findRecoveryCode(code, hashes));
    expect(new Set(matches).size).toBe(RECOVERY_CODE_COUNT);
  });

  it('still finds the remaining codes when a used one is removed from the set', () => {
    const { codes, hashes } = generateRecoveryCodes();
    const remaining = hashes.filter((_hash, index) => index !== 4);
    expect(findRecoveryCode(codes[4]!, remaining)).toBeUndefined();
    expect(findRecoveryCode(codes[5]!, remaining)).toBe(4);
  });
});

describe('hashing', () => {
  it('is stable across every accepted spelling of the same code', () => {
    const code = generateRecoveryCodes().codes[0]!;
    const canonical = hashRecoveryCode(code);
    expect(hashRecoveryCode(code.toLowerCase())).toBe(canonical);
    expect(hashRecoveryCode(code.replace('-', ''))).toBe(canonical);
    expect(hashRecoveryCode(` ${code} `)).toBe(canonical);
  });

  it('differs for two different codes', () => {
    const { codes } = generateRecoveryCodes();
    expect(hashRecoveryCode(codes[0]!)).not.toBe(hashRecoveryCode(codes[1]!));
  });
});
