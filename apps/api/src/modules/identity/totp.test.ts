import { describe, expect, it } from 'vitest';
import {
  TOTP_DEFAULTS,
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotpCode,
  totpCounterAt,
  totpUri,
  verifyTotp,
} from './totp.js';

/**
 * TOTP, checked against the RFCs' own published vectors before anything else.
 *
 * An implementation of RFC 4226 / 6238 that has not been run against the test vectors in the
 * documents is an implementation nobody has verified — every off-by-one in the truncation,
 * the counter, or the byte order produces codes that look perfectly plausible.
 */

/** RFC 4226 Appendix D: ASCII "12345678901234567890". */
const RFC4226_SECRET = Uint8Array.from(Buffer.from('12345678901234567890', 'ascii'));

describe('RFC 4226 Appendix D — the HOTP vectors', () => {
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ])('counter %i produces %s', (counter, expected) => {
    expect(hotpCode(RFC4226_SECRET, counter, { digits: 6, algorithm: 'SHA1' })).toBe(expected);
  });
});

describe('RFC 6238 Appendix B — the TOTP vectors', () => {
  /**
   * The RFC's table is 8-digit and uses a different (longer) secret per algorithm. The SHA-1
   * rows use the same twenty-byte secret as RFC 4226, so those are the ones asserted here —
   * SHA-256 and SHA-512 would need their 32- and 64-byte secrets, and the implementation
   * shares one code path across all three.
   */
  it.each([
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ])('at unix time %i the code is %s', (unixSeconds, expected) => {
    const counter = totpCounterAt(unixSeconds * 1000, 30);
    expect(hotpCode(RFC4226_SECRET, counter, { digits: 8, algorithm: 'SHA1' })).toBe(expected);
  });

  it('derives the counter the RFC says it should', () => {
    // RFC 6238 Appendix B's own T column, in hex.
    expect(totpCounterAt(59_000, 30)).toBe(0x1);
    expect(totpCounterAt(1_111_111_109_000, 30)).toBe(0x23523ec);
    expect(totpCounterAt(20_000_000_000_000, 30)).toBe(0x27bc86aa);
  });
});

describe('base32', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encodes %o as %o (RFC 4648 §10)', (input, expected) => {
    expect(base32Encode(Buffer.from(input, 'ascii'))).toBe(expected);
  });

  it('round-trips a generated secret', () => {
    const secret = generateTotpSecret();
    const decoded = base32Decode(secret);
    expect(decoded).toBeDefined();
    expect(base32Encode(decoded!)).toBe(secret);
  });

  it('generates 160 bits', () => {
    expect(base32Decode(generateTotpSecret())!.length).toBe(20);
  });

  it('never generates the same secret twice', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateTotpSecret()));
    expect(secrets.size).toBe(50);
  });

  it.each(['mzxw6ytboi', 'MZXW-6YTB-OI', 'MZXW6YTBOI======', ' MZXW6YTBOI '])(
    'tolerates %o, because a person types this',
    (input) => {
      expect(Buffer.from(base32Decode(input)!).toString('ascii')).toBe('foobar');
    },
  );

  it.each(['MZXW6YTB01', 'not base32!', ''])('refuses %o rather than throwing', (input) => {
    expect(base32Decode(input)).toBeUndefined();
  });
});

