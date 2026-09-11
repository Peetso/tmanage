import { describe, expect, it } from 'vitest';
import { clampToColumnCharacters } from './credentials.repository.js';

/**
 * `D09`. The clamp that stands between a request header and a bounded column.
 *
 * The database suite proves the whole path against a real server — a forged address really
 * being written, really coming back at 45 characters, and the insert really not raising
 * `ER_DATA_TOO_LONG`. What it cannot do cheaply is enumerate the string shapes that make the
 * *unit* of the clamp the interesting part, and those are what decide whether the clamped
 * value still fits the column and is still the value that arrived:
 *
 * - a BMP multi-byte character (`中`) is three bytes but **one** MySQL character;
 * - an astral-plane character (`𝔄`, `😀`) is four bytes and **one** MySQL character, but
 *   **two** UTF-16 code units, which is the direction `String.prototype.slice` gets wrong in
 *   the way that matters: slicing at 45 UTF-16 units can land *inside* a surrogate pair and
 *   leave half of one behind.
 *
 * That half does not produce an error, which is worth being exact about, because the comment
 * on the implementation used to claim it did. mysql2 (3.23.3) maps this connection's
 * `utf8mb4` charset to Node's `'utf8'` encoding and encodes parameters with
 * `Buffer.from(value, 'utf8')`, and Node substitutes U+FFFD for an unpaired surrogate:
 * `Buffer.from('\uD83D', 'utf8')` is `ef bf bd`. A UTF-16 slice would therefore have been
 * accepted, having quietly written `�` over the character it cut — a substitution this table
 * is not allowed to make, because it records what arrived — and having under-filled the
 * column while it did. `test/id-002-credentials.db.test.ts` shows that happening against a
 * real server; the cases here are about the string shapes that lead to it.
 *
 * So the cases below are about code points, not lengths.
 */
