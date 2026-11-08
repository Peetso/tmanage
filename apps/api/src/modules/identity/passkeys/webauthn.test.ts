import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issuePasskeyChallenge, verifyPasskeyChallenge } from './passkey-challenge.js';
import { computeSecurityScore, isNewDevice } from './security-score.js';
import { verifyAssertion, verifyRegistration } from './webauthn.js';

// A minimal CBOR encoder and a software authenticator — enough to drive both ceremonies.
const head = (major: number, n: number) =>
  n < 24
    ? Buffer.from([(major << 5) | n])
    : n < 256
      ? Buffer.from([(major << 5) | 24, n])
      : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
function cbor(v: unknown): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  const m = v as Map<unknown, unknown>;
  return Buffer.concat([head(5, m.size), ...[...m].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}
const b64 = (b: Buffer) => b.toString('base64url');
const sha = (b: Buffer) => createHash('sha256').update(b).digest();
const rp = { rpId: 'tmanage.test', origins: ['https://tmanage.test'] };

function authData(
  rpId: string,
  flags: number,
  count: number,
  cred?: { id: Buffer; key: KeyObject },
) {
  const c = Buffer.alloc(4);
  c.writeUInt32BE(count);
  const parts: Buffer[] = [sha(Buffer.from(rpId)), Buffer.from([flags]), c];
  if (cred) {
    const jwk = cred.key.export({ format: 'jwk' });
    const cose =
      jwk.kty === 'EC'
        ? new Map<number, unknown>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, Buffer.from(jwk.x!, 'base64url')],
            [-3, Buffer.from(jwk.y!, 'base64url')],
          ])
        : new Map<number, unknown>([
            [1, 3],
            [3, -257],
            [-1, Buffer.from(jwk.n!, 'base64url')],
            [-2, Buffer.from(jwk.e!, 'base64url')],
          ]);
    const len = Buffer.from([cred.id.length >> 8, cred.id.length & 255]);
    parts.push(Buffer.alloc(16), len, cred.id, cbor(cose));
  }
  return Buffer.concat(parts);
}
const clientData = (type: string, challenge: string, origin = rp.origins[0]) =>
  Buffer.from(JSON.stringify({ type, challenge, origin }));

function enrol(kind: 'ec' | 'rsa') {
  const pair =
    kind === 'ec'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const att = cbor(
    new Map<string, unknown>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData(rp.rpId, 0x45, 0, { id: Buffer.from('cred-1'), key: pair.publicKey })],
    ]),
  );
  const reg = verifyRegistration({
    rp,
    challenge: 'c1',
    requireUserVerification: true,
    clientDataJSON: b64(clientData('webauthn.create', 'c1')),
    attestationObject: b64(att),
  });
  return { ...pair, reg };
}

function assert(
  p: ReturnType<typeof enrol>,
  o: {
    origin?: string;
    challenge?: string;
    rpId?: string;
    count?: number;
    stored?: number;
    tamper?: boolean;
  } = {},
) {
  const ad = authData(o.rpId ?? rp.rpId, 0x05, o.count ?? 5);
  const cd = clientData('webauthn.get', o.challenge ?? 'c2', o.origin);
  const sig = sign('sha256', Buffer.concat([ad, sha(cd)]), p.privateKey);
  if (o.tamper) sig.writeUInt8(sig.readUInt8(sig.length - 1) ^ 1, sig.length - 1);
  return () =>
    verifyAssertion({
      rp,
      challenge: 'c2',
      requireUserVerification: true,
      clientDataJSON: b64(cd),
      authenticatorData: b64(ad),
      signature: b64(sig),
      publicKey: p.reg.publicKey,
      alg: p.reg.alg,
      storedSignCount: o.stored ?? 4,
    });
}

describe('WebAuthn verification (56-22)', () => {
  const ec = enrol('ec');

  it('registers ES256 and RS256 credentials and accepts a valid assertion for each', () => {
    expect(ec.reg).toMatchObject({ alg: -7, credentialId: b64(Buffer.from('cred-1')) });
    expect(assert(ec)()).toEqual({ signCount: 5 });
    const rsa = enrol('rsa');
    expect(rsa.reg.alg).toBe(-257);
    expect(assert(rsa)()).toEqual({ signCount: 5 });
  });

  it.each([
    ['wrong origin', { origin: 'https://evil.test' }, 'wrong_origin'],
    ['wrong challenge', { challenge: 'other' }, 'wrong_challenge'],
    ['wrong rpId', { rpId: 'evil.test' }, 'wrong_rp_id'],
    ['bad signature', { tamper: true }, 'bad_signature'],
    ['signCount regression', { count: 3, stored: 4 }, 'sign_count_regression'],
  ])('refuses a %s', (_label, options, reason) => {
    expect(assert(ec, options)).toThrow(expect.objectContaining({ reason }));
  });

  it('allows authenticators that never count (0 and 0)', () => {
    expect(assert(ec, { count: 0, stored: 0 })()).toEqual({ signCount: 0 });
  });
});

describe('passkey challenge token', () => {
  it('round-trips, and refuses another purpose, a forgery and an expired token', () => {
    const { token, challenge } = issuePasskeyChallenge({ purpose: 'sign_in' }, 's', 1000);
    expect(verifyPasskeyChallenge(token, 'sign_in', 's', 2000)?.challenge).toBe(challenge);
    expect(verifyPasskeyChallenge(token, 'register', 's', 2000)).toBeNull();
    expect(verifyPasskeyChallenge(token, 'sign_in', 'other', 2000)).toBeNull();
    expect(verifyPasskeyChallenge(token, 'sign_in', 's', 1000 + 5 * 60 * 1000 + 1)).toBeNull();
  });
});

describe('security score and new device', () => {
  it('adds the points of passed checks and fails a password older than a year', () => {
    const now = new Date('2026-11-08T00:00:00Z');
    const old = new Date('2025-01-01T00:00:00Z');
    expect(
      computeSecurityScore(
        { mfaFactors: 1, passkeys: 1, recoveryCodes: 8, passwordSetAt: old },
        now,
      ).score,
    ).toBe(80);
    expect(
      computeSecurityScore(
        { mfaFactors: 0, passkeys: 0, recoveryCodes: 0, passwordSetAt: now },
        now,
      ).score,
    ).toBe(20);
  });

  it('reports a new browser/OS only when there is an earlier sign-in to compare with', () => {
    const mac =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
    const win =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0';
    expect(isNewDevice(win, [mac])).toBe(true);
    expect(isNewDevice(mac, [mac])).toBe(false);
    expect(isNewDevice(win, [])).toBe(false);
  });
});
