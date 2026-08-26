import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP — the second factor `04-SECURITY-PRIVACY.md` §3 asks for, and `22-SCREEN-BY-SCREEN`
 * §3's `ID-02` renders.
 *
 * RFC 6238 (TOTP) over RFC 4226 (HOTP), with the RFC 4648 base32 alphabet for the shared
 * secret, because that is the format every authenticator application reads from a QR code.
 *
 * Pure: a secret, a code and a moment in, a verdict out. No database, no clock of its own —
 * the caller passes the time, which is what makes the drift-window behaviour testable at all.
 *
 * ## Why TOTP and not a passkey, in this ticket
 *
 * `04` §3 lists both, and passkeys are the better credential: phishing-resistant, no shared
 * secret, nothing to type. They are not built here for an honest reason rather than a
 * preference — WebAuthn registration requires a browser and an authenticator, this machine
 * has neither, and a server-side WebAuthn verifier that has never verified a real attestation
 * is not evidence of anything. TOTP is entirely testable offline against the RFC's own test
 * vectors, so it is what this ticket delivers. Passkeys are recorded as open.
 *
 * ## SHA-1, deliberately
 *
 * RFC 6238 permits SHA-1, SHA-256 and SHA-512, and this implementation supports all three but
 * defaults to SHA-1. That is not a security judgement about SHA-1 as a hash — it is that
 * essentially every authenticator application ignores the `algorithm` parameter in the
 * `otpauth://` URI and assumes SHA-1. Choosing SHA-256 produces codes that silently do not
 * match on most phones, which is a far worse outcome than the theoretical weakness of HMAC-
 * SHA-1, against which no practical attack exists. The parameter is here so the default can
 * be revisited when the ecosystem does.
 */

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpParameters {
  /** Seconds per code. 30 is the universal default and every app assumes it. */
  readonly period: number;
  /** Code length. 6 everywhere; 8 is legal and almost nothing supports it. */
  readonly digits: number;
  readonly algorithm: TotpAlgorithm;
}

export const TOTP_DEFAULTS: TotpParameters = {
  period: 30,
  digits: 6,
  algorithm: 'SHA1',
};

/**
 * How many steps either side of the current one are accepted.
 *
 * One, giving a 90-second window with a 30-second period: the current code, the one before it
 * and the one after. RFC 6238 §5.2 recommends "at most one time step" and explains the
 * trade-off — a wider window is a linearly wider window for an attacker guessing codes, and
 * the reason to widen it is clock drift on the phone, which one step already covers.
 *
 * The step *after* the current one is accepted because a phone that is a few seconds fast
 * shows the next code before the server enters it, and a person typing what their phone shows
 * is not doing anything wrong.
 */
export const TOTP_DRIFT_STEPS = 1;

/** 160 bits — one full HMAC-SHA1 block, and RFC 4226 §4's recommendation. */
const SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ─────────────────────────────────────────────────────────────────────────────
// Secrets
// ─────────────────────────────────────────────────────────────────────────────

/** A new shared secret, base32-encoded without padding, ready for an `otpauth://` URI. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  // No `=` padding. RFC 4648 allows it; `otpauth://` URIs conventionally omit it, and a
  // padded secret pasted into some authenticator applications is rejected.
  return output;
}

/**
 * Decode a base32 secret.
 *
 * Tolerant on input because this value is often typed or pasted by a person: padding,
 * whitespace, hyphens and lowercase are all accepted. Returns `undefined` rather than
 * throwing on a character outside the alphabet, so a mistyped secret is a refusal rather
 * than a 500.
 */
export function base32Decode(encoded: string): Uint8Array | undefined {
  const cleaned = encoded.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (cleaned === '') return undefined;

  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) return undefined;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Uint8Array.from(bytes);
}

// ─────────────────────────────────────────────────────────────────────────────
// Codes
// ─────────────────────────────────────────────────────────────────────────────

/** The RFC 6238 counter for a moment: seconds since the epoch, divided by the period. */
export function totpCounterAt(atMs: number, period: number = TOTP_DEFAULTS.period): number {
  return Math.floor(atMs / 1000 / period);
}

/**
 * The code for one counter value. RFC 4226 §5.3's dynamic truncation.
 *
 * Exported because verification is expressed in terms of it and because the RFC's published
 * test vectors are asserted against it directly — a TOTP implementation that has not been run
 * against those vectors is an implementation nobody has checked.
 */
