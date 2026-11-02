'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  DISPLAY_DATE_FORMATS,
  DISPLAY_DENSITIES,
  DISPLAY_THEMES,
  getDisplayPreferences,
  updateDisplayPreferences,
} from '../../lib/api/display-preferences';
import { applyDensity, applyTheme } from '../../lib/theme';
import { TimeZoneSelect } from '../TimeZoneSelect';
import type {
  DisplayDateFormat,
  DisplayDensity,
  DisplayLocale,
  DisplayPreferencesView as DisplayPreferences,
  DisplayTheme,
  DisplayTimezone,
} from '../../lib/api/display-preferences';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { activeLocale } from '../../lib/i18n/locale-store';
import {
  OFFERED_LOCALES,
  isBetaLocale,
  localeLangAttribute,
  localeNativeName,
} from '../../lib/i18n/catalog-status';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
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
  numerals: 'latin',
  calendarDisplay: 'gregorian',
  uiMode: 'simple',
  uiModeSource: 'org_default',
  uiModeLocked: false,
};

/**
 * The page's own strings, English first. The keys reach the catalogs with lane 13's i18n fragment;
 * until then (and in tests) a key the catalog lacks reads as its English line, never as the key.
 */
const EN = {
  'DisplayPreferencesView.eyebrow': 'Preferences · Appearance',
  'DisplayPreferencesView.title': 'Appearance',
  'DisplayPreferencesView.headerNote': 'Applies to your account on every device',
  'DisplayPreferencesView.loading': 'Loading your display preferences',
  'DisplayPreferencesView.loadError': 'We could not load your display preferences',
  'DisplayPreferencesView.themeLight': 'Light',
  'DisplayPreferencesView.themeDark': 'Dark',
  'DisplayPreferencesView.themeSystem': 'Match system',
  'DisplayPreferencesView.densityComfortable': 'Comfortable',
  'DisplayPreferencesView.densityCompact': 'Compact',
  'DisplayPreferencesView.densityNote':
    'Compact fits more rows on a work list. Comfortable is the default.',
  'DisplayPreferencesView.dateIso': 'ISO',
  'DisplayPreferencesView.dateUs': 'US',
  'DisplayPreferencesView.dateEu': 'European',
  'DisplayPreferencesView.dateLong': 'Long',
  'DisplayPreferencesView.saveError': 'We could not save your preferences',
  'DisplayPreferencesView.savedTitle': 'Saved',
  'DisplayPreferencesView.savedBody': 'Your display preferences have been saved.',
  'DisplayPreferencesView.sampleHeading': 'Live sample',
  'DisplayPreferencesView.sampleHead': 'Sample list · Work',
  'DisplayPreferencesView.sampleCurrent': 'The item you are on now',
  'DisplayPreferencesView.sampleClient': 'Waiting on a client approval',
  'DisplayPreferencesView.sampleRisk': 'At risk of slipping',
  'DisplayPreferencesView.sampleUndated': 'Not dated yet',
  'DisplayPreferencesView.sampleFinished': 'Finished last week',
  'DisplayPreferencesView.sampleHours': '26h',
  'DisplayPreferencesView.noDate': 'No date',
  'DisplayPreferencesView.done': 'Done',
} as const;

type AppearanceKey = keyof typeof EN;

const THEME_LABELS: Record<DisplayTheme, AppearanceKey> = {
  light: 'DisplayPreferencesView.themeLight',
  dark: 'DisplayPreferencesView.themeDark',
  system: 'DisplayPreferencesView.themeSystem',
};

const DENSITY_LABELS: Record<DisplayDensity, AppearanceKey> = {
  comfortable: 'DisplayPreferencesView.densityComfortable',
  compact: 'DisplayPreferencesView.densityCompact',
};

