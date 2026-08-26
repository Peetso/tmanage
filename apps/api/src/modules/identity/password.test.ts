import { describe, expect, it } from 'vitest';
import {
  ARGON2_PARAMETERS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  describePasswordRejection,
  hashPassword,
  needsRehash,
  screenPassword,
  verifyPassword,
  type BreachedPasswordScreen,
} from './password.js';

const GOOD = 'a quiet line on paper';

describe('hashing', () => {
  it('produces an Argon2id PHC string carrying the current parameters', async () => {
    const hash = await hashPassword(GOOD);
    expect(hash.startsWith('$argon2id$v=19$')).toBe(true);
    expect(hash).toContain(`m=${ARGON2_PARAMETERS.memoryCost}`);
    expect(hash).toContain(`t=${ARGON2_PARAMETERS.timeCost}`);
    expect(hash).toContain(`p=${ARGON2_PARAMETERS.parallelism}`);
  });

  it('salts, so the same password twice is two different hashes', async () => {
    const [a, b] = await Promise.all([hashPassword(GOOD), hashPassword(GOOD)]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, GOOD)).toBe(true);
    expect(await verifyPassword(b, GOOD)).toBe(true);
  });

  it('verifies the right password and refuses the wrong one', async () => {
    const hash = await hashPassword(GOOD);
    expect(await verifyPassword(hash, GOOD)).toBe(true);
    expect(await verifyPassword(hash, `${GOOD} `)).toBe(false);
    expect(await verifyPassword(hash, GOOD.toUpperCase())).toBe(false);
  });

  /**
   * A corrupt stored value must refuse the sign-in, not raise a 500 that tells the caller
   * their account is in an unusual state.
   */
  it.each(['', 'not a hash', '$argon2id$broken', '$2b$10$abcdefghijklmnopqrstuv'])(
    'returns false rather than throwing for the stored value %o',
    async (stored) => {
      await expect(verifyPassword(stored, GOOD)).resolves.toBe(false);
    },
  );

  it('normalises Unicode, so the same keystrokes on two keyboards agree', async () => {
    // U+00E9 versus U+0065 U+0301 — identical on screen, different bytes.
    const composed = 'café password';
    const decomposed = 'café password';
    expect(composed).not.toBe(decomposed);

    const hash = await hashPassword(composed);
    expect(await verifyPassword(hash, decomposed)).toBe(true);
  });

  it('does not trim, because a leading space is a character the person chose', async () => {
    const hash = await hashPassword(` ${GOOD}`);
    expect(await verifyPassword(hash, GOOD)).toBe(false);
    expect(await verifyPassword(hash, ` ${GOOD}`)).toBe(true);
  });
});

describe('needsRehash', () => {
  it('says no for a hash produced right now', async () => {
    expect(needsRehash(await hashPassword(GOOD))).toBe(false);
  });

  it.each([
    ['less memory', `$argon2id$v=19$m=4096,t=2,p=1$c2FsdA$aGFzaA`],
    ['fewer passes', `$argon2id$v=19$m=19456,t=1,p=1$c2FsdA$aGFzaA`],
    ['a different algorithm', `$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA`],
    ['bcrypt', `$2b$10$abcdefghijklmnopqrstuv`],
  ])('says yes for %s', (_name, stored) => {
    expect(needsRehash(stored)).toBe(true);
  });

  it('says yes for anything it cannot parse, because weak is the safe assumption', () => {
    expect(needsRehash('')).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=notanumber,t=2,p=1$s$h')).toBe(true);
  });

  it('says no for stronger parameters than the current ones', () => {
    expect(needsRehash('$argon2id$v=19$m=65536,t=3,p=2$c2FsdA$aGFzaA')).toBe(false);
  });
});

