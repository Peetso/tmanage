import type { DictationLanguageTag } from '@tmanage/domain';
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
  // Slice 54-21: Urdu, the second right-to-left locale (mirrors the API's `DISPLAY_LOCALES`).
  'ur-PK',
] as const;
export type DisplayLocale = (typeof DISPLAY_LOCALES)[number];

/**
 * Any IANA time zone (R9: every country); `UTC` is the default. The picker offers the full list
 * (`lib/time-zones.ts`) and the API checks the name is a real zone.
 */
export type DisplayTimezone = string;

/** Named date layouts; `iso` is the default. */
export const DISPLAY_DATE_FORMATS = ['iso', 'us', 'eu', 'long'] as const;
export type DisplayDateFormat = (typeof DISPLAY_DATE_FORMATS)[number];

/** Digit shapes (55-07); `latin` is the default. */
export const DISPLAY_NUMERALS = ['latin', 'arabic_indic'] as const;
export type DisplayNumerals = (typeof DISPLAY_NUMERALS)[number];

/** Simple / Power shell mode (55-04). */
export const DISPLAY_UI_MODES = ['simple', 'power'] as const;
export type DisplayUiMode = (typeof DISPLAY_UI_MODES)[number];

/** C24: the first day of the week; `monday` is the default. Mirrors the API's `DISPLAY_WEEK_STARTS`. */
export const DISPLAY_WEEK_STARTS = ['monday', 'sunday', 'saturday'] as const;
export type DisplayWeekStart = (typeof DISPLAY_WEEK_STARTS)[number];

/** The five display settings the GET/PUT route exchanges. Paired Exact with the API view. */
export interface DisplayPreferencesView {
  readonly theme: DisplayTheme;
  readonly density: DisplayDensity;
  readonly locale: DisplayLocale;
  readonly timezone: DisplayTimezone;
  readonly dateFormat: DisplayDateFormat;
  /** 55-07 (R18-d): digit shapes; a row saved before 55-07 reads as `latin`. */
  readonly numerals: DisplayNumerals;
  /** 55-07 (R18-d): the calendar shown beside dates (display-only); defaults to `gregorian`. */
  readonly calendarDisplay: 'gregorian' | 'gregorian_hijri';
  /** C24: the first day of the week; the API reads an unsaved value as `monday`. */
  readonly weekStart: DisplayWeekStart;
  /**
   * AI panel (2026-11-23): the voice-dictation language (BCP-47, one of the domain's 17), or
   * `null` = the app language. A PUT without it keeps the stored choice.
   */
  readonly dictationLanguage: DictationLanguageTag | null;
  /** 55-04 (R20-c): the effective shell mode — the member's own, else (or when locked) the org default. */
  readonly uiMode: DisplayUiMode;
  readonly uiModeSource: 'self' | 'org_default';
  /** 55-04 (R20-c): the caller's role is locked to the org default; the screen hides the switch. */
  readonly uiModeLocked: boolean;
}

/**
 * The PUT body: the stored settings without the computed 55-04 fields. `uiMode` is the member's own
 * choice; leaving it out means "inherit the org default".
 */
export type DisplayPreferencesUpdate = Omit<
  DisplayPreferencesView,
  'uiMode' | 'uiModeSource' | 'uiModeLocked' | 'dictationLanguage'
> & {
  readonly uiMode?: DisplayPreferencesView['uiMode'];
  /** Sent only when the member changes it; left out, the stored choice is kept. */
  readonly dictationLanguage?: DisplayPreferencesView['dictationLanguage'];
};

/**
 * The PUT body for a full record: only the stored settings, never the computed `uiModeSource` /
 * `uiModeLocked` (the API rejects an unknown field with 400 "display preferences are invalid"), and
 * `uiMode` only when it is the member's own choice — an inherited mode stays inherited.
 */
export function toDisplayPreferencesUpdate(
  view: DisplayPreferencesView | DisplayPreferencesUpdate,
): DisplayPreferencesUpdate {
  const ownMode = !('uiModeSource' in view) || view.uiModeSource === 'self';
  return {
    theme: view.theme,
    density: view.density,
    locale: view.locale,
    timezone: view.timezone,
    dateFormat: view.dateFormat,
    numerals: view.numerals,
    calendarDisplay: view.calendarDisplay,
    weekStart: view.weekStart,
    ...(ownMode && view.uiMode !== undefined ? { uiMode: view.uiMode } : {}),
    // A fetched view's choice is never echoed back: only an explicit update sends it.
    ...(!('uiModeSource' in view) && view.dictationLanguage !== undefined
      ? { dictationLanguage: view.dictationLanguage }
      : {}),
  };
}

/** The PUT that changes only the dictation language, from the member's current settings. */
export function withDictationLanguage(
  current: DisplayPreferencesView,
  dictationLanguage: DictationLanguageTag | null,
): DisplayPreferencesUpdate {
  return { ...toDisplayPreferencesUpdate(current), dictationLanguage };
}

/** The query key every reader of the member's display preferences shares. */
export function displayPreferencesKey(organizationSlug: string): readonly string[] {
  return ['display-preferences', organizationSlug];
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
  settings: DisplayPreferencesUpdate,
): Promise<DisplayPreferencesView> {
  const { data } = await client.request<DisplayPreferencesView>({
    method: 'PUT',
    path: path(organizationSlug),
    // Re-built field by field so a caller that spreads a fetched view cannot send read-only fields.
    body: toDisplayPreferencesUpdate(settings),
  });
  return data;
}