describe('clampToColumnCharacters', () => {
  it('keeps null and undefined as null, because absence is not an empty address', () => {
    expect(clampToColumnCharacters(null, 45)).toBeNull();
    expect(clampToColumnCharacters(undefined, 45)).toBeNull();
  });

  it('returns a value inside the bound unchanged, character for character', () => {
    const address = '2001:0db8:85a3:0000:0000:8a2e:0370:255.255.255.255';
    expect(clampToColumnCharacters('203.0.113.9', 45)).toBe('203.0.113.9');
    expect(clampToColumnCharacters('', 45)).toBe('');
    // Exactly at the bound is inside it.
    expect(clampToColumnCharacters(address.slice(0, 45), 45)).toBe(address.slice(0, 45));
  });

  it('takes the leading characters of an over-long value', () => {
    expect(clampToColumnCharacters('a'.repeat(300), 45)).toBe('a'.repeat(45));
    expect(clampToColumnCharacters('b'.repeat(1000), 255)).toBe('b'.repeat(255));
  });

  it('does not trim, lower-case or otherwise normalise what arrived', () => {
    expect(clampToColumnCharacters('  X-Forged  ', 45)).toBe('  X-Forged  ');
  });

  /**
   * A multi-byte BMP character. Three bytes, one character — so 45 of them fit a
   * `VARCHAR(45)` exactly, and a clamp that counted *bytes* would wrongly cut this to 15.
   */
  it('counts a multi-byte character as one, not as its bytes', () => {
    const clamped = clampToColumnCharacters('中'.repeat(50), 45);
    expect(clamped).toBe('中'.repeat(45));
    expect(Array.from(clamped!)).toHaveLength(45);
    expect(Buffer.byteLength(clamped!, 'utf8')).toBe(135);
  });

  /**
   * The astral case, and the reason `slice` is not the implementation. `𝔄` is U+1D504: one
   * MySQL character, two UTF-16 code units. Forty-five of them are 45 characters as the
   * column counts them, so the value is already inside the bound and must come back
   * untouched — a `slice(0, 45)` would have cut it in half *and* ended on a lone surrogate.
   */
  it('leaves 45 astral characters alone, even though they are 90 UTF-16 units', () => {
    const astral = '𝔄'.repeat(45);
    expect(astral).toHaveLength(90);
    expect(clampToColumnCharacters(astral, 45)).toBe(astral);
  });

  it('clamps astral characters by code point and never splits a surrogate pair', () => {
    const clamped = clampToColumnCharacters('😀'.repeat(300), 45);
    expect(Array.from(clamped!)).toHaveLength(45);
    expect(clamped).toBe('😀'.repeat(45));
    // No unpaired surrogate anywhere: every code unit in D800–DFFF belongs to a pair.
    const high = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
    const low = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(high.test(clamped!)).toBe(false);
    expect(low.test(clamped!)).toBe(false);
  });

  /**
   * The boundary that a UTF-16 slice gets wrong. Two ASCII characters then astral ones, so
   * units 43 and 44 are the two halves of one character and unit 45 — where a `slice(0, 45)`
   * cuts — falls between them: the slice ends on a high surrogate with nothing after it. The
   * clamp ends on a whole character instead, and takes 45 of them.
   */
  it('stops before a character it cannot take whole', () => {
    const value = `ab${'😀'.repeat(60)}`;
    expect(value.slice(0, 45)).toMatch(/[\uD800-\uDBFF]$/u);
    const clamped = clampToColumnCharacters(value, 45);
    expect(clamped).toBe(`ab${'😀'.repeat(43)}`);
    expect(Array.from(clamped!)).toHaveLength(45);
    expect(clamped).toHaveLength(88);
  });

  /**
   * A grapheme cluster *is* cut, and that is deliberate. The column counts code points, so
   * cutting a woman-ZWJ-woman-ZWJ-girl sequence between its members yields a shorter and
   * still valid utf8mb4 string — and this is an audit log recording what arrived, not text
   * shown to anyone. Refusing to cut it would mean either rejecting the row or returning
   * fewer characters by an amount no caller can predict.
   */
  it('may cut a grapheme cluster, and still yields valid text', () => {
    // Woman-ZWJ-woman-ZWJ-girl: one cluster, five code points. Spelled with explicit
    // escapes so the joiners are visible in the source rather than invisible in it.
    const family = '\u{1F469}\u200D\u{1F469}\u200D\u{1F467}';
    expect(Array.from(family)).toHaveLength(5);
    const clamped = clampToColumnCharacters(family.repeat(10), 3);
    expect(Array.from(clamped!)).toHaveLength(3);
    expect(clamped).toBe('\u{1F469}\u200D\u{1F469}');
    expect(Buffer.from(clamped!, 'utf8').toString('utf8')).toBe(clamped);
  });

  /**
   * A value that already carries a lone surrogate is carried through with it, and is still
   * clamped by code point around it. The driver will render that surrogate U+FFFD on the way
   * to the server (see the header), but it does so to a character the client sent; a clamp
   * asked only to shorten must not add a substitution of its own.
   *
   * The second input is what makes this case discriminating. A lone high surrogate followed
   * by astral characters is a string the two candidate clamps disagree about: 45 UTF-16 units
   * is the surrogate plus 22 whole emoji, 45 code points is the surrogate plus 44 of them.
   * Both expectations are written out rather than sliced, so neither can be satisfied by the
   * implementation this suite exists to rule out.
   */
  it('does not repair a lone surrogate it was handed, and still clamps by code point', () => {
    expect(clampToColumnCharacters(`\uD83D${'a'.repeat(100)}`, 45)).toBe(`\uD83D${'a'.repeat(44)}`);

    const broken = `\uD83D${'😀'.repeat(60)}`;
    const clamped = clampToColumnCharacters(broken, 45);
    expect(clamped).toBe(`\uD83D${'😀'.repeat(44)}`);
    expect(Array.from(clamped!)).toHaveLength(45);
    expect(clamped).toHaveLength(89);
    // The clamps really do disagree on this input, which is the point of choosing it.
    expect(broken.slice(0, 45)).not.toBe(clamped);
    expect(broken.slice(0, 45)).toBe(`\uD83D${'😀'.repeat(22)}`);
  });
});
