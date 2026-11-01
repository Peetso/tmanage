'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { getQuietHours, updateQuietHours } from '../../lib/api/quiet-hours';
import type { QuietHoursView } from '../../lib/api/quiet-hours';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { PreferenceToggle } from './PreferencesScreen';
import { TimeZoneSelect } from '../TimeZoneSelect';
import '../../styles/screens/preferences.css';

export interface QuietHoursScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The default an unsaved account reads by; the same values the API's `DEFAULT_QUIET_HOURS` holds. */
const DEFAULTS: QuietHoursView = {
  enabled: false,
  startTime: '22:00',
  endTime: '07:00',
  timezone: 'UTC',
  days: [0, 1, 2, 3, 4, 5, 6],
};

const DAYS_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const DAY_KEY: Record<0 | 1 | 2 | 3 | 4 | 5 | 6, MessageKey> = {
  1: 'QuietHoursScreen.dayMon',
  2: 'QuietHoursScreen.dayTue',
  3: 'QuietHoursScreen.dayWed',
  4: 'QuietHoursScreen.dayThu',
  5: 'QuietHoursScreen.dayFri',
  6: 'QuietHoursScreen.daySat',
  0: 'QuietHoursScreen.daySun',
};

/** The IANA zone the browser is set to, so the form can default to something meaningful. */
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * **Notification quiet hours (module 20 Preferences & accessibility, PREF-QUIET, x215).**
 *
 * `38-MODULE-MAP` §Preferences & accessibility. The audit found appearance and accessibility
 * preferences built but no quiet-hours / do-not-disturb window; this is the screen that adds it. A
 * member reads their own window (defaults when never saved), toggles it on, sets a start/end time,
 * timezone and the weekdays it applies to, and saves — persisted behind `work.read`, scoped to the
 * caller's own membership by the server. The window is a *time* rule, distinct from the per-kind
 * notification opt-out.
 */
