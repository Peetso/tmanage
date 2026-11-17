import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';

/**
 * 56-22. WebAuthn registration and assertion verification on `node:crypto` alone.
 *
 * No WebAuthn library is in the workspace, and this slice may not add one, so the parts of the
 * W3C WebAuthn Level 2 ceremony the server owns are implemented here, and only those:
 *
 * - `clientDataJSON`: `type`, `challenge` (constant-time), `origin` (exact match against the
 *   allowed list), `crossOrigin` refused.
 * - `authenticatorData`: the RP id hash, the flags (UP always; UV when required; AT on
 *   registration), the sign counter (monotonic when either side is non-zero).
 * - The credential public key: COSE EC2 P-256 / ES256 (-7) and RSA / RS256 (-257), nothing else.
 * - The assertion signature over `authenticatorData || SHA-256(clientDataJSON)`.
 *
 * Attestation is **not** evaluated: options ask for `attestation: 'none'`, and whatever statement
 * an authenticator still sends is ignored — no trust decision here rests on the make of the
 * authenticator. Every refusal is a {@link WebAuthnError} with a closed reason for the log.
 */

export const ALG_ES256 = -7;
export const ALG_RS256 = -257;
export const SUPPORTED_ALGS: readonly number[] = [ALG_ES256, ALG_RS256];

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export type WebAuthnReason =
  | 'malformed'
  | 'wrong_type'
  | 'wrong_challenge'
  | 'wrong_origin'
  | 'cross_origin'
  | 'wrong_rp_id'
  | 'user_not_present'
  | 'user_not_verified'
  | 'no_credential_data'
  | 'unsupported_algorithm'
  | 'bad_signature'
  | 'sign_count_regression';

export class WebAuthnError extends Error {
  constructor(readonly reason: WebAuthnReason) {
    super(`webauthn verification failed: ${reason}`);
    this.name = 'WebAuthnError';
  }
}

// ─── CBOR (RFC 8949), the subset authenticators emit ─────────────────────────

type CborValue =
  number | string | boolean | null | Buffer | CborValue[] | Map<CborValue, CborValue>;

/** Decode one CBOR item at `offset`. Indefinite lengths, tags and floats are refused. */
export function decodeCbor(
  buffer: Buffer,
  offset = 0,
  depth = 0,
): { value: CborValue; end: number } {
  if (depth > 16 || offset >= buffer.length) throw new WebAuthnError('malformed');
  const head = buffer[offset] as number;
  const major = head >> 5;
  const info = head & 0x1f;
  let length: number;
  let at = offset + 1;
  if (info < 24) length = info;
  else if (info === 24) length = buffer.readUInt8(at++);
  else if (info === 25) {
    length = buffer.readUInt16BE(at);
    at += 2;
  } else if (info === 26) {
    length = buffer.readUInt32BE(at);
    at += 4;
  } else throw new WebAuthnError('malformed');

  switch (major) {
    case 0:
      return { value: length, end: at };
    case 1:
      return { value: -1 - length, end: at };
    case 2:
    case 3: {
      if (at + length > buffer.length) throw new WebAuthnError('malformed');
      const bytes = buffer.subarray(at, at + length);
      return { value: major === 2 ? Buffer.from(bytes) : bytes.toString('utf8'), end: at + length };
    }
    case 4: {
      const items: CborValue[] = [];
      for (let i = 0; i < length; i++) {
        const item = decodeCbor(buffer, at, depth + 1);
        items.push(item.value);
        at = item.end;
      }
      return { value: items, end: at };
    }
    case 5: {
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < length; i++) {
        const key = decodeCbor(buffer, at, depth + 1);
        const value = decodeCbor(buffer, key.end, depth + 1);
        map.set(key.value, value.value);
        at = value.end;
      }
      return { value: map, end: at };
    }
    case 7:
      if (info === 20) return { value: false, end: at };
      if (info === 21) return { value: true, end: at };
      if (info === 22) return { value: null, end: at };
      throw new WebAuthnError('malformed');
    default:
      throw new WebAuthnError('malformed');
  }
}

// ─── COSE keys ───────────────────────────────────────────────────────────────

/** A COSE_Key map to a `KeyObject`, refusing anything but ES256/P-256 and RS256. */
export function coseToPublicKey(cose: Map<CborValue, CborValue>): { alg: number; key: KeyObject } {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2 && alg === ALG_ES256) {
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (cose.get(-1) !== 1 || !isBytes(x, 32) || !isBytes(y, 32)) {
      throw new WebAuthnError('unsupported_algorithm');
    }
    const jwk = { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') };
    return { alg, key: createPublicKey({ key: jwk, format: 'jwk' }) };
  }
  if (kty === 3 && alg === ALG_RS256) {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!Buffer.isBuffer(n) || n.length < 256 || !Buffer.isBuffer(e)) {
      throw new WebAuthnError('unsupported_algorithm');
    }
    const jwk = { kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url') };
    return { alg, key: createPublicKey({ key: jwk, format: 'jwk' }) };
  }
  throw new WebAuthnError('unsupported_algorithm');
}

function isBytes(value: unknown, length: number): value is Buffer {
  return Buffer.isBuffer(value) && value.length === length;
}

// ─── authenticatorData ───────────────────────────────────────────────────────

export interface AuthenticatorData {
  readonly rpIdHash: Buffer;
  readonly flags: number;
  readonly signCount: number;
  readonly credential?: {
    readonly id: Buffer;
    readonly cose: Map<CborValue, CborValue>;
  };
}

