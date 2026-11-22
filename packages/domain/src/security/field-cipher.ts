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
 *
 * ## The MFA fallback ring across the switch (LANE-X, 2026-11-22)
 *
 * The `mfa` purpose may also be given `AUTH_MFA_SEED_KEYS` as a fallback ring. While
 * `FIELD_CIPHER_KEYS` is unset, that ring is used for both directions. Once it is set,
 * **encryption** uses only the `FIELD_CIPHER_KEYS` active key, and **decryption** still reads the
 * fallback ring. The fallback is tried when the envelope's key id is missing from the main ring,
 * and also when the id is in both rings (the usual case: both start at `1`) but the main key
 * fails authentication. When both rings hold the id, both keys are tried every time, with no
 * early exit, so the time taken does not show which ring opened it (ASVS 5.0 11.2.4). A key held
 * in both rings with the same bytes is tried once. `rotate` re-seals anything that was not opened
 * by the main active key itself, so an envelope that only looks current (id collision, fallback
 * key) moves too. The cipher never writes on its own: re-encryption happens through `rotate`.
 * This keeps a key in its recipient-usage period, decrypt only, until its data is re-encrypted
 * (NIST SP 800-57 Pt 1 Rev 5 §5.3.6 item 6, §7.2).
 *
 * ## Entry separator: `,` on Hostinger
 *
 * Hostinger's hPanel writes environment values into a `.env` that cuts a value at `;` (proven
 * 2026-11-20 on `SMTP_PASSWORD`; quoting did not help). So entries are separated by `,`. `;` is
 * still read for older values. A value that mixes the two, or that has an empty entry (a
 * trailing or doubled separator), is refused with a message naming the cut. A cut that falls
 * exactly between two entries leaves a valid shorter list, and no parser can see that. The deploy
 * runbook therefore says to check the key ids on the platform Keys page after every change.
 * The same rule lives in `packages/config/src/seed-keys.ts` (`splitKeyEntries`), because this
 * inner-ring package may import nothing (AR-1); `field-cipher.test.ts` and `seed-keys.test.ts`
 * pin the same cases.
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
  'reporter_email',
  // 52-12 (R22-a): `org_secrets.ciphertext`, the ZATCA signing certificate + key (owner = row id).
  'org_secret',
  // 56-03p: the token vault (`apps/api/src/modules/connectors/token-vault.ts`). An API-key or OAuth
  // connector credential (`connector_installations.credential_enc`) and a Figma token
  // (`figma_connections.token_ciphertext`); owner = the writer's binding string.
  'connector_token',
  'figma_token',
  // LANE-Q (0388): a "Book a walkthrough" visitor's address (`walkthrough_requests.email_enc`,
  // owner = row id).
  'walkthrough_email',
  // LANE-Q (0389): an outreach recipient's work address (`outreach_recipients.email_enc`,
  // owner = row id). Both are walked by the worker's key rotation.
  'outreach_email',
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
  /**
   * True while MFA is still *written* on the fallback ring (`FIELD_CIPHER_KEYS` unset). Once it is
   * set this is false, and the fallback ring is read-only for `mfa` (see the module comment).
   */
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
 * Split a keyring value into its entries: `,` (what Hostinger needs) or `;` (older values), never
 * both, and never an empty entry.
 */
export function splitKeyringEntries(text: string, name: string): string[] {
  const hasComma = text.includes(',');
  const hasSemicolon = text.includes(';');
  if (hasComma && hasSemicolon) {
    throw new TypeError(`${name} mixes "," and ";": separate entries with "," only`);
  }
  const separator = hasSemicolon ? ';' : ',';
  const entries = text.split(separator).map((entry) => entry.trim());
  entries.forEach((entry, index) => {
    if (entry === '') {
      throw new TypeError(
        `${name} entry ${index + 1} is empty (a trailing or doubled "${separator}"). ` +
          'Hostinger cuts a value at ";", so separate entries with ","',
      );
    }
  });
  return entries;
}