describe('screening', () => {
  async function rejections(password: string, identifiers?: readonly string[]) {
    const result = await screenPassword(
      identifiers === undefined ? { password } : { password, identifiers },
    );
    return result.rejections;
  }

  it('accepts a long, unremarkable passphrase', async () => {
    expect(await rejections(GOOD)).toEqual([]);
  });

  it('rejects anything shorter than the floor', async () => {
    expect(await rejections('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toContain('too_short');
    expect(await rejections('a'.repeat(PASSWORD_MIN_LENGTH))).not.toContain('too_short');
  });

  it('rejects a password long enough to be a denial of service', async () => {
    expect(await rejections('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toContain('too_long');
  });

  /**
   * Length is counted in code points. Eight emoji is eight characters; the naive `.length`
   * would call it sixteen and accept a four-glyph password.
   */
  it('counts astral characters once each', async () => {
    expect(await rejections('🌱🌿🍀🌵')).toContain('too_short');
    expect(await rejections('🌱🌿🍀🌵🌾🌻🌷🌹')).not.toContain('too_short');
  });

  it.each(['password', 'Password1', 'QWERTY123', 'admin@123', 'summer2026', 'p@ssw0rd'])(
    'rejects %o from the bundled list, whatever its case',
    async (password) => {
      expect(await rejections(password)).toContain('commonly_breached');
    },
  );

  it('rejects a password containing the person or the organization', async () => {
    expect(await rejections('northstar-relaunch', ['Northstar'])).toContain('contains_identifier');
    expect(await rejections('omarsbestpassword', ['omar@northstar.studio', 'omar'])).toContain(
      'contains_identifier',
    );
  });

  it('ignores identifiers too short to mean anything', async () => {
    expect(await rejections('a quiet line on paper', ['a', 'on', 'per'])).toEqual([]);
  });

  it('reports every rejection rather than the first', async () => {
    const found = await rejections('admin', ['admin']);
    expect(found).toContain('too_short');
    expect(found).toContain('commonly_breached');
    expect(found).toContain('contains_identifier');
  });

  it('describes every rejection in a sentence the person can act on', async () => {
    const found = await rejections('admin', ['admin']);
    for (const rejection of found) {
      const sentence = describePasswordRejection(rejection);
      expect(sentence.length).toBeGreaterThan(10);
      expect(sentence.endsWith('.')).toBe(true);
    }
  });
});

describe('the remote screen', () => {
  const breached: BreachedPasswordScreen = { isBreached: () => Promise.resolve(true) };
  const clean: BreachedPasswordScreen = { isBreached: () => Promise.resolve(false) };
  const down: BreachedPasswordScreen = { isBreached: () => Promise.resolve(undefined) };

  it('rejects what the corpus knows about', async () => {
    const result = await screenPassword({ password: GOOD, remoteScreen: breached });
    expect(result.rejections).toEqual(['commonly_breached']);
    expect(result.remoteScreenUnavailable).toBe(false);
  });

  it('accepts what it does not', async () => {
    const result = await screenPassword({ password: GOOD, remoteScreen: clean });
    expect(result.rejections).toEqual([]);
  });

  /**
   * The behaviour this signature exists for. "Could not check" is not "not breached", and
   * this module refuses to decide which of the two the caller should treat it as.
   */
  it('says it could not check rather than passing silently', async () => {
    const result = await screenPassword({ password: GOOD, remoteScreen: down });
    expect(result.rejections).toEqual([]);
    expect(result.remoteScreenUnavailable).toBe(true);
  });

  it('does not report the same rejection twice when both screens agree', async () => {
    const result = await screenPassword({ password: 'password', remoteScreen: breached });
    expect(result.rejections).toEqual(['commonly_breached']);
  });

  it('passes the normalised password to the remote screen', async () => {
    const seen: string[] = [];
    await screenPassword({
      password: 'café password',
      remoteScreen: {
        isBreached: (password) => {
          seen.push(password);
          return Promise.resolve(false);
        },
      },
    });
    expect(seen).toEqual(['café password']);
  });
});