export function parseAuthenticatorData(data: Buffer): AuthenticatorData {
  if (data.length < 37) throw new WebAuthnError('malformed');
  const rpIdHash = data.subarray(0, 32);
  const flags = data[32] as number;
  const signCount = data.readUInt32BE(33);
  if ((flags & FLAG_AT) === 0) return { rpIdHash, flags, signCount };
  if (data.length < 55) throw new WebAuthnError('malformed');
  const idLength = data.readUInt16BE(53);
  const idEnd = 55 + idLength;
  if (idLength === 0 || idLength > 1023 || idEnd > data.length)
    throw new WebAuthnError('malformed');
  const cose = decodeCbor(data, idEnd).value;
  if (!(cose instanceof Map)) throw new WebAuthnError('malformed');
  return { rpIdHash, flags, signCount, credential: { id: data.subarray(55, idEnd), cose } };
}

// ─── The two ceremonies ──────────────────────────────────────────────────────

export interface RelyingParty {
  /** The RP id: the web host, e.g. `tmanageapp.com`. */
  readonly rpId: string;
  /** Every origin a ceremony may come from, e.g. `https://tmanageapp.com`. */
  readonly origins: readonly string[];
}

interface Expected {
  readonly rp: RelyingParty;
  /** The base64url challenge the server issued. */
  readonly challenge: string;
  readonly requireUserVerification: boolean;
}

export interface VerifiedRegistration {
  readonly credentialId: string;
  /** SubjectPublicKeyInfo DER, base64url. */
  readonly publicKey: string;
  readonly alg: number;
  readonly signCount: number;
  readonly backedUp: boolean;
}

export function verifyRegistration(
  input: Expected & { readonly clientDataJSON: string; readonly attestationObject: string },
): VerifiedRegistration {
  checkClientData(decode(input.clientDataJSON), 'webauthn.create', input);
  const attestation = decodeCbor(decode(input.attestationObject)).value;
  const authData = attestation instanceof Map ? attestation.get('authData') : undefined;
  if (!Buffer.isBuffer(authData)) throw new WebAuthnError('malformed');
  const parsed = parseAuthenticatorData(authData);
  checkAuthenticatorData(parsed, input);
  if (!parsed.credential) throw new WebAuthnError('no_credential_data');
  const { alg, key } = coseToPublicKey(parsed.credential.cose);
  return {
    credentialId: parsed.credential.id.toString('base64url'),
    publicKey: key.export({ format: 'der', type: 'spki' }).toString('base64url'),
    alg,
    signCount: parsed.signCount,
    backedUp: (parsed.flags & FLAG_BS) !== 0,
  };
}

export function verifyAssertion(
  input: Expected & {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly publicKey: string;
    readonly alg: number;
    readonly storedSignCount: number;
  },
): { readonly signCount: number } {
  const clientData = decode(input.clientDataJSON);
  checkClientData(clientData, 'webauthn.get', input);
  const authData = decode(input.authenticatorData);
  const parsed = parseAuthenticatorData(authData);
  checkAuthenticatorData(parsed, input);

  if (!SUPPORTED_ALGS.includes(input.alg)) throw new WebAuthnError('unsupported_algorithm');
  const key = createPublicKey({ key: decode(input.publicKey), format: 'der', type: 'spki' });
  const signed = Buffer.concat([authData, sha256(clientData)]);
  const options = input.alg === ALG_ES256 ? { key, dsaEncoding: 'der' as const } : key;
  let valid = false;
  try {
    valid = verify('sha256', signed, options, decode(input.signature));
  } catch {
    valid = false;
  }
  if (!valid) throw new WebAuthnError('bad_signature');

  // A counter that does not move forward means two authenticators hold one key. Authenticators
  // that never count (0 and 0, typical of synced passkeys) are allowed.
  if (
    (parsed.signCount !== 0 || input.storedSignCount !== 0) &&
    parsed.signCount <= input.storedSignCount
  ) {
    throw new WebAuthnError('sign_count_regression');
  }
  return { signCount: parsed.signCount };
}

function checkClientData(raw: Buffer, type: string, expected: Expected): void {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    data = JSON.parse(raw.toString('utf8')) as typeof data;
  } catch {
    throw new WebAuthnError('malformed');
  }
  if (data === null || typeof data !== 'object') throw new WebAuthnError('malformed');
  if (data.type !== type) throw new WebAuthnError('wrong_type');
  if (typeof data.challenge !== 'string' || !sameText(data.challenge, expected.challenge)) {
    throw new WebAuthnError('wrong_challenge');
  }
  if (typeof data.origin !== 'string' || !expected.rp.origins.includes(data.origin)) {
    throw new WebAuthnError('wrong_origin');
  }
  if (data.crossOrigin === true) throw new WebAuthnError('cross_origin');
}

function checkAuthenticatorData(parsed: AuthenticatorData, expected: Expected): void {
  if (!timingSafeEqual(parsed.rpIdHash, sha256(Buffer.from(expected.rp.rpId, 'utf8')))) {
    throw new WebAuthnError('wrong_rp_id');
  }
  if ((parsed.flags & FLAG_UP) === 0) throw new WebAuthnError('user_not_present');
  if (expected.requireUserVerification && (parsed.flags & FLAG_UV) === 0) {
    throw new WebAuthnError('user_not_verified');
  }
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function decode(value: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/u.test(value)) {
    throw new WebAuthnError('malformed');
  }
  return Buffer.from(value, 'base64url');
}

export function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/** The SHA-256 hex of a base64url credential id: the unique lookup key in `user_passkeys`. */
export function credentialIdHash(credentialId: string): string {
  return createHash('sha256').update(decode(credentialId)).digest('hex');
}
