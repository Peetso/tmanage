import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * FieldCipher — 56-02 (secrets handling and key management).
 *
 * One authenticated cipher for every recoverable secret the schema keeps: connector refresh
 * tokens, webhook signing secrets, SCIM tokens, push keys, integration tokens, ZATCA keys and —
 * through its fallback ring — MFA seeds. It generalises `seed-cipher.ts` (D07): the same
 * AES-256-GCM, the same refusal of anything that is not an envelope, plus a *purpose* so a value
 * written for one column can never be opened as another.
 *
 * ## Why this module is NOT exported from the package index
 *
 * It imports `node:crypto`, like `realtime/ticket.ts`. The index is bundled into the browser; the
 * subpath `@tmanage/domain/field-cipher` is for the API and the worker only.
 *
 * ## The envelope
 *
 *     fc1.<purpose>.<keyId>.<base64url iv>.<base64url ciphertext>.<base64url tag>
 *
 * Self-describing, one column. `fc1` is the format version; `keyId` names the key that opens it,
 * which is what lets a new key be added and the rows re-encrypted afterwards without downtime.
 *
 * ## Additional data
 *
 * AAD = `fc1 \0 purpose \0 ownerId`. The owner (the row id, or the user id for MFA) stops a row
 * swap: ciphertext copied into another row fails authentication. The purpose stops a column
 * swap, and it is also inside the tag, so editing the purpose field of an envelope fails too.
 *
 * ## Keyless
 *
 * Without `FIELD_CIPHER_KEYS` the cipher is **disabled**: `encrypt` throws `disabled`. A caller
 * must then refuse the feature (or keep the secret out of the database) — it never falls back
 * to storing plaintext. `status()` reports the state for the platform Keys page.
 */

export const FIELD_CIPHER_PURPOSES = [
  'mfa',
  'storage_token',
  'calendar_token',
  'webhook_secret',
  'scim_token',
  'push_key',
  'integration_token',
  'zatca_key',
] as const;
export type FieldCipherPurpose = (typeof FIELD_CIPHER_PURPOSES)[number];

const FORMAT = 'fc1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const KEY_ID = /^[1-9]\d{0,8}$/;
/** `openssl rand -base64 32` (standard, padded) or base64url — exactly 32 bytes either way. */
const KEY_TEXT = /^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9_-]{43})$/;

/** Every envelope in a string — for log scrubbing and the gitleaks rule. */
export const FIELD_CIPHER_ENVELOPE_PATTERN =
  /\bfc1\.[a-z][a-z0-9_]*\.[1-9]\d*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

export type FieldCipherRejection =
  | 'disabled'
  | 'not_encrypted'
  | 'malformed'
  | 'wrong_purpose'
  | 'unknown_key'
  | 'authentication_failed';

export class FieldCipherError extends Error {
  constructor(
    public readonly reason: FieldCipherRejection,
    message: string,
  ) {
    super(message);
    this.name = 'FieldCipherError';
  }
}

export interface FieldCipherKeyring {
  /** The newest key (highest id): everything new is written under it. */
  readonly active: { readonly id: string; readonly key: Buffer };
  /** Every key, the active one included. Older ones only decrypt. */
  readonly byId: ReadonlyMap<string, Buffer>;
}

export interface FieldCipherAad {
  readonly purpose: FieldCipherPurpose;
  readonly ownerId: string;
}

export interface FieldCipherStatus {
  readonly enabled: boolean;
  readonly activeKeyId: string | null;
  /** Key ids only — never a value. */
  readonly keyIds: readonly string[];
  readonly mfaFallback: boolean;
}

export interface FieldCipher {
  /** True when `FIELD_CIPHER_KEYS` is set. The MFA purpose may still work through its fallback. */
  readonly enabled: boolean;
  status(): FieldCipherStatus;
  /** The id new envelopes of this purpose are written under, or null when keyless. */
  activeKeyId(purpose: FieldCipherPurpose): string | null;
  encrypt(plaintext: string, aad: FieldCipherAad): string;
  /** Decrypt, or throw {@link FieldCipherError}. Never returns unauthenticated bytes. */
  decrypt(envelope: string, aad: FieldCipherAad): string;
  /** Whether the value is a well-formed `fc1.` envelope (key not checked). */
  isEnvelope(value: string): boolean;
  keyIdOf(envelope: string): string | null;
  /** Re-encrypt under the newest key; `null` when it already is. Throws like `decrypt`. */
  rotate(envelope: string, aad: FieldCipherAad): string | null;
}

