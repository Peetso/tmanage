/**
 * Where a sign-up came from (ADTRACK, 2026-11-16): the four `utm_*` values of the public landing
 * address, stored on the organization when its owner signs up. The values are labels for the
 * platform operator's report only: nothing decides anything on them. A value is kept only if it
 * is 1–100 characters of `[A-Za-z0-9_.-]`; anything else is dropped, never repaired.
 *
 * NOCOOKIE (2026-11-20, manager decision): the values travel in the address, never in a cookie
 * or browser storage. A marketing page copies the `utm_*` values of its own address onto its
 * sign-up links; the sign-up form reads them from its own address and sends them in the sign-up
 * request (`attribution`). Both ends go through {@link parseSignupAttribution}, so the API never
 * trusts what the browser sends. The old `tm_signup_source` cookie is only expired
 * ({@link LEGACY_SIGNUP_ATTRIBUTION_COOKIE}); nothing reads it. ePrivacy Directive art. 5(3):
 * a cookie for attribution is not strictly necessary (Art. 29 WP Opinion 04/2012, WP194 §4).
 */
export const SIGNUP_ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
] as const;

export type SignupAttributionKey = (typeof SIGNUP_ATTRIBUTION_KEYS)[number];

/**
 * The stored attribution. `referrer_host` is the organization column of the same name, written by
 * the cookie era (SEOD, 2026-11-17); since NOCOOKIE nothing produces it, and old rows keep theirs.
 */
export type SignupAttribution = Readonly<
  Partial<Record<SignupAttributionKey | 'referrer_host', string>>
>;

/** The retired attribution cookie: the web expires it (Max-Age=0) when a browser still sends it. */
export const LEGACY_SIGNUP_ATTRIBUTION_COOKIE = 'tm_signup_source';

export const SIGNUP_ATTRIBUTION_MAX_LENGTH = 100;

const VALUE_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * The valid `utm_*` values `read` returns (a `URLSearchParams.get`, say), or `undefined` when
 * none is valid.
 */
export function parseSignupAttribution(
  read: (key: SignupAttributionKey) => string | null | undefined,
): SignupAttribution | undefined {
  const entries = SIGNUP_ATTRIBUTION_KEYS.flatMap((key) => {
    const value = read(key);
    return typeof value === 'string' && VALUE_PATTERN.test(value) ? [[key, value] as const] : [];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * The attribution in an untrusted request body field (`{ utm_source: 'facebook', … }`), validated
 * again, or `undefined` when it is not an object or holds no valid value. Other keys are ignored.
 */
export function signupAttributionFromInput(value: unknown): SignupAttribution | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return parseSignupAttribution((key) => {
    const field = Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
    return typeof field === 'string' ? field : undefined;
  });
}