describe('verification', () => {
  const secret = base32Encode(RFC4226_SECRET);
  /** Counter 0x23523ec, from the RFC vectors above. */
  const atMs = 1_111_111_109_000;
  const code = hotpCode(RFC4226_SECRET, totpCounterAt(atMs, 30), TOTP_DEFAULTS);

  it('accepts the current code and reports which counter matched', () => {
    const result = verifyTotp({ secret, code, atMs });
    expect(result).toEqual({ ok: true, counter: totpCounterAt(atMs, 30) });
  });

  it('accepts the previous step, for a phone that is running slow', () => {
    const result = verifyTotp({ secret, code, atMs: atMs + 30_000 });
    expect(result.ok).toBe(true);
  });

  it('accepts the next step, for a phone that is running fast', () => {
    const result = verifyTotp({ secret, code, atMs: atMs - 30_000 });
    expect(result.ok).toBe(true);
  });

  it('refuses two steps away, which is the edge of the window', () => {
    expect(verifyTotp({ secret, code, atMs: atMs + 60_000 })).toEqual({
      ok: false,
      rejection: 'no_match',
    });
    expect(verifyTotp({ secret, code, atMs: atMs - 60_000 })).toEqual({
      ok: false,
      rejection: 'no_match',
    });
  });

  /**
   * The reason `verifyTotp` returns a counter. Without this, a code observed over someone's
   * shoulder or through a phishing proxy is usable for the whole 90-second window.
   */
  it('refuses a code whose counter has already been accepted', () => {
    const counter = totpCounterAt(atMs, 30);
    expect(verifyTotp({ secret, code, atMs, lastAcceptedCounter: counter })).toEqual({
      ok: false,
      rejection: 'replayed',
    });
  });

  it('refuses a counter below the last accepted one, not only equal to it', () => {
    const counter = totpCounterAt(atMs, 30);
    expect(verifyTotp({ secret, code, atMs, lastAcceptedCounter: counter + 5 })).toEqual({
      ok: false,
      rejection: 'replayed',
    });
  });

  it('accepts the next counter once the previous one has been used', () => {
    const counter = totpCounterAt(atMs, 30);
    const next = hotpCode(RFC4226_SECRET, counter + 1, TOTP_DEFAULTS);
    const result = verifyTotp({
      secret,
      code: next,
      atMs: atMs + 30_000,
      lastAcceptedCounter: counter,
    });
    expect(result).toEqual({ ok: true, counter: counter + 1 });
  });

  it.each(['12345', '1234567', 'abcdef', '', '12 34 5'])(
    'rejects %o as malformed before touching the secret',
    (bad) => {
      expect(verifyTotp({ secret, code: bad, atMs })).toEqual({
        ok: false,
        rejection: 'malformed_code',
      });
    },
  );

  it('tolerates the spaces an authenticator app puts in the middle', () => {
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp({ secret, code: spaced, atMs }).ok).toBe(true);
  });

  it('reports a malformed secret separately from a wrong code', () => {
    expect(verifyTotp({ secret: 'not base32!', code, atMs })).toEqual({
      ok: false,
      rejection: 'malformed_secret',
    });
  });

  it('refuses a code from a different secret', () => {
    const other = generateTotpSecret();
    expect(verifyTotp({ secret: other, code, atMs })).toEqual({
      ok: false,
      rejection: 'no_match',
    });
  });

  it('does not go below counter zero at the epoch', () => {
    const zeroCode = hotpCode(RFC4226_SECRET, 0, TOTP_DEFAULTS);
    expect(verifyTotp({ secret, code: zeroCode, atMs: 0 })).toEqual({ ok: true, counter: 0 });
  });
});

describe('the otpauth URI', () => {
  it('carries the secret, the issuer twice, and the parameters', () => {
    const uri = totpUri({
      secret: 'MZXW6YTBOI',
      accountName: 'omar@northstar.studio',
      issuer: 'TManage',
    });
    const parsed = new URL(uri);

    expect(parsed.protocol).toBe('otpauth:');
    expect(uri.startsWith('otpauth://totp/TManage:omar%40northstar.studio?')).toBe(true);
    expect(parsed.searchParams.get('secret')).toBe('MZXW6YTBOI');
    expect(parsed.searchParams.get('issuer')).toBe('TManage');
    expect(parsed.searchParams.get('algorithm')).toBe('SHA1');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe('30');
  });

  /**
   * An issuer containing a colon would split the label and attach the factor to the wrong
   * account name in the authenticator's list — silently, and only visibly once someone needs
   * the code.
   */
  it('encodes a colon in the issuer rather than letting it split the label', () => {
    const uri = totpUri({
      secret: 'MZXW6YTBOI',
      accountName: 'a@b.test',
      issuer: 'North:star',
    });
    expect(uri).toContain('North%3Astar:a%40b.test');
  });
});
