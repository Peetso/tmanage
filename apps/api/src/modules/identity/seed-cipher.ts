import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SeedKeyring } from '@tmanage/config';

/**
 * Authenticated encryption for TOTP seeds — review finding D07 (2026-09-06).
 *
 * The seed was written to `user_mfa_factors.secret` exactly as the authenticator received
 * it. TOTP needs a *recoverable* secret, which is why hashing is not an option here, but
 * recoverable is not the same as readable: a database dump or a backup disclosure handed
 * over every second factor in the system. This file is the one place that turns a seed into
 * something a dump cannot use, and back.
 *
 * Pure in the sense `password.ts` and `challenge-token.ts` are pure: no database, no
 * request, no framework. It is given a keyring and a user id, and everything it decides is
 * decidable from its arguments.
 *
 * ## AES-256-GCM, and what the tag is for
 *
 * GCM is authenticated encryption: the 16-byte tag is a MAC over the ciphertext *and* the
 * additional data, so a row someone edited in the database fails to open rather than
 * decrypting to a different seed. That is the acceptance criterion "altered ciphertext is
 * rejected", and it is why plain CTR or CBC would not do.
 *
 * The additional data is the owning **user id**. Without it, ciphertext is portable between
 * rows: an attacker with UPDATE on the table could copy their own factor's ciphertext into
 * an administrator's row and sign in with their own authenticator. With it, that row fails
 * authentication, because the id the decrypt is asked for is not the id the tag covers.
 *
 * A fresh 12-byte IV per encryption, from `randomBytes`. Twelve is GCM's native size, and
 * "fresh" is not a nicety — reusing an IV under one key breaks GCM's confidentiality *and*
 * lets an attacker forge tags. There is no counter here that could be resumed at the wrong
 * value after a restart; every call draws a new one.
 *
 * ## The envelope
 *
 *     mfa1.<version>.<base64url iv>.<base64url ciphertext>.<base64url tag>
 *
 * One string, because it has to fit the existing `VARCHAR(255)` column without a migration,
 * and self-describing, because the alternative is a second column that can disagree with
 * the first. The leading `mfa1.` is the format's own version, and it names the one format
 * *this* code reads: a later scheme (a different cipher, a KDF) becomes `mfa2.`, and it is
 * that later code's job to read both. Here, anything not starting `mfa1.` is `not_encrypted`
 * — including a hypothetical `mfa2.` row — because the safe reading of a value this build
 * does not understand is "this is not a seed I can use", not "assume it is fine".
 *
 * The `<version>` field is the **key** version, which is what makes rotation possible
 * without a downtime window: a row says which key opens it, so a new key can be added and
 * the rows re-encrypted afterwards, at leisure, by the backfill.
 *
 * ## Anything that is not an envelope is refused
 *
 * A row left from before D07 holds a bare base32 seed, and a bare base32 seed is *usable* —
 * which is exactly why it must not be used. Silently accepting it would leave plaintext
 * working forever, invisible, with nobody ever running the backfill. It raises
 * `not_encrypted` and the message names the command that fixes it.
 */

/** The envelope format's own version, distinct from the key version inside it. */
const ENVELOPE_PREFIX = 'mfa1';
/** GCM's native IV size. */
const IV_BYTES = 12;
/** The full-length GCM tag. Truncating it would weaken forgery resistance for four bytes. */
const TAG_BYTES = 16;
/**
 * base64url, no padding — the encoding every field of the envelope uses.
 *
 * Empty is permitted by the pattern so that an empty field is reported by the length checks
 * below it, which say what was actually wrong, rather than as a charset failure it is not.
 */
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * Why a stored value could not be turned back into a seed. The distinctions matter to the
 * operator reading the log: `not_encrypted` is a backfill that has not been run,
 * `unknown_key_version` is a key missing from the environment, and
 * `authentication_failed` is tampering or a row moved between users.
 */
export type SeedCipherRejection =
  'not_encrypted' | 'malformed' | 'unknown_key_version' | 'authentication_failed';

export class SeedCipherError extends Error {
  constructor(
    public readonly reason: SeedCipherRejection,
    message: string,
  ) {
    super(message);
    this.name = 'SeedCipherError';
  }
}

export interface SeedCipher {
  /**
   * Encrypt under the keyring's active key. `aad.userId` is the row's owner.
   *
   * Throws `TypeError` for an empty seed — see the implementation for why that is a
   * `TypeError` and not a {@link SeedCipherError}.
   */
  encrypt(plaintextSeed: string, aad: { userId: string }): string;
  /** Decrypt, or throw {@link SeedCipherError}. Never returns unauthenticated output. */
  decrypt(envelope: string, aad: { userId: string }): string;
  /** The key version an envelope names, or `null` if the value is not a readable envelope. */
  keyVersionOf(envelope: string): number | null;
  /** Whether re-encrypting this value under the active key would change it. */
  needsRotation(envelope: string): boolean;
}

