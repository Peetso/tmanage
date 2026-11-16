'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  a11yPreferencesQueryKey,
  getAccessibilityPreferences,
} from '../../lib/api/a11y-preferences';
import type { A11yAudience } from '../../lib/api/a11y-preferences';
import { getDisplayPreferences } from '../../lib/api/display-preferences';
import { applyA11yPreferences } from '../../lib/a11y-shell';
import { displayFormat } from '../../lib/i18n/display-format';
import { activeLocale } from '../../lib/i18n/locale-store';
import { applyDensity, applyTheme } from '../../lib/theme';

/**
 * Applies the member's saved theme, density and language inside a workspace. Shares its query key with
 * `DisplayPreferencesView`, so a save there re-applies here at once. Renders nothing.
 *
 * x183: the saved text size, contrast and reduced motion too (query key shared with
 * `AccessibilityScreen`), on every workspace page rather than only after the settings screen; the
 * boot script has already painted the cached copy, so this only reconciles it with the server.
 *
 * R25 A6: a signed-in member's language is their saved preference, not whatever the
 * `tmanage_locale` cookie or a visit to a public `/ar` page left behind. When the preference
 * loads it is published to the active-locale store, which also re-writes the cookie and the
 * cached locale, so the next load boots in the saved language. Signed-out pages never mount
 * this, so they keep the cookie behaviour (and the sign-in switch, R24 A5).
 *
 * PORTALA11Y: the client portal mounts it with `audience="client"`. A client has no member display
 * row (theme and language stay the boot script's cached copy and the cookie), so only their own
 * accessibility settings are read, from the portal route.
 */
export function ThemeSync({
  organizationSlug,
  audience = 'member',
}: {
  organizationSlug: string;
  audience?: A11yAudience;
}) {
  const preferences = useQuery({
    queryKey: ['display-preferences', organizationSlug],
    queryFn: () => getDisplayPreferences(browserApiClient(), organizationSlug),
    staleTime: 5 * 60_000,
    enabled: audience === 'member',
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
  const a11y = useQuery({
    queryKey: a11yPreferencesQueryKey(organizationSlug, audience),
    queryFn: () => getAccessibilityPreferences(browserApiClient(), organizationSlug, audience),
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    if (a11y.data) applyA11yPreferences(a11y.data);
  }, [a11y.data]);
  return null;
}
