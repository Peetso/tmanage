/**
 * Where a sign-up came from (ADTRACK, 2026-11-16): the four `utm_*` values of the public landing
 * address, kept first-party in a cookie by the web proxy and stored on the organization when its
 * owner signs up. The web proxy (writing the cookie) and the API (reading it back) both go
 * through {@link parseSignupAttribution}, so the API never trusts what the cookie holds.
 *
 * The values are labels for the platform operator's report only: nothing decides anything on
 * them. A value is kept only if it is 1–100 characters of `[A-Za-z0-9_.-]`; anything else is
 * dropped, never repaired.
 *
 * SEOD (B11, 2026-11-17): the landing's referring site rides along as `referrer_host` — the HOST
 * only (`chatgpt.com`), never the address, path or query, taken from the `Referer` header by
 * {@link signupReferrerHost} and validated again by {@link signupAttributionFromCookie}.
 */
export const SIGNUP_ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
] as const;

export type SignupAttributionKey = (typeof SIGNUP_ATTRIBUTION_KEYS)[number];

export type SignupAttribution = Readonly<
  Partial<Record<SignupAttributionKey | 'referrer_host', string>>
>;

/** Everything the cookie may hold: the `utm_*` keys, then the referring host. */
const COOKIE_FIELDS = [...SIGNUP_ATTRIBUTION_KEYS, 'referrer_host'] as const;

/** The first-party cookie the web proxy writes and the sign-up endpoint reads. */
export const SIGNUP_ATTRIBUTION_COOKIE = 'tm_signup_source';

/** Thirty days, in seconds. */
export const SIGNUP_ATTRIBUTION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const SIGNUP_ATTRIBUTION_MAX_LENGTH = 100;

const VALUE_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** The longest DNS name. */
export const SIGNUP_REFERRER_HOST_MAX_LENGTH = 253;

/**
 * Lower-case DNS labels with at least one dot and a top-level label that starts with a letter:
 * no port, no user info, no IP address (v4 or v6), no `localhost`.
 */
const HOST_PATTERN = /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/;

function validHost(value: string | null | undefined): string | undefined {
  return typeof value === 'string' &&
    value.length <= SIGNUP_REFERRER_HOST_MAX_LENGTH &&
    HOST_PATTERN.test(value)
    ? value
    : undefined;
}

/**
 * The referring site's host from an untrusted `Referer` header, or `undefined` when there is
 * none, it is not an http(s) address, the host is not a plain DNS name, or it is the site itself
 * (`ownHosts`, or a subdomain of one): moving between our own pages is not a source.
 */
export function signupReferrerHost(
  referer: string | null | undefined,
  ownHosts: readonly string[],
): string | undefined {
  if (typeof referer !== 'string' || referer.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const own = ownHosts.some((ownHost) => host === ownHost || host.endsWith(`.${ownHost}`));
  return own ? undefined : validHost(host);
}

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
    COOKIE_FIELDS.flatMap((key) => {
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
  const utm = parseSignupAttribution((key) => params.get(key));
  const referrerHost = validHost(params.get('referrer_host'));
  return referrerHost === undefined ? utm : { ...utm, referrer_host: referrerHost };
}
