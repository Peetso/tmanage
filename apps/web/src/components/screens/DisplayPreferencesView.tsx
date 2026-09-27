'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  DISPLAY_DATE_FORMATS,
  DISPLAY_DENSITIES,
  DISPLAY_LOCALES,
  DISPLAY_THEMES,
  DISPLAY_TIMEZONES,
  getDisplayPreferences,
  updateDisplayPreferences,
} from '../../lib/api/display-preferences';
import type {
  DisplayDateFormat,
  DisplayDensity,
  DisplayLocale,
  DisplayPreferencesView as DisplayPreferences,
  DisplayTheme,
  DisplayTimezone,
} from '../../lib/api/display-preferences';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface DisplayPreferencesViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The default an unsaved account reads by; the same values the API's `DEFAULT_DISPLAY_PREFERENCES` holds. */
const DEFAULTS: DisplayPreferences = {
  theme: 'system',
  density: 'comfortable',
  locale: 'en-US',
  timezone: 'UTC',
  dateFormat: 'iso',
};

const THEME_LABELS: Record<DisplayTheme, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'Match system',
};

const DENSITY_LABELS: Record<DisplayDensity, string> = {
  comfortable: 'Comfortable',
  compact: 'Compact',
};

const DATE_FORMAT_LABELS: Record<DisplayDateFormat, string> = {
  iso: 'ISO (2026-09-27)',
  us: 'US (09/27/2026)',
  eu: 'European (27/09/2026)',
  long: 'Long (27 Sep 2026)',
};

/**
 * **Unified display preferences hub (module 20 Preferences & accessibility, PREF-DISPLAY, x285).**
 *
 * `22-SCREEN` PRF preferences hub; `42-INTERACTION` §theme/density/RTL; `38-MODULE-MAP` §Preferences.
 * The audit found display settings scattered or absent; this is the one place a member sets theme,
 * density, locale, timezone and date format, reads them back (defaults when never saved), and saves
 * — persisted behind `work.read`, scoped to the caller's own membership by the server. It links out
 * to the notification, accessibility and quiet-hours preferences rather than re-implementing them.
 */
export function DisplayPreferencesView({
  organizationSlug,
  organizationName,
  client,
}: DisplayPreferencesViewProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const preferences = useQuery({
    queryKey: ['display-preferences', organizationSlug],
    queryFn: () => getDisplayPreferences(api, organizationSlug),
  });

  const [theme, setTheme] = useState<DisplayTheme>(DEFAULTS.theme);
  const [density, setDensity] = useState<DisplayDensity>(DEFAULTS.density);
  const [locale, setLocale] = useState<DisplayLocale>(DEFAULTS.locale);
  const [timezone, setTimezone] = useState<DisplayTimezone>(DEFAULTS.timezone);
  const [dateFormat, setDateFormat] = useState<DisplayDateFormat>(DEFAULTS.dateFormat);
  const [saved, setSaved] = useState(false);

  // When the server's settings load (or change), seed the form from them.
  useEffect(() => {
    if (!preferences.data) return;
    setTheme(preferences.data.theme);
    setDensity(preferences.data.density);
    setLocale(preferences.data.locale);
    setTimezone(preferences.data.timezone);
    setDateFormat(preferences.data.dateFormat);
  }, [preferences.data]);

  const save = useMutation({
    mutationFn: (): Promise<DisplayPreferences> =>
      updateDisplayPreferences(api, organizationSlug, {
        theme,
        density,
        locale,
        timezone,
        dateFormat,
      }),
    onSuccess: (result) => {
      queries.setQueryData(['display-preferences', organizationSlug], result);
      setSaved(true);
    },
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Display preferences"
      description="Theme, density, locale, timezone and date format — saved to your account for this studio."
    >
      {preferences.isPending ? (
        <LoadingRegion label="Loading your display preferences">
          <Skeleton />
        </LoadingRegion>
      ) : preferences.isError ? (
        <InlineAlert tone="danger" title="We could not load your display preferences">
          {errorMessage(preferences.error)}
        </InlineAlert>
      ) : (
        <form
          className="tm-panel tm-stack"
          aria-labelledby="tm-display-heading"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            save.mutate();
          }}
        >
          <h2 id="tm-display-heading" className="tm-eyebrow">
            Display
          </h2>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-display-theme">
              Theme
            </label>
            <select
              id="tm-display-theme"
              className="tm-field__control"
              value={theme}
              onChange={(event) => setTheme(event.target.value as DisplayTheme)}
            >
              {DISPLAY_THEMES.map((value) => (
                <option key={value} value={value}>
                  {THEME_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-display-density">
              Density
            </label>
            <select
              id="tm-display-density"
              className="tm-field__control"
              value={density}
              onChange={(event) => setDensity(event.target.value as DisplayDensity)}
            >
              {DISPLAY_DENSITIES.map((value) => (
                <option key={value} value={value}>
                  {DENSITY_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-display-locale">
              Language & region
            </label>
            <select
              id="tm-display-locale"
              className="tm-field__control"
              value={locale}
              onChange={(event) => setLocale(event.target.value as DisplayLocale)}
            >
              {DISPLAY_LOCALES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-display-timezone">
              Timezone
            </label>
            <select
              id="tm-display-timezone"
              className="tm-field__control"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value as DisplayTimezone)}
            >
              {DISPLAY_TIMEZONES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-display-date-format">
              Date format
            </label>
            <select
              id="tm-display-date-format"
              className="tm-field__control"
              value={dateFormat}
              onChange={(event) => setDateFormat(event.target.value as DisplayDateFormat)}
            >
              {DISPLAY_DATE_FORMATS.map((value) => (
                <option key={value} value={value}>
                  {DATE_FORMAT_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          {save.isError ? (
            <InlineAlert tone="danger" title="We could not save your preferences">
              {errorMessage(save.error)}
            </InlineAlert>
          ) : null}

          {saved && !save.isPending && !save.isError ? (
            <InlineAlert tone="success" title="Saved">
              Your display preferences have been saved.
            </InlineAlert>
          ) : null}

          <div>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save preferences'}
            </Button>
          </div>
        </form>
      )}

      <nav className="tm-panel tm-stack" aria-labelledby="tm-display-related-heading">
        <h2 id="tm-display-related-heading" className="tm-eyebrow">
          Other preferences
        </h2>
        <ul>
          <li>
            <Link href={`/${organizationSlug}/settings/accessibility`}>
              Accessibility (font size, reduced motion, high contrast)
            </Link>
          </li>
          <li>
            <Link href={`/${organizationSlug}/inbox/notification-preferences`}>
              Notification preferences
            </Link>
          </li>
          <li>
            <Link href={`/${organizationSlug}/settings/quiet-hours`}>Quiet hours</Link>
          </li>
        </ul>
      </nav>
    </AppShell>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
