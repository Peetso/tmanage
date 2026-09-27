'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getPreferences, updatePreferences } from '../../lib/api/preferences';
import type {
  DensityPreference,
  PreferenceLocale,
  ThemePreference,
  UserPreferencesView,
} from '../../lib/api/preferences';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface PreferencesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const THEMES: readonly { id: ThemePreference; label: string }[] = [
  { id: 'system', label: 'Match my device' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

const DENSITIES: readonly { id: DensityPreference; label: string }[] = [
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'compact', label: 'Compact' },
];

const LOCALES: readonly { id: PreferenceLocale; label: string }[] = [
  { id: 'en', label: 'English (US)' },
  { id: 'en-GB', label: 'English (UK)' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
];

/**
 * **Preferences & accessibility (x182, module 20).**
 *
 * `38-MODULE-MAP` §Preferences & accessibility (module 20): the appearance/locale surface the audit
 * named absent, distinct from the notification preferences already built. This screen reads the
 * acting member's own settings (`GET .../me/preferences`, behind `work.read`, taking no membership id
 * — the settings are always the caller's own) and replaces them in full (`PUT .../me/preferences`).
 *
 * Two decisions, both from the sibling form screens:
 *
 * 1. **Authorization is the API's.** A caller without the capability gets the ordinary refusal, which
 *    `describeError()` turns into a sentence; the screen never guesses a capability and never renders
 *    blank on a refusal.
 * 2. **The form is a faithful editor of the server's row.** It seeds from the read, sends every
 *    setting on save, and shows the persisted response — it stores no rule the API does not.
 */
export function PreferencesScreen({
  organizationSlug,
  organizationName,
  client,
}: PreferencesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['preferences', organizationSlug];

  const preferences = useQuery({
    queryKey,
    queryFn: () => getPreferences(api, organizationSlug),
  });

  const [theme, setTheme] = useState<ThemePreference>('system');
  const [locale, setLocale] = useState<PreferenceLocale>('en');
  const [density, setDensity] = useState<DensityPreference>('comfortable');

  // Seed the form from the server's row once it arrives. The read is the source of truth; the fields
  // follow it rather than the other way round.
  useEffect(() => {
    if (preferences.data) {
      setTheme(preferences.data.theme);
      setLocale(preferences.data.locale);
      setDensity(preferences.data.density);
    }
  }, [preferences.data]);

  const save = useMutation({
    mutationFn: (input: UserPreferencesView) => updatePreferences(api, organizationSlug, input),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate({ theme, locale, density });
  };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Preferences"
      description="How the app looks and reads for you, across every project."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-preferences-heading">
        <h2 id="tm-preferences-heading" className="tm-eyebrow">
          Appearance &amp; language
        </h2>

        {preferences.isError ? (
          <InlineAlert tone="danger" title="Could not load your preferences" live>
            {describeError(preferences.error)}
          </InlineAlert>
        ) : null}

        {preferences.isPending ? (
          <LoadingRegion label="Loading your preferences.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!preferences.isPending && !preferences.isError ? (
          <form className="tm-stack" onSubmit={onSubmit} aria-label="Appearance and language">
            <Select
              label="Theme"
              name="theme"
              value={theme}
              onChange={(event) => setTheme(event.target.value as ThemePreference)}
              hint="Match your device, or pick light or dark."
            >
              {THEMES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>

            <Select
              label="Language"
              name="locale"
              value={locale}
              onChange={(event) => setLocale(event.target.value as PreferenceLocale)}
              hint="The language the app is shown in."
            >
              {LOCALES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>

            <Select
              label="Density"
              name="density"
              value={density}
              onChange={(event) => setDensity(event.target.value as DensityPreference)}
              hint="How tightly the interface is spaced."
            >
              {DENSITIES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>

            {save.isError ? (
              <InlineAlert tone="danger" title="Could not save your preferences" live>
                {describeError(save.error)}
              </InlineAlert>
            ) : null}

            {save.isSuccess ? (
              <InlineAlert tone="success" title="Preferences saved" live>
                Your appearance and language settings are up to date.
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={save.isPending}
                loadingLabel="Saving"
              >
                Save preferences
              </Button>
            </div>
          </form>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped before your preferences loaded.';
  return 'Something went wrong with your preferences.';
}