/**
 * Parse `FIELD_CIPHER_KEYS`: `<id>:<base64 32 bytes>` entries separated by `;`. The highest id is
 * active. Refuses rather than repairs — a short key, a duplicate id, a stray character.
 */
export function parseFieldCipherKeys(raw: string): FieldCipherKeyring {
  const text = raw.trim();
  if (text === '') throw new TypeError('FIELD_CIPHER_KEYS has no <id>:<key> entry');
  const byId = new Map<string, Buffer>();
  text.split(';').forEach((entry, index) => {
    const where = `FIELD_CIPHER_KEYS entry ${index + 1}`;
    const item = entry.trim();
    const separator = item.indexOf(':');
    if (separator < 0) throw new TypeError(`${where} is not of the form <id>:<key>`);
    const id = item.slice(0, separator);
    if (!KEY_ID.test(id)) throw new TypeError(`${where}: key id must be a positive integer`);
    if (byId.has(id)) throw new TypeError(`${where} repeats key id ${id}`);
    const encoded = item.slice(separator + 1);
    if (!KEY_TEXT.test(encoded)) {
      throw new TypeError(`${where}: key must be 32 bytes, from \`openssl rand -base64 32\``);
    }
    const key = Buffer.from(encoded, encoded.includes('=') ? 'base64' : 'base64url');
    if (key.byteLength !== KEY_BYTES) throw new TypeError(`${where}: key is not 32 bytes`);
    byId.set(id, key);
  });
  const activeId = String(Math.max(...[...byId.keys()].map(Number)));
  return { active: { id: activeId, key: byId.get(activeId) as Buffer }, byId };
}

/** `FIELD_CIPHER_KEYS` absent or blank → `null` (disabled); present but wrong → throws. */
export function loadFieldCipherKeyring(env: {
  readonly FIELD_CIPHER_KEYS?: string | undefined;
}): FieldCipherKeyring | null {
  const raw = env.FIELD_CIPHER_KEYS;
  return raw === undefined || raw.trim() === '' ? null : parseFieldCipherKeys(raw);
}

/** The MFA fallback: `AUTH_MFA_SEED_KEYS`' parsed ring (structurally), as a FieldCipher ring. */
export function keyringFromSeedKeyring(seed: {
  readonly active: { readonly version: number; readonly key: Buffer };
  readonly byVersion: ReadonlyMap<number, Buffer>;
}): FieldCipherKeyring {
  const byId = new Map<string, Buffer>();
  for (const [version, key] of seed.byVersion) byId.set(String(version), key);
  return { active: { id: String(seed.active.version), key: seed.active.key }, byId };
}

/**
 * Key ids of `keyring` whose bytes also appear in another secret (another keyring, a pepper, the
 * session secret). Boot refuses production when this is non-empty: one leak must not open two.
 */
export function sharedKeyIds(
  keyring: FieldCipherKeyring,
  otherSecrets: readonly Buffer[],
): string[] {
  const shared: string[] = [];
  for (const [id, key] of keyring.byId) {
    if (otherSecrets.some((other) => other.length === key.length && timingSafeEqual(other, key))) {
      shared.push(id);
    }
  }
  return shared;
}

