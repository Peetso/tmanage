'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
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
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/preferences.css';

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
 * **Appearance (PREF-02; module 20 Preferences & accessibility, PREF-DISPLAY, x285).**
 *
 * PREF-02's frame: theme tiles, density capsules and a live sample to the right that follows the
 * choice. The member sets theme, density, locale, timezone and date format, reads them back
 * (defaults when never saved), and saves — persisted behind `work.read`, scoped to the caller's own
 * membership by the server. The sample is a picture of the settings, never project data: its dates
 * are written in the chosen format, its rows tighten with the chosen density.
 */
export function DisplayPreferencesView({
  organizationSlug,
  organizationName,
  client,
}: DisplayPreferencesViewProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();

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

  const sampleDates = useMemo(() => sampleDays(dateFormat), [dateFormat]);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow="Preferences · Appearance"
      title="Appearance"
      actions={
        <span className="tm-prefs-header-note">Applies to your account on every device</span>
      }
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
        <div className="tm-prefs tm-prefs--appearance">
          <div className="tm-prefs__main">
            <form
              className="tm-prefs-card"
              aria-label={t('displayPreferences.sectionDisplay')}
              onSubmit={(event) => {
                event.preventDefault();
                setSaved(false);
                save.mutate();
              }}
            >
              <fieldset className="tm-prefs-section">
                <legend className="tm-prefs-eyebrow">{t('displayPreferences.theme')}</legend>
                <div className="tm-prefs-tiles">
                  {DISPLAY_THEMES.map((value) => (
                    <label key={value} className="tm-prefs-tile">
                      <input
                        type="radio"
                        name="tm-display-theme"
                        value={value}
                        checked={theme === value}
                        onChange={() => setTheme(value)}
                      />
                      <span
                        className={`tm-prefs-thumb tm-prefs-thumb--${value}`}
                        aria-hidden="true"
                      />
                      {THEME_LABELS[value]}
                    </label>
                  ))}
                </div>
              </fieldset>

              <hr className="tm-prefs-rule" />

              <fieldset className="tm-prefs-section">
                <legend className="tm-prefs-eyebrow">{t('displayPreferences.density')}</legend>
                <div className="tm-prefs-choices">
                  {DISPLAY_DENSITIES.map((value) => (
                    <label key={value} className="tm-prefs-choice">
                      <input
                        type="radio"
                        name="tm-display-density"
                        value={value}
                        checked={density === value}
                        onChange={() => setDensity(value)}
                      />
                      {DENSITY_LABELS[value]}
                    </label>
                  ))}
                </div>
                <p className="tm-prefs-card__note">
                  Compact fits more rows on a work list. Comfortable is the default.
                </p>
              </fieldset>

              <hr className="tm-prefs-rule" />

              <div className="tm-prefs-fields">
                <div className="tm-prefs-field">
                  <label className="tm-prefs-field__label" htmlFor="tm-display-locale">
                    {t('displayPreferences.languageRegion')}
                  </label>
                  <select
                    id="tm-display-locale"
                    className="tm-prefs-field__control"
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

                <div className="tm-prefs-field">
                  <label className="tm-prefs-field__label" htmlFor="tm-display-timezone">
                    {t('displayPreferences.timezone')}
                  </label>
                  <select
                    id="tm-display-timezone"
                    className="tm-prefs-field__control"
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

                <div className="tm-prefs-field">
                  <label className="tm-prefs-field__label" htmlFor="tm-display-date-format">
                    {t('displayPreferences.dateFormat')}
                  </label>
                  <select
                    id="tm-display-date-format"
                    className="tm-prefs-field__control"
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
                <button
                  type="submit"
                  className="tm-prefs-capsule tm-prefs-capsule--ink"
                  disabled={save.isPending}
                >
                  {save.isPending ? t('displayPreferences.saving') : t('displayPreferences.save')}
                </button>
              </div>
            </form>
          </div>

          <aside className="tm-prefs__side" aria-labelledby="tm-display-sample-heading">
            <h2 id="tm-display-sample-heading" className="tm-prefs-eyebrow">
              Live sample · {DENSITY_LABELS[density]}, {THEME_LABELS[theme]}
            </h2>
            <div className="tm-prefs-sample" data-density={density} aria-hidden="true">
              <div className="tm-prefs-sample__head">Sample list · Work</div>
              <ul className="tm-prefs-sample__list">
                <li className="tm-prefs-sample__row tm-prefs-sample__row--current">
                  <span className="tm-prefs-dot tm-prefs-dot--lime" />
                  <span className="tm-prefs-sample__name">The item you are on now</span>
                  <span className="tm-prefs-sample__date">{sampleDates[0]}</span>
                </li>
                <li className="tm-prefs-sample__row">
                  <span className="tm-prefs-dot tm-prefs-dot--client" />
                  <span className="tm-prefs-sample__name">Waiting on a client approval</span>
                  <span className="tm-prefs-sample__date">26h</span>
                </li>
                <li className="tm-prefs-sample__row">
                  <span className="tm-prefs-dot tm-prefs-dot--warn" />
                  <span className="tm-prefs-sample__name">At risk of slipping</span>
                  <span className="tm-prefs-sample__date tm-prefs-sample__date--warn">
                    {sampleDates[1]}
                  </span>
                </li>
                <li className="tm-prefs-sample__row tm-prefs-sample__row--muted">
                  <span className="tm-prefs-dot tm-prefs-dot--empty" />
                  <span className="tm-prefs-sample__name">Not dated yet</span>
                  <span className="tm-prefs-sample__date">No date</span>
                </li>
                <li className="tm-prefs-sample__row tm-prefs-sample__row--muted">
                  <span className="tm-prefs-dot" />
                  <span className="tm-prefs-sample__name">Finished last week</span>
                  <span className="tm-prefs-sample__date">Done</span>
                </li>
              </ul>
            </div>
          </aside>
        </div>
      )}
    </AppShell>
  );
}

/** Two dates near today, written in the chosen format, for the live sample's date column. */
function sampleDays(format: DisplayDateFormat): readonly [string, string] {
  const today = new Date();
  const later = (days: number) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  return [formatSampleDate(later(2), format), formatSampleDate(later(21), format)];
}

function formatSampleDate(date: Date, format: DisplayDateFormat): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  switch (format) {
    case 'us':
      return `${mm}/${dd}/${yyyy}`;
    case 'eu':
      return `${dd}/${mm}/${yyyy}`;
    case 'long':
      return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    default:
      return `${yyyy}-${mm}-${dd}`;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
