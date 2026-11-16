/**
 * Where a sign-up came from (ADTRACK, 2026-11-16): the four `utm_*` values of the public landing
 * address, kept first-party in a cookie by the web proxy and stored on the organization when its
 * owner signs up. The web proxy (writing the cookie) and the API (reading it back) both go
 * through {@link parseSignupAttribution}, so the API never trusts what the cookie holds.
 *
 * The values are labels for the platform operator's report only: nothing decides anything on
 * them. A value is kept only if it is 1–100 characters of `[A-Za-z0-9_.-]`; anything else is
 * dropped, never repaired.
 */
export const SIGNUP_ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
] as const;

export type SignupAttributionKey = (typeof SIGNUP_ATTRIBUTION_KEYS)[number];

export type SignupAttribution = Readonly<Partial<Record<SignupAttributionKey, string>>>;

/** The first-party cookie the web proxy writes and the sign-up endpoint reads. */
export const SIGNUP_ATTRIBUTION_COOKIE = 'tm_signup_source';

/** Thirty days, in seconds. */
export const SIGNUP_ATTRIBUTION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

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

/** The cookie value: the valid entries as a query string (`utm_source=facebook&...`). */
export function signupAttributionCookieValue(attribution: SignupAttribution): string {
  return new URLSearchParams(
    SIGNUP_ATTRIBUTION_KEYS.flatMap((key) => {
      const value = attribution[key];
      return value === undefined ? [] : [[key, value] as [string, string]];
    }),
  ).toString();
}

/** The attribution a cookie value holds, validated again, or `undefined`. */
export function signupAttributionFromCookie(
  value: string | undefined,
): SignupAttribution | undefined {
  if (value === undefined || value.length > 1024) return undefined;
  let decoded: string;
  try {
    // A cookie writer may percent-encode the `=` and `&`; no valid value holds a `%` itself.
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  const params = new URLSearchParams(decoded);
  return parseSignupAttribution((key) => params.get(key));
}