export function createFieldCipher(
  keyring: FieldCipherKeyring | null,
  options: { readonly mfaFallback?: FieldCipherKeyring | null } = {},
): FieldCipher {
  const mfaFallback = options.mfaFallback ?? null;
  const ringFor = (purpose: FieldCipherPurpose): FieldCipherKeyring | null =>
    keyring ?? (purpose === 'mfa' ? mfaFallback : null);
  const requireRing = (purpose: FieldCipherPurpose): FieldCipherKeyring => {
    const ring = ringFor(purpose);
    if (ring === null) {
      throw new FieldCipherError(
        'disabled',
        `FIELD_CIPHER_KEYS is not set: the ${purpose} secret cannot be stored or read`,
      );
    }
    return ring;
  };

  const encryptWith = (ring: FieldCipherKeyring, plaintext: string, aad: FieldCipherAad) => {
    if (plaintext === '') throw new TypeError('cannot encrypt an empty secret');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', ring.active.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aadBytes(aad));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      FORMAT,
      aad.purpose,
      ring.active.id,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  };

  const decrypt = (envelope: string, aad: FieldCipherAad): string => {
    const ring = requireRing(aad.purpose);
    const parts = parseEnvelope(envelope);
    if (parts.purpose !== aad.purpose) {
      throw new FieldCipherError(
        'wrong_purpose',
        `envelope is for "${parts.purpose}", not "${aad.purpose}"`,
      );
    }
    const key = ring.byId.get(parts.keyId);
    if (key === undefined) {
      throw new FieldCipherError(
        'unknown_key',
        `envelope needs key ${parts.keyId}, which the keyring does not hold`,
      );
    }
    const decipher = createDecipheriv('aes-256-gcm', key, parts.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadBytes(aad));
    decipher.setAuthTag(parts.tag);
    try {
      return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new FieldCipherError(
        'authentication_failed',
        'secret failed authentication: altered, or moved from another row',
      );
    }
  };

  const keyIdOf = (envelope: string): string | null => {
    try {
      return parseEnvelope(envelope).keyId;
    } catch {
      return null;
    }
  };

  return {
    enabled: keyring !== null,
    status: () => ({
      enabled: keyring !== null,
      activeKeyId: keyring?.active.id ?? null,
      keyIds: keyring === null ? [] : [...keyring.byId.keys()],
      mfaFallback: keyring === null && mfaFallback !== null,
    }),
    activeKeyId: (purpose) => ringFor(purpose)?.active.id ?? null,
    encrypt: (plaintext, aad) => encryptWith(requireRing(aad.purpose), plaintext, aad),
    decrypt,
    isEnvelope: (value) => keyIdOf(value) !== null,
    keyIdOf,
    rotate(envelope, aad) {
      const ring = requireRing(aad.purpose);
      const plaintext = decrypt(envelope, aad);
      return keyIdOf(envelope) === ring.active.id ? null : encryptWith(ring, plaintext, aad);
    },
  };
}

function aadBytes(aad: FieldCipherAad): Buffer {
  if (aad.ownerId === '') throw new TypeError('a FieldCipher owner id is required');
  return Buffer.from(`${FORMAT}\0${aad.purpose}\0${aad.ownerId}`, 'utf8');
}

interface EnvelopeParts {
  readonly purpose: string;
  readonly keyId: string;
  readonly iv: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

function parseEnvelope(value: string): EnvelopeParts {
  if (!value.startsWith(`${FORMAT}.`)) {
    throw new FieldCipherError('not_encrypted', 'stored secret is not an "fc1." envelope');
  }
  const parts = value.split('.');
  if (parts.length !== 6) throw malformed(`six fields expected, found ${parts.length}`);
  const [, purpose, keyId, iv, ciphertext, tag] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!(FIELD_CIPHER_PURPOSES as readonly string[]).includes(purpose)) {
    throw malformed(`unknown purpose "${purpose}"`);
  }
  if (!KEY_ID.test(keyId)) throw malformed(`key id "${keyId}" is not a positive integer`);
  return {
    purpose,
    keyId,
    iv: field(iv, 'iv', IV_BYTES),
    ciphertext: field(ciphertext, 'ciphertext', null),
    tag: field(tag, 'tag', TAG_BYTES),
  };
}

function field(text: string, label: string, bytes: number | null): Buffer {
  if (!BASE64URL.test(text)) throw malformed(`${label} is not base64url`);
  const decoded = Buffer.from(text, 'base64url');
  if (decoded.byteLength === 0) throw malformed(`${label} is empty`);
  if (bytes !== null && decoded.byteLength !== bytes) {
    throw malformed(`${label} is ${decoded.byteLength} bytes, expected ${bytes}`);
  }
  return decoded;
}

function malformed(detail: string): FieldCipherError {
  return new FieldCipherError('malformed', `malformed fc1 envelope: ${detail}`);
}