export function QuietHoursScreen({
  organizationSlug,
  organizationName,
  client,
}: QuietHoursScreenProps) {
  const errorMessage = useDescribeApiError(OFFLINE_LINES);
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();

  const preferences = useQuery({
    queryKey: ['quiet-hours', organizationSlug],
    queryFn: () => getQuietHours(api, organizationSlug),
  });

  const [enabled, setEnabled] = useState(DEFAULTS.enabled);
  const [startTime, setStartTime] = useState(DEFAULTS.startTime);
  const [endTime, setEndTime] = useState(DEFAULTS.endTime);
  const [timezone, setTimezone] = useState(DEFAULTS.timezone);
  const [days, setDays] = useState<readonly number[]>(DEFAULTS.days);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!preferences.data) return;
    setEnabled(preferences.data.enabled);
    setStartTime(preferences.data.startTime);
    setEndTime(preferences.data.endTime);
    setTimezone(preferences.data.timezone);
    setDays(preferences.data.days);
  }, [preferences.data]);

  const toggleDay = (value: number) => {
    setDays((current) =>
      current.includes(value)
        ? current.filter((day) => day !== value)
        : [...current, value].sort((a, b) => a - b),
    );
  };

  const save = useMutation({
    mutationFn: (): Promise<QuietHoursView> =>
      updateQuietHours(api, organizationSlug, {
        enabled,
        startTime,
        endTime,
        timezone: timezone.trim() || browserTimezone(),
        days,
      }),
    onSuccess: (result) => {
      queries.setQueryData(['quiet-hours', organizationSlug], result);
      setSaved(true);
    },
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={t('QuietHoursScreen.eyebrow')}
      title={t('QuietHoursScreen.title')}
    >
      {preferences.isPending ? (
        <LoadingRegion label={t('QuietHoursScreen.loading')}>
          <Skeleton />
        </LoadingRegion>
      ) : preferences.isError ? (
        <InlineAlert tone="danger" title={t('QuietHoursScreen.loadFailed')}>
          {errorMessage(preferences.error)}
        </InlineAlert>
      ) : (
        <div className="tm-prefs tm-prefs--a11y">
          <div className="tm-prefs__main">
            <form
              className="tm-prefs-card"
              aria-labelledby="tm-quiet-heading"
              onSubmit={(event) => {
                event.preventDefault();
                setSaved(false);
                save.mutate();
              }}
            >
              <h2 id="tm-quiet-heading" className="tm-prefs-eyebrow">
                {t('QuietHoursScreen.windowHeading')}
              </h2>

              <PreferenceToggle
                label={t('QuietHoursScreen.enableLabel')}
                hint={t('QuietHoursScreen.enableHint')}
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />

              <hr className="tm-prefs-rule" />

              <div className="tm-prefs-fields">
                <div className="tm-prefs-field">
                  <label className="tm-prefs-field__label" htmlFor="tm-quiet-start">
                    {t('QuietHoursScreen.startTime')}
                  </label>
                  <input
                    id="tm-quiet-start"
                    className="tm-prefs-field__control"
                    type="time"
                    value={startTime}
                    onChange={(event) => setStartTime(event.target.value)}
                  />
                </div>

                <div className="tm-prefs-field">
                  <label className="tm-prefs-field__label" htmlFor="tm-quiet-end">
                    {t('QuietHoursScreen.endTime')}
                  </label>
                  <input
                    id="tm-quiet-end"
                    className="tm-prefs-field__control"
                    type="time"
                    value={endTime}
                    onChange={(event) => setEndTime(event.target.value)}
                  />
                </div>

                <TimeZoneSelect
                  className="tm-prefs-field tm-prefs-field--wide"
                  label={t('QuietHoursScreen.timezone')}
                  value={timezone || browserTimezone()}
                  onChange={setTimezone}
                />
              </div>

              <fieldset className="tm-prefs-section">
                <legend className="tm-prefs-eyebrow">{t('QuietHoursScreen.days')}</legend>
                <div className="tm-prefs-choices">
                  {DAYS_ORDER.map((value) => (
                    <label className="tm-prefs-choice" key={value}>
                      <input
                        id={`tm-quiet-day-${value}`}
                        type="checkbox"
                        checked={days.includes(value)}
                        onChange={() => toggleDay(value)}
                      />
                      {t(DAY_KEY[value])}
                    </label>
                  ))}
                </div>
              </fieldset>

              {save.isError ? (
                <InlineAlert tone="danger" title={t('QuietHoursScreen.saveFailed')}>
                  {errorMessage(save.error)}
                </InlineAlert>
              ) : null}

              {saved && !save.isPending && !save.isError ? (
                <InlineAlert tone="success" title={t('QuietHoursScreen.savedTitle')}>
                  {t('QuietHoursScreen.savedBody')}
                </InlineAlert>
              ) : null}

              <div>
                <button
                  type="submit"
                  className="tm-prefs-capsule tm-prefs-capsule--ink"
                  disabled={save.isPending}
                >
                  {save.isPending ? t('QuietHoursScreen.saving') : t('QuietHoursScreen.save')}
                </button>
              </div>
            </form>
          </div>

          <aside className="tm-prefs__side" aria-labelledby="tm-quiet-summary">
            <div className="tm-prefs-card tm-prefs-card--tight">
              <h2 id="tm-quiet-summary" className="tm-prefs-card__title">
                {enabled ? `${startTime} – ${endTime}` : t('QuietHoursScreen.summaryOff')}
              </h2>
              <p className="tm-prefs-card__body">
                {enabled
                  ? `${timezone || browserTimezone()}, on ${days.length === 7 ? 'every day' : `${days.length} day${days.length === 1 ? '' : 's'} a week`}. Notifications wait until the window ends.`
                  : t('QuietHoursScreen.summaryOffBody')}
              </p>
            </div>
            <div className="tm-prefs-card tm-prefs-card--paper tm-prefs-card--grow">
              <h3 className="tm-prefs-eyebrow">{t('QuietHoursScreen.alsoInNotifications')}</h3>
              <p className="tm-prefs-card__body">{t('QuietHoursScreen.alsoBody')}</p>
              <div className="tm-prefs-card__foot">
                <Link
                  className="tm-prefs-capsule"
                  href={`/${organizationSlug}/inbox/notification-preferences`}
                >
                  {t('QuietHoursScreen.notificationsLink')}
                </Link>
                <Link className="tm-prefs-capsule" href={`/${organizationSlug}/settings/digest`}>
                  {t('QuietHoursScreen.summaryEmailLink')}
                </Link>
              </div>
            </div>
          </aside>
        </div>
      )}
    </AppShell>
  );
}
