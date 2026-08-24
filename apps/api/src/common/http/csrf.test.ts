import { describe, expect, it } from 'vitest';
import { CSRF_HEADER, isSafeMethod, mintCsrfToken, verifyCsrfToken } from './csrf.js';

/**
 * The CSRF primitive — ADR-0004.
 *
 * Pure, so every property below is checkable without a server, a database, or a request. What
 * these cases are really protecting is the *binding*: a token that verified against any
 * session, or against no session, would be a double-submit cookie with a signature on it and
 * would not defeat cookie tossing at all.
 */

const SECRET = 'local_dev_only_csrf_secret_for_the_unit_suite';
const OTHER_SECRET = 'local_dev_only_a_completely_different_csrf_secret';
const SESSION = '01992a1e-4c7b-7000-8000-000000000001';
const OTHER_SESSION = '01992a1e-4c7b-7000-8000-000000000002';

describe('mintCsrfToken', () => {
  it('is deterministic for one session and secret', () => {
    expect(mintCsrfToken(SESSION, SECRET)).toBe(mintCsrfToken(SESSION, SECRET));
  });

  it('differs for a different session', () => {
    expect(mintCsrfToken(SESSION, SECRET)).not.toBe(mintCsrfToken(OTHER_SESSION, SECRET));
  });

  it('differs for a different secret', () => {
    expect(mintCsrfToken(SESSION, SECRET)).not.toBe(mintCsrfToken(SESSION, OTHER_SECRET));
  });

  it('carries a version prefix that is covered by the signature', () => {
    const token = mintCsrfToken(SESSION, SECRET);
    expect(token.startsWith('v1.')).toBe(true);

    // Re-labelling a v1 token as v2 must not verify. The prefix is inside the HMAC input, so
    // a future scheme cannot be produced by editing the label on this one.
    const relabelled = `v2.${token.slice('v1.'.length)}`;
    expect(verifyCsrfToken(relabelled, SESSION, SECRET)).toBe(false);
  });

  it('contains no session identifier in the clear', () => {
    // The token is readable by same-origin script by design. It should still not hand a
    // reader the session id it is bound to.
    expect(mintCsrfToken(SESSION, SECRET)).not.toContain(SESSION);
  });
});

describe('verifyCsrfToken', () => {
  it('accepts the token minted for that session', () => {
    expect(verifyCsrfToken(mintCsrfToken(SESSION, SECRET), SESSION, SECRET)).toBe(true);
  });

  it('rejects a token minted for another session', () => {
    // The cookie-tossing case: the attacker's token is genuine and correctly signed, and is
    // bound to their session rather than the victim's.
    expect(verifyCsrfToken(mintCsrfToken(OTHER_SESSION, SECRET), SESSION, SECRET)).toBe(false);
  });

  it('rejects a token signed with a different secret', () => {
    expect(verifyCsrfToken(mintCsrfToken(SESSION, OTHER_SECRET), SESSION, SECRET)).toBe(false);
  });

  it('rejects an absent token', () => {
    expect(verifyCsrfToken(undefined, SESSION, SECRET)).toBe(false);
    expect(verifyCsrfToken('', SESSION, SECRET)).toBe(false);
  });

  it('rejects a tampered token of the correct length', () => {
    const token = mintCsrfToken(SESSION, SECRET);
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(flipped).toHaveLength(token.length);
    expect(verifyCsrfToken(flipped, SESSION, SECRET)).toBe(false);
  });

  it('rejects a truncated token rather than matching on a prefix', () => {
    const token = mintCsrfToken(SESSION, SECRET);
    // A comparison that stopped at the shorter length would accept this, which is the exact
    // defect the constant-time helper's length check exists to prevent.
    expect(verifyCsrfToken(token.slice(0, 12), SESSION, SECRET)).toBe(false);
  });

  it('rejects a token with trailing whitespace', () => {
    // Header values arrive as sent. Trimming here would be a second, looser parse of a value
    // whose whole job is to be compared exactly.
    expect(verifyCsrfToken(`${mintCsrfToken(SESSION, SECRET)} `, SESSION, SECRET)).toBe(false);
  });
});

describe('isSafeMethod', () => {
  it('treats the read methods as safe, in any case', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head', 'options']) {
      expect(isSafeMethod(method)).toBe(true);
    }
  });

  it('treats every mutating method as unsafe', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete']) {
      expect(isSafeMethod(method)).toBe(false);
    }
  });

  it('treats an unfamiliar method as unsafe', () => {
    // The allowlist is the safe set, so a method nobody anticipated is guarded rather than
    // exempt. A denylist would have the failure fall the other way.
    for (const method of ['PURGE', 'LINK', 'PROPFIND', '']) {
      expect(isSafeMethod(method)).toBe(false);
    }
  });
});

describe('the header name', () => {
  it('is lowercase, because Node normalises incoming header names', () => {
    // `request.headers['X-CSRF-Token']` is always undefined under Node's HTTP parser. A
    // guard looking under the capitalised key would find nothing and refuse every mutation.
    expect(CSRF_HEADER).toBe(CSRF_HEADER.toLowerCase());
  });
});