export function createSeedCipher(keyring: SeedKeyring): SeedCipher {
  const keyVersionOf = (envelope: string): number | null => {
    try {
      return parseEnvelope(envelope).version;
    } catch {
      return null;
    }
  };

  return {
    encrypt(plaintextSeed: string, aad: { userId: string }): string {
      // An empty seed encrypts to an empty ciphertext, and `parseEnvelope` refuses an empty
      // ciphertext field — so without this guard `encrypt('')` would hand back a string that
      // `decrypt` calls `malformed`, and the round-trip property this file rests on would
      // have a hole in it. A `TypeError` rather than a `SeedCipherError` because every
      // `SeedCipherRejection` describes a *stored* value an operator has to go and fix;
      // this one is a caller passing nothing, which is a bug in the calling code.
      if (plaintextSeed === '') {
        throw new TypeError('cannot encrypt an empty MFA seed: there is nothing to protect');
      }

      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', keyring.active.key, iv, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(Buffer.from(aad.userId, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintextSeed, 'utf8'), cipher.final()]);
      return [
        ENVELOPE_PREFIX,
        keyring.active.version,
        iv.toString('base64url'),
        ciphertext.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
      ].join('.');
    },

    decrypt(envelope: string, aad: { userId: string }): string {
      const parts = parseEnvelope(envelope);
      const key = keyring.byVersion.get(parts.version);
      if (key === undefined) {
        throw new SeedCipherError(
          'unknown_key_version',
          `MFA seed is encrypted under key version ${parts.version}, which AUTH_MFA_SEED_KEYS does not hold`,
        );
      }

      // `authTagLength` on both primitives, so the 16-byte constraint is stated where the
      // cipher is built and not only in `parseEnvelope`. A future caller reaching past the
      // parser still cannot set a truncated tag.
      const decipher = createDecipheriv('aes-256-gcm', key, parts.iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(aad.userId, 'utf8'));
      decipher.setAuthTag(parts.tag);
      try {
        // `update` produces plaintext before anything has been verified; `final` is where
        // the tag is checked. Both are inside the try and the result is returned only after
        // `final` returns, so unauthenticated bytes never leave this function.
        const seed = Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
        return seed.toString('utf8');
      } catch {
        throw new SeedCipherError(
          'authentication_failed',
          'MFA seed failed authentication: the stored value has been altered, or it belongs to another user',
        );
      }
    },

    keyVersionOf,

    /**
     * True for an older key version, and also for anything that is not an envelope at all:
     * a leftover plaintext row is the most urgent thing the backfill has to pick up, and a
     * sweep that skipped it for failing to parse would leave the finding open.
     */
    needsRotation(envelope: string): boolean {
      return keyVersionOf(envelope) !== keyring.active.version;
    },
  };
}

interface EnvelopeParts {
  readonly version: number;
  readonly iv: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

function parseEnvelope(value: string): EnvelopeParts {
  if (!value.startsWith(`${ENVELOPE_PREFIX}.`)) {
    throw new SeedCipherError(
      'not_encrypted',
      'stored MFA seed is not encrypted (no "mfa1." envelope): run `pnpm --filter @tmanage/api mfa:encrypt-seeds`',
    );
  }

  const parts = value.split('.');
  if (parts.length !== 5) {
    throw malformed(`an envelope has five dot-separated fields, this one has ${parts.length}`);
  }
  const [, rawVersion, rawIv, rawCiphertext, rawTag] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  // Canonical decimal: no leading zeros, so `01` and `007` are refused rather than read as
  // version 1 and 7. One key version has to have one spelling — otherwise a re-encrypt could
  // write `mfa1.1.…` for rows a status sweep counted under `01`, and the two would disagree
  // about how much of the table is still on the old key.
  if (!/^[1-9]\d*$/.test(rawVersion)) {
    throw malformed(`key version "${rawVersion}" is not a positive integer`);
  }

  return {
    version: Number(rawVersion),
    iv: field(rawIv, 'iv', IV_BYTES),
    ciphertext: field(rawCiphertext, 'ciphertext', null),
    tag: field(rawTag, 'tag', TAG_BYTES),
  };
}

/**
 * Decode one field, refusing the wrong length before the cipher is ever constructed.
 *
 * The charset is checked first because Node's base64 decoder ignores characters outside the
 * alphabet: without this, a corrupted field could decode to the right number of bytes and
 * be reported as `authentication_failed` — tampering — rather than as the malformed value
 * it is. Each message says only what that check detected: a charset failure is not an
 * emptiness failure, and an operator staring at a stored value should not be sent looking
 * for the wrong thing. `bytes` is `null` for the ciphertext, whose length follows the seed;
 * it must still be non-empty, which `encrypt` guarantees by refusing an empty seed.
 */
function field(text: string, label: string, bytes: number | null): Buffer {
  if (!BASE64URL.test(text)) {
    throw malformed(`${label} is not base64url`);
  }
  const decoded = Buffer.from(text, 'base64url');
  if (bytes !== null && decoded.byteLength !== bytes) {
    throw malformed(`${label} is ${decoded.byteLength} bytes, expected ${bytes}`);
  }
  if (decoded.byteLength === 0) {
    throw malformed(`${label} is empty`);
  }
  return decoded;
}

function malformed(detail: string): SeedCipherError {
  return new SeedCipherError('malformed', `malformed MFA seed envelope: ${detail}`);
}