export function hotpCode(
  secret: Uint8Array,
  counter: number,
  { digits, algorithm }: Pick<TotpParameters, 'digits' | 'algorithm'> = TOTP_DEFAULTS,
): string {
  const message = Buffer.alloc(8);
  // The counter is a 64-bit big-endian integer. `writeBigUInt64BE` rather than two 32-bit
  // writes, because the high word is not always zero once the epoch is large enough and a
  // shift-based split silently loses it.
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(hmacName(algorithm), Buffer.from(secret)).update(message).digest();

  // Dynamic truncation: the low nibble of the last byte selects a 4-byte window.
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

export interface VerifyTotpInput {
  /** The base32 secret as stored. */
  readonly secret: string;
  /** What the person typed. Spaces are tolerated; anything else is not. */
  readonly code: string;
  /** The moment to verify against, in epoch milliseconds. Passed in, never read from a clock. */
  readonly atMs: number;
  /**
   * The counter this factor last accepted a code for, if any.
   *
   * This is how replay is prevented, and it is the reason `verifyTotp` returns the counter it
   * matched rather than a bare boolean. A TOTP code stays valid for the whole of its step —
   * up to 90 seconds with the drift window — so an attacker who observes one over the
   * shoulder, or in a phishing proxy, can present it again within that window. Refusing any
   * counter at or below the last accepted one closes that, at the cost of one column.
   */
  readonly lastAcceptedCounter?: number | null;
  readonly parameters?: TotpParameters;
  readonly driftSteps?: number;
}

export type TotpRejection = 'malformed_code' | 'malformed_secret' | 'no_match' | 'replayed';

export type VerifyTotpResult =
  | { readonly ok: true; readonly counter: number }
  | { readonly ok: false; readonly rejection: TotpRejection };

/**
 * Verify a code.
 *
 * Every candidate counter in the window is checked even after a match is found. That is not
 * an oversight: returning early would make the function's running time depend on *which*
 * counter matched, which leaks how far the presenter's clock is from the server's. The cost
 * is two extra HMACs.
 */
export function verifyTotp({
  secret,
  code,
  atMs,
  lastAcceptedCounter,
  parameters = TOTP_DEFAULTS,
  driftSteps = TOTP_DRIFT_STEPS,
}: VerifyTotpInput): VerifyTotpResult {
  const cleanedCode = code.replace(/[\s-]/g, '');
  if (!new RegExp(`^\\d{${parameters.digits}}$`).test(cleanedCode)) {
    return { ok: false, rejection: 'malformed_code' };
  }

  const decoded = base32Decode(secret);
  if (!decoded || decoded.length === 0) {
    return { ok: false, rejection: 'malformed_secret' };
  }

  const current = totpCounterAt(atMs, parameters.period);
  let matched: number | undefined;

  for (let offset = -driftSteps; offset <= driftSteps; offset += 1) {
    const counter = current + offset;
    if (counter < 0) continue;
    const candidate = hotpCode(decoded, counter, parameters);
    if (constantTimeEquals(candidate, cleanedCode) && matched === undefined) {
      matched = counter;
    }
  }

  if (matched === undefined) return { ok: false, rejection: 'no_match' };

  if (lastAcceptedCounter != null && matched <= lastAcceptedCounter) {
    return { ok: false, rejection: 'replayed' };
  }

  return { ok: true, counter: matched };
}

/**
 * The `otpauth://` URI an authenticator application reads from a QR code.
 *
 * `issuer` appears twice — once as a label prefix and once as a parameter — because the
 * prefix is what older applications display and the parameter is what current ones read.
 * Both are percent-encoded; an organization name containing a colon would otherwise split
 * the label and silently attach the factor to the wrong account name.
 */
export function totpUri({
  secret,
  accountName,
  issuer,
  parameters = TOTP_DEFAULTS,
}: {
  secret: string;
  accountName: string;
  issuer: string;
  parameters?: TotpParameters;
}): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: parameters.algorithm,
    digits: String(parameters.digits),
    period: String(parameters.period),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

function hmacName(algorithm: TotpAlgorithm): string {
  switch (algorithm) {
    case 'SHA1':
      return 'sha1';
    case 'SHA256':
      return 'sha256';
    case 'SHA512':
      return 'sha512';
  }
}

/**
 * Compare two codes without leaking where they differ.
 *
 * Both are the same length by construction here — the caller has already checked the digit
 * count — but the length guard stays, because `timingSafeEqual` throws on a mismatch and a
 * thrown error at this point would be a much louder oracle than the one being avoided.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