/** The format's name, then a fixed sample date written in it (digits are not translated). */
const DATE_FORMAT_LABELS: Record<DisplayDateFormat, readonly [AppearanceKey, string]> = {
  iso: ['DisplayPreferencesView.dateIso', '2026-09-27'],
  us: ['DisplayPreferencesView.dateUs', '09/27/2026'],
  eu: ['DisplayPreferencesView.dateEu', '27/09/2026'],
  long: ['DisplayPreferencesView.dateLong', '27 Sep 2026'],
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
  const errorMessage = useDescribeApiError(OFFLINE_LINES);
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();
  const tr = (key: AppearanceKey): string => {
    const line = t(key as string as MessageKey);
    return line === key ? EN[key] : line;
  };

  const preferences = useQuery({
    queryKey: ['display-preferences', organizationSlug],
    queryFn: () => getDisplayPreferences(api, organizationSlug),
  });

  // The form shows the member's unsaved choice when there is one, else the saved value, read
  // straight from the loaded record: the first paint after a reload already shows the saved theme
  // (seeding by effect painted "Match system" for a moment before the saved "Dark").
  const stored = preferences.data ?? DEFAULTS;
  const [themeDraft, setTheme] = useState<DisplayTheme | null>(null);
  const [densityDraft, setDensity] = useState<DisplayDensity | null>(null);
  const [timezoneDraft, setTimezone] = useState<DisplayTimezone | null>(null);
  const [dateFormatDraft, setDateFormat] = useState<DisplayDateFormat | null>(null);
  const [localeDraft, setLocale] = useState<DisplayLocale | null>(null);
  const theme = themeDraft ?? stored.theme;
  const density = densityDraft ?? stored.density;
  // R12 R2 (Figma "Languages (R2)" 501:29247): the language is picked here too, from the offered
  // list; a saved hidden locale (ja-JP) stays selectable so a save never changes it by accident.
  const locale = localeDraft ?? stored.locale;
  const localeChoices: readonly DisplayLocale[] = (
    OFFERED_LOCALES as readonly DisplayLocale[]
  ).concat(OFFERED_LOCALES.some((value) => value === stored.locale) ? [] : [stored.locale]);
  const timezone = timezoneDraft ?? stored.timezone;
  const dateFormat = dateFormatDraft ?? stored.dateFormat;
  const [saved, setSaved] = useState(false);

  // Publish the saved locale to the active-locale store so the shell's `dir`/`lang` and every
  // `Intl` formatter match the account the moment this screen is opened, not only after a save
  // (ACT-03). It persists to `localStorage`, so the direction also survives a reload.
  useEffect(() => {
    if (preferences.data) activeLocale.set(preferences.data.locale);
  }, [preferences.data]);

  const save = useMutation({
    mutationFn: (): Promise<DisplayPreferences> =>
      updateDisplayPreferences(api, organizationSlug, {
        theme,
        density,
        locale,
        timezone,
        dateFormat,
        // 55-07: not edited on this screen yet, so the stored values are sent back unchanged.
        numerals: stored.numerals,
        calendarDisplay: stored.calendarDisplay,
        // 55-04: keep the member's own mode; an inherited mode is left out so it stays inherited.
        ...(stored.uiModeSource === 'self' ? { uiMode: stored.uiMode } : {}),
      }),
    onSuccess: (result) => {
      queries.setQueryData(['display-preferences', organizationSlug], result);
      setLocale(null);
      // Apply the saved language to the whole app at once (ACT-03): the store flips the document's
      // direction and re-binds the formatters, so Arabic reads right-to-left immediately without a
      // reload rather than only taking effect on the marketing site.
      activeLocale.set(result.locale);
      applyTheme(result.theme);
      applyDensity(result.density);
      setSaved(true);
    },
  });

  const sampleDates = useMemo(() => sampleDays(dateFormat), [dateFormat]);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={tr('DisplayPreferencesView.eyebrow')}
      title={tr('DisplayPreferencesView.title')}
      actions={
        <span className="tm-prefs-header-note">{tr('DisplayPreferencesView.headerNote')}</span>
      }
    >
      {preferences.isPending ? (
        <LoadingRegion label={tr('DisplayPreferencesView.loading')}>
          <Skeleton />
        </LoadingRegion>
      ) : preferences.isError ? (
        <InlineAlert tone="danger" title={tr('DisplayPreferencesView.loadError')}>
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
                      {tr(THEME_LABELS[value])}
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
                      {tr(DENSITY_LABELS[value])}
                    </label>
                  ))}
                </div>
                <p className="tm-prefs-card__note">{tr('DisplayPreferencesView.densityNote')}</p>
              </fieldset>

              <hr className="tm-prefs-rule" />

              <div className="tm-prefs-fields">
                <TimeZoneSelect
                  className="tm-prefs-field"
                  label={t('displayPreferences.timezone')}
                  value={timezone}
                  onChange={setTimezone}
                />

                <div className="tm-prefs-field">
                  <label className="tm-prefs-field__label" htmlFor="tm-display-locale">
                    {t('LanguagePicker.label')}
                  </label>
                  <select
                    id="tm-display-locale"
                    className="tm-prefs-field__control"
                    value={locale}
                    onChange={(event) => {
                      setSaved(false);
                      setLocale(event.target.value as DisplayLocale);
                    }}
                  >
                    {localeChoices.map((value) => (
                      <option key={value} value={value} lang={localeLangAttribute(value)}>
                        {isBetaLocale(value)
                          ? `${localeNativeName(value)} · ${t('LanguagePicker.beta')}`
                          : localeNativeName(value)}
                      </option>
                    ))}
                  </select>
                  {isBetaLocale(locale) ? (
                    <p className="tm-prefs-card__note">{t('LanguagePicker.betaNote')}</p>
                  ) : null}
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
                        {`${tr(DATE_FORMAT_LABELS[value][0])} (${DATE_FORMAT_LABELS[value][1]})`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {save.isError ? (
                <InlineAlert tone="danger" title={tr('DisplayPreferencesView.saveError')}>
                  {errorMessage(save.error)}
                </InlineAlert>
              ) : null}

              {saved && !save.isPending && !save.isError ? (
                <InlineAlert tone="success" title={tr('DisplayPreferencesView.savedTitle')}>
                  {tr('DisplayPreferencesView.savedBody')}
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
              {`${tr('DisplayPreferencesView.sampleHeading')} · ${tr(DENSITY_LABELS[density])}, ${tr(THEME_LABELS[theme])}`}
            </h2>
            <div className="tm-prefs-sample" data-density={density} aria-hidden="true">
              <div className="tm-prefs-sample__head">{tr('DisplayPreferencesView.sampleHead')}</div>
              <ul className="tm-prefs-sample__list">
                <li className="tm-prefs-sample__row tm-prefs-sample__row--current">
                  <span className="tm-prefs-dot tm-prefs-dot--lime" />
                  <span className="tm-prefs-sample__name">
                    {tr('DisplayPreferencesView.sampleCurrent')}
                  </span>
                  <span className="tm-prefs-sample__date">{sampleDates[0]}</span>
                </li>
                <li className="tm-prefs-sample__row">
                  <span className="tm-prefs-dot tm-prefs-dot--client" />
                  <span className="tm-prefs-sample__name">
                    {tr('DisplayPreferencesView.sampleClient')}
                  </span>
                  <span className="tm-prefs-sample__date">
                    {tr('DisplayPreferencesView.sampleHours')}
                  </span>
                </li>
                <li className="tm-prefs-sample__row">
                  <span className="tm-prefs-dot tm-prefs-dot--warn" />
                  <span className="tm-prefs-sample__name">
                    {tr('DisplayPreferencesView.sampleRisk')}
                  </span>
                  <span className="tm-prefs-sample__date tm-prefs-sample__date--warn">
                    {sampleDates[1]}
                  </span>
                </li>
                <li className="tm-prefs-sample__row tm-prefs-sample__row--muted">
                  <span className="tm-prefs-dot tm-prefs-dot--empty" />
                  <span className="tm-prefs-sample__name">
                    {tr('DisplayPreferencesView.sampleUndated')}
                  </span>
                  <span className="tm-prefs-sample__date">
                    {tr('DisplayPreferencesView.noDate')}
                  </span>
                </li>
                <li className="tm-prefs-sample__row tm-prefs-sample__row--muted">
                  <span className="tm-prefs-dot" />
                  <span className="tm-prefs-sample__name">
                    {tr('DisplayPreferencesView.sampleFinished')}
                  </span>
                  <span className="tm-prefs-sample__date">{tr('DisplayPreferencesView.done')}</span>
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