/**
 * Parse `FIELD_CIPHER_KEYS`: `<id>:<base64 32 bytes>` entries separated by `,` (or `;`, see
 * {@link splitKeyringEntries}). The highest id is active. Refuses rather than repairs: a short
 * key, a duplicate id, a stray character, an empty entry.
 */
export function parseFieldCipherKeys(raw: string): FieldCipherKeyring {
  const text = raw.trim();
  if (text === '') throw new TypeError('FIELD_CIPHER_KEYS has no <id>:<key> entry');
  const byId = new Map<string, Buffer>();
  splitKeyringEntries(text, 'FIELD_CIPHER_KEYS').forEach((item, index) => {
    const where = `FIELD_CIPHER_KEYS entry ${index + 1}`;
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

/**
 * The MFA fallback: `AUTH_MFA_SEED_KEYS`' parsed ring (structurally), as a FieldCipher ring. It
 * writes only while `FIELD_CIPHER_KEYS` is unset; afterwards it still opens `mfa` envelopes.
 */
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

  /**
   * The keys that may open an envelope naming `keyId`: the ring's own key and, for `mfa` only,
   * the fallback ring's key of the same id when it differs in bytes (an id collision).
   */
  const candidateKeys = (purpose: FieldCipherPurpose, keyId: string): Buffer[] => {
    const candidates: Buffer[] = [];
    const main = requireRing(purpose).byId.get(keyId);
    if (main !== undefined) candidates.push(main);
    if (purpose === 'mfa' && keyring !== null && mfaFallback !== null) {
      const fallback = mfaFallback.byId.get(keyId);
      if (fallback !== undefined && !(main !== undefined && sameKey(main, fallback))) {
        candidates.push(fallback);
      }
    }
    return candidates;
  };

  /** Open an envelope; also returns the key that opened it, so `rotate` can tell the rings apart. */
  const open = (envelope: string, aad: FieldCipherAad): { plaintext: string; key: Buffer } => {
    requireRing(aad.purpose);
    const parts = parseEnvelope(envelope);
    if (parts.purpose !== aad.purpose) {
      throw new FieldCipherError(
        'wrong_purpose',
        `envelope is for "${parts.purpose}", not "${aad.purpose}"`,
      );
    }
    const candidates = candidateKeys(aad.purpose, parts.keyId);
    if (candidates.length === 0) {
      throw new FieldCipherError(
        'unknown_key',
        `envelope needs key ${parts.keyId}, which the keyring does not hold`,
      );
    }
    const additional = aadBytes(aad);
    let opened: { plaintext: string; key: Buffer } | null = null;
    // Every candidate is tried, even after one succeeds: no early exit, so the time taken does
    // not tell which ring holds the seed (ASVS 5.0 11.2.4). GCM checks the tag itself in constant
    // time; at most two candidates exist.
    for (const key of candidates) {
      const plaintext = openWith(key, parts, additional);
      if (plaintext !== null && opened === null) opened = { plaintext, key };
    }
    if (opened === null) {
      throw new FieldCipherError(
        'authentication_failed',
        'secret failed authentication: altered, or moved from another row',
      );
    }
    return opened;
  };
  const decrypt = (envelope: string, aad: FieldCipherAad): string => open(envelope, aad).plaintext;

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
      const { plaintext, key } = open(envelope, aad);
      // Current only when opened by the active key itself. Comparing ids alone would leave a seed
      // sealed under fallback key 1 in place when the main ring's active key is also id 1.
      const current = keyIdOf(envelope) === ring.active.id && sameKey(key, ring.active.key);
      return current ? null : encryptWith(ring, plaintext, aad);
    },
  };
}

function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Authenticated decrypt under one key; `null` when the tag does not verify. */
function openWith(key: Buffer, parts: EnvelopeParts, additional: Buffer): string | null {
  const decipher = createDecipheriv('aes-256-gcm', key, parts.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(additional);
  decipher.setAuthTag(parts.tag);
  try {
    // `final` checks the tag; bytes are returned only after it passes.
    return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
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
