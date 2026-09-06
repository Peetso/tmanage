/**
 * The MFA seed keyring: `AUTH_MFA_SEED_KEYS`, parsed.
 *
 * Review finding D07 (2026-09-06) — TOTP seeds were stored as recoverable plaintext, so a
 * database dump or backup disclosed every second factor. The seeds are now encrypted with a
 * key held **outside** the database, which only helps if the key can be replaced without a
 * migration: hence a versioned list rather than one key.
 *
 * ## The format, and why it is one variable
 *
 *     AUTH_MFA_SEED_KEYS=1:<base64url 32 bytes>;2:<base64url 32 bytes>
 *
 * The **highest version is active** — everything new is encrypted under it — and every other
 * entry is decrypt-only, kept so rows written before a rotation still open. Rotating is
 * therefore: append a higher version, restart, run the backfill, and drop the old entry once
 * `mfa-seeds status` reports nothing left under it. One variable rather than
 * `AUTH_MFA_SEED_KEY_1`, `_2`, … because a keyring assembled by scanning the environment for
 * a prefix cannot tell "the operator removed version 1" from "version 1 failed to load".
 *
 * ## Why the parser lives in `packages/config`
 *
 * Two callers need exactly the same rules: `env.ts` validates the variable at boot, and the
 * API builds the cipher from it. A second implementation on the API side would be a second
 * definition of what a valid keyring is, and the two would eventually disagree about
 * something like a trailing `;` — the API accepting a keyring the boot check rejected, or
 * worse, the other way round.
 *
 * It refuses rather than repairs. A key that decodes to the wrong length, a duplicated
 * version, an entry pasted in standard base64: each one is a mistake that would otherwise
 * surface as an authentication failure on a user's sign-in, long after the deploy that
 * caused it.
 */

/** One key and the version that names it in an envelope. */
export interface SeedKey {
  readonly version: number;
  readonly key: Buffer;
}

export interface SeedKeyring {
  /** The key new ciphertext is written under: the highest version present. */
  readonly active: SeedKey;
  /** Every key, including the active one. Older entries exist only to decrypt. */
  readonly byVersion: ReadonlyMap<number, Buffer>;
}

/** AES-256. Not negotiable, and a shorter key is a typo rather than a weaker choice. */
const KEY_BYTES = 32;

/**
 * base64url, no padding — what `randomBytes(32).toString('base64url')` produces.
 *
 * Checked before decoding because Node's base64 decoder silently *ignores* characters
 * outside the alphabet: a key pasted in standard base64 (`+`, `/`, `=`) would otherwise
 * decode to a different key of the right length, and every existing envelope would fail to
 * authenticate with no explanation. Empty is permitted here so that the length check below
 * reports the useful message.
 */
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function parseSeedKeys(raw: string): SeedKeyring {
  const entries = raw.trim();
  if (entries === '') {
    throw new TypeError('seed keys must contain at least one <version>:<key> entry');
  }

  const byVersion = new Map<number, Buffer>();

  entries.split(';').forEach((entry, index) => {
    const where = `seed key entry ${index + 1}`;
    const text = entry.trim();
    if (text === '') {
      throw new TypeError(`${where} is empty: entries are separated by ";" with none trailing`);
    }

    const separator = text.indexOf(':');
    if (separator < 0) {
      throw new TypeError(`${where} is not of the form <version>:<key>`);
    }

    const rawVersion = text.slice(0, separator);
    // Canonical decimal, so `01` is refused rather than accepted as version 1. The envelope
    // carries the version as text, and a keyring that accepted both spellings would let an
    // operator write `01:<key>` while every row says `mfa1.1.…`: the duplicate check below
    // would not see the two as one version, and the highest-version rule would be deciding
    // between spellings rather than between keys.
    if (!/^[1-9]\d*$/.test(rawVersion)) {
      throw new TypeError(`${where} has version "${rawVersion}": versions are positive integers`);
    }
    const version = Number(rawVersion);
    if (byVersion.has(version)) {
      throw new TypeError(`${where} repeats version ${version}: duplicate versions are ambiguous`);
    }

    const encoded = text.slice(separator + 1);
    if (!BASE64URL.test(encoded)) {
      throw new TypeError(`${where} is not base64url: use "+"-free, "="-free base64url`);
    }
    const key = Buffer.from(encoded, 'base64url');
    if (key.byteLength !== KEY_BYTES) {
      throw new TypeError(
        `${where} decodes to ${key.byteLength} bytes: a key must be exactly ${KEY_BYTES} bytes`,
      );
    }

    byVersion.set(version, key);
  });

  const highest = Math.max(...byVersion.keys());
  const active = byVersion.get(highest);
  // Unreachable — the version came out of the same map on the line above. The guard is here
  // because `Map.get` is typed as possibly absent, not because it can be.
  if (active === undefined) throw new TypeError('seed keys contain no usable key');

  return { active: { version: highest, key: active }, byVersion };
}
