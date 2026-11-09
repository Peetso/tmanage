'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { browserApiClient } from '../../lib/api/browser-client';
import { getDisplayPreferences } from '../../lib/api/display-preferences';
import { displayFormat } from '../../lib/i18n/display-format';
import { activeLocale } from '../../lib/i18n/locale-store';
import { applyDensity, applyTheme } from '../../lib/theme';

/**
 * Applies the member's saved theme, density and language inside a workspace. Shares its query key with
 * `DisplayPreferencesView`, so a save there re-applies here at once. Renders nothing.
 *
 * R25 A6: a signed-in member's language is their saved preference, not whatever the
 * `tmanage_locale` cookie or a visit to a public `/ar` page left behind. When the preference
 * loads it is published to the active-locale store, which also re-writes the cookie and the
 * cached locale, so the next load boots in the saved language. Signed-out pages never mount
 * this, so they keep the cookie behaviour (and the sign-in switch, R24 A5).
 */
export function ThemeSync({ organizationSlug }: { organizationSlug: string }) {
  const preferences = useQuery({
    queryKey: ['display-preferences', organizationSlug],
    queryFn: () => getDisplayPreferences(browserApiClient(), organizationSlug),
    staleTime: 5 * 60_000,
  });
  const theme = preferences.data?.theme;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);
  const density = preferences.data?.density;
  useEffect(() => {
    if (density) applyDensity(density);
  }, [density]);
  const locale = preferences.data?.locale;
  useEffect(() => {
    if (locale) activeLocale.set(locale);
  }, [locale]);
  // FIX5 item 6b (B-N7): the saved digits and date layout, for every shared formatter.
  const numerals = preferences.data?.numerals;
  const dateFormat = preferences.data?.dateFormat;
  useEffect(() => {
    if (numerals || dateFormat) displayFormat.set({ numerals, dateFormat });
  }, [numerals, dateFormat]);
  return null;
}
