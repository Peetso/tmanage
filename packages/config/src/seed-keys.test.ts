import { describe, expect, it } from 'vitest';
import { parseSeedKeys } from './seed-keys.js';

/**
 * Obviously fake keys: a byte repeated thirty-two times. A reader can tell at a glance that
 * nothing here is a real key, and the decoded bytes are checkable by eye.
 */
const key = (fill: number): string => Buffer.alloc(32, fill).toString('base64url');

describe('parseSeedKeys', () => {
  it('parses a single entry into its active key', () => {
    const keyring = parseSeedKeys(`1:${key(0x11)}`);

    expect(keyring.active.version).toBe(1);
    expect(keyring.active.key).toEqual(Buffer.alloc(32, 0x11));
    expect([...keyring.byVersion.keys()]).toEqual([1]);
  });

  /**
   * The active key is the highest version, not the last one written. An operator adding a new
   * key to the front of the list must not silently keep encrypting under the old one.
   */
  it('picks the highest version as active regardless of order', () => {
    const keyring = parseSeedKeys(`3:${key(0x33)};1:${key(0x11)};2:${key(0x22)}`);

    expect(keyring.active.version).toBe(3);
    expect(keyring.active.key).toEqual(Buffer.alloc(32, 0x33));
    expect([...keyring.byVersion.keys()].sort()).toEqual([1, 2, 3]);
  });

  it('keeps every non-active key for decryption', () => {
    const keyring = parseSeedKeys(`1:${key(0x11)};2:${key(0x22)}`);

    expect(keyring.byVersion.get(1)).toEqual(Buffer.alloc(32, 0x11));
    expect(keyring.byVersion.get(2)).toEqual(Buffer.alloc(32, 0x22));
  });

  it('tolerates whitespace around entries, which an .env file introduces easily', () => {
    const keyring = parseSeedKeys(`  1:${key(0x11)} ; 2:${key(0x22)}  `);

    expect(keyring.active.version).toBe(2);
    expect(keyring.byVersion.size).toBe(2);
  });

  it.each([
    ['an empty value', ''],
    ['whitespace only', '   '],
  ])('refuses %s: there is no key to encrypt under', (_label, raw) => {
    expect(() => parseSeedKeys(raw)).toThrow(/at least one/i);
  });

  it('refuses an empty entry rather than skipping it, so a stray ";" is reported', () => {
    expect(() => parseSeedKeys(`1:${key(0x11)};`)).toThrow(/empty/i);
  });

  /**
   * The same stray separator at the other end. `split` produces the empty entry first here,
   * so this exercises the guard on the first iteration rather than the last — a parser that
   * only skipped blanks at the end of the list would pass the trailing case and fail this.
   */
  it('refuses a leading ";" as well as a trailing one', () => {
    expect(() => parseSeedKeys(`;1:${key(0x11)}`)).toThrow(/empty/i);
  });

  it('refuses an entry with no version separator', () => {
    expect(() => parseSeedKeys(key(0x11))).toThrow(/<version>:<key>/);
  });

  /**
   * Leading zeros are refused rather than trimmed: a version has one spelling, so `01` and
   * `1` cannot both be written for the same key and leave the duplicate check unable to see
   * them as the same version.
   */
  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['not a number', 'v1'],
    ['leading-zero', '01'],
    ['zero-padded', '007'],
  ])('refuses a %s version', (_label, version) => {
    expect(() => parseSeedKeys(`${version}:${key(0x11)}`)).toThrow(/positive integer/i);
  });

  it('refuses duplicate versions: one version must name one key', () => {
    expect(() => parseSeedKeys(`1:${key(0x11)};1:${key(0x22)}`)).toThrow(/duplicate/i);
  });

  it.each([
    ['31 bytes', Buffer.alloc(31, 0x11).toString('base64url')],
    ['33 bytes', Buffer.alloc(33, 0x11).toString('base64url')],
    ['empty', ''],
  ])('refuses a key of %s: AES-256 takes exactly 32', (_label, encoded) => {
    expect(() => parseSeedKeys(`1:${encoded}`)).toThrow(/32 bytes/);
  });

  /**
   * Node's base64 decoder ignores characters outside the alphabet, so a key pasted in
   * standard base64 (or with a stray quote) would otherwise decode to a *different* key
   * without complaint. The charset is checked before the decode.
   */
  it.each([
    ['standard base64 padding', `${'A'.repeat(42)}=`],
    ['standard base64 "+"', `+${'A'.repeat(42)}`],
    ['standard base64 "/"', `/${'A'.repeat(42)}`],
    ['a quote', `"${'A'.repeat(42)}`],
  ])('refuses a key containing %s', (_label, encoded) => {
    expect(() => parseSeedKeys(`1:${encoded}`)).toThrow(/base64url/);
  });

  it('names the offending entry so a long list can be fixed without bisecting it', () => {
    expect(() => parseSeedKeys(`1:${key(0x11)};2:short`)).toThrow(/entry 2/);
  });
});
