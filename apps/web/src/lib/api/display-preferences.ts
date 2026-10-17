import type { ApiClient } from './client';

/**
 * PREF-DISPLAY display preferences (module 20, x285) — the caller's own theme / density / locale /
 * timezone / date-format settings, read and replaced. Behind `work.read` on the server (the
 * internal-read capability the accessibility preferences reuse); a caller without it gets the ordinary 403
 * the shared client turns into an error. The tenant is the slug in the path resolved against the
 * caller's membership, and the *member* is the authenticated principal — never a value this client
 * supplies — so it can only ever read or write the caller's own row.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and the vocabularies below are the exact
 * closed allowlists the API validates against (`display-prefs.service.ts`), so the two shapes cannot
 * drift.
 */

/** Colour mode; `system` follows the OS and is the default. */
export const DISPLAY_THEMES = ['light', 'dark', 'system'] as const;
export type DisplayTheme = (typeof DISPLAY_THEMES)[number];

/** Row spacing; `comfortable` is the default. */
export const DISPLAY_DENSITIES = ['comfortable', 'compact'] as const;
export type DisplayDensity = (typeof DISPLAY_DENSITIES)[number];

/**
 * BCP-47 locale allowlist; `en-US` is the default. `ar-EG` is the one right-to-left locale
 * (02-UX-UI §Localization), so adding it is what makes Arabic reachable at all. This list is the
 * exact mirror of the server's `DISPLAY_LOCALES` (`schema.ts`): a locale the UI offers that the
 * API would reject on save is a broken option, so the two must move together.
 */
export const DISPLAY_LOCALES = [
  'en-US',
  'en-GB',
  'fr-FR',
  'de-DE',
  'es-ES',
  'pt-BR',
  'ja-JP',
  'zh-CN',
  'ar-EG',
] as const;
export type DisplayLocale = (typeof DISPLAY_LOCALES)[number];

/** IANA timezone allowlist; `UTC` is the default. */
export const DISPLAY_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Australia/Sydney',
] as const;
export type DisplayTimezone = (typeof DISPLAY_TIMEZONES)[number];

/** Named date layouts; `iso` is the default. */
export const DISPLAY_DATE_FORMATS = ['iso', 'us', 'eu', 'long'] as const;
export type DisplayDateFormat = (typeof DISPLAY_DATE_FORMATS)[number];

/** The five display settings the GET/PUT route exchanges. Paired Exact with the API view. */
export interface DisplayPreferencesView {
  readonly theme: DisplayTheme;
  readonly density: DisplayDensity;
  readonly locale: DisplayLocale;
  readonly timezone: DisplayTimezone;
  readonly dateFormat: DisplayDateFormat;
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/me/display-preferences`;
}

export async function getDisplayPreferences(
  client: ApiClient,
  organizationSlug: string,
): Promise<DisplayPreferencesView> {
  const { data } = await client.request<DisplayPreferencesView>({ path: path(organizationSlug) });
  return data;
}

export async function updateDisplayPreferences(
  client: ApiClient,
  organizationSlug: string,
  settings: DisplayPreferencesView,
): Promise<DisplayPreferencesView> {
  const { data } = await client.request<DisplayPreferencesView>({
    method: 'PUT',
    path: path(organizationSlug),
    body: settings,
  });
  return data;
}
