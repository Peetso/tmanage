import type { ApiClient } from './client';
import {
  getDisplayPreferences,
  toDisplayPreferencesUpdate,
  updateDisplayPreferences,
  type DisplayLocale,
  type DisplayPreferencesView,
  type DisplayTimezone,
} from './display-preferences';

/**
 * Appearance & accessibility preferences (x182, module 20) — the acting member's own appearance and
 * locale settings, read and replaced.
 *
 * Behind `work.read` on the API and taking no membership id: the settings are always the acting
 * member's own, never a field this client supplies. The PUT is a full replacement — the form sends
 * every setting — and the server checks each against a closed allowlist, so an off-list value is a
 * 400 rather than a stored value nothing renders. Distinct from the notification preferences
 * (delivery channels); this is the appearance/locale surface.
 */

/** The theme the member reads the app in. `system` follows the device. */
export type ThemePreference = 'system' | 'light' | 'dark';

/** The density of the internal shell. */
export type DensityPreference = 'comfortable' | 'compact';

/** The locales the app is translated for — a closed allowlist mirrored from the API. */
export type PreferenceLocale = 'en' | 'en-GB' | 'fr' | 'de' | 'es';

/** The settings the GET/PUT exchanges. The one projection the API↔web pairing covers. */
export interface UserPreferencesView {
  readonly theme: ThemePreference;
  readonly locale: PreferenceLocale;
  readonly density: DensityPreference;
}

export async function getPreferences(
  client: ApiClient,
  organizationSlug: string,
): Promise<UserPreferencesView> {
  const { data } = await client.request<UserPreferencesView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/me/preferences`,
  });
  return data;
}

export async function updatePreferences(
  client: ApiClient,
  organizationSlug: string,
  input: UserPreferencesView,
): Promise<UserPreferencesView> {
  const { data } = await client.request<UserPreferencesView>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/me/preferences`,
    body: input,
  });
  return data;
}

// ── The one app-wide language setting, and the time zone (t2-b) ─────────────────────────────────
//
// The language the whole app (emails included) speaks is the display preference's `locale`, the
// value the active-locale store and `dir` follow — the appearance allowlist above has no Arabic.
// So the profile page reads and writes `me/display-preferences`, changing only the locale and the
// time zone and sending every other display setting back unchanged (the PUT is a full replacement).

/** The two languages the app is translated into. */
export type AppLanguage = 'en' | 'ar';

/** The language a display locale belongs to: Arabic for `ar-*`, English otherwise. */
export function languageOfLocale(locale: DisplayLocale): AppLanguage {
  return locale.startsWith('ar') ? 'ar' : 'en';
}

/** The locale to store for a chosen language, keeping an English variant the member already has. */
export function localeForLanguage(language: AppLanguage, current: DisplayLocale): DisplayLocale {
  if (language === 'ar') return 'ar-EG';
  return current.startsWith('en') ? current : 'en-US';
}

export function getLanguageAndTimezone(
  client: ApiClient,
  organizationSlug: string,
): Promise<DisplayPreferencesView> {
  return getDisplayPreferences(client, organizationSlug);
}

export function saveLanguageAndTimezone(
  client: ApiClient,
  organizationSlug: string,
  current: DisplayPreferencesView,
  choice: { readonly language: AppLanguage; readonly timezone: DisplayTimezone },
): Promise<DisplayPreferencesView> {
  return updateDisplayPreferences(client, organizationSlug, {
    ...toDisplayPreferencesUpdate(current),
    locale: localeForLanguage(choice.language, current.locale),
    timezone: choice.timezone,
  });
}
