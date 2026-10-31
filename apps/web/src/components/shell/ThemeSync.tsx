'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { browserApiClient } from '../../lib/api/browser-client';
import { getDisplayPreferences } from '../../lib/api/display-preferences';
import { applyTheme } from '../../lib/theme';

/**
 * Applies the member's saved theme inside a workspace. Shares its query key with
 * `DisplayPreferencesView`, so a save there re-applies here at once. Renders nothing.
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
  return null;
}
