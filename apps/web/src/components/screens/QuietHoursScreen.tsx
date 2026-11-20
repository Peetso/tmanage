'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import type { MessageKey } from '../../lib/i18n/t';
import { getQuietHours, updateQuietHours } from '../../lib/api/quiet-hours';
import type { QuietHoursView } from '../../lib/api/quiet-hours';
import {
  effectiveQuietHours,
  getNotificationPreferences,
  updateNotificationPreferences,
  withQuietWindow,
} from '../../lib/api/notification-preferences';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { PreferenceToggle } from './PreferencesScreen';
import { TimeZoneSelect } from '../TimeZoneSelect';
import '../../styles/screens/preferences.css';

/**
 * The start/end choices: every quarter hour as 24-hour "HH:MM", plus the saved value when it is
 * off the grid. A `<select>` rather than `<input type="time">`, whose AM/PM follows the browser's
 * own language, not the page's (C7: Arabic pages showed "10:00 PM").
 */
export function timeChoices(current: string): string[] {
  const choices: string[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    choices.push(`${hh}:${mm}`);
  }
  const value = current.slice(0, 5);
  if (/^\d{2}:\d{2}$/.test(value) && !choices.includes(value)) {
    choices.push(value);
    choices.sort();
  }
  return choices;
}

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
  const tOr = useTOr();

  const preferences = useQuery({
    queryKey: ['quiet-hours', organizationSlug],
    queryFn: () => getQuietHours(api, organizationSlug),
  });

  // NOTIF-001 holds the window delivery honours; a window saved there must show in this form too.
  const notification = useQuery({
    queryKey: ['notification-preferences', organizationSlug],
    queryFn: () => getNotificationPreferences(api, organizationSlug),
    retry: false,
  });

  const effective = useMemo(
    () => (preferences.data ? effectiveQuietHours(preferences.data, notification.data) : undefined),
    [preferences.data, notification.data],
  );

  const [enabled, setEnabled] = useState(DEFAULTS.enabled);
  const [startTime, setStartTime] = useState(DEFAULTS.startTime);
  const [endTime, setEndTime] = useState(DEFAULTS.endTime);
  const [timezone, setTimezone] = useState(DEFAULTS.timezone);
  const [days, setDays] = useState<readonly number[]>(DEFAULTS.days);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!effective) return;
    setEnabled(effective.enabled);
    setStartTime(effective.startTime);
    setEndTime(effective.endTime);
    setTimezone(effective.timezone);
    setDays(effective.days);
  }, [effective]);

  const toggleDay = (value: number) => {
    setDays((current) =>
      current.includes(value)
        ? current.filter((day) => day !== value)
        : [...current, value].sort((a, b) => a - b),
    );
  };

  const save = useMutation({
    mutationFn: async (): Promise<QuietHoursView> => {
      const window: QuietHoursView = {
        enabled,
        startTime,
        endTime,
        timezone: timezone.trim() || browserTimezone(),
        days,
      };
      // Keep the delivery store in step first: it validates the window more strictly.
      if (notification.data) {
        const synced = await updateNotificationPreferences(
          api,
          organizationSlug,
          withQuietWindow(notification.data, window),
        );
        queries.setQueryData(['notification-preferences', organizationSlug], synced);
      }
      return updateQuietHours(api, organizationSlug, window);
    },
    onSuccess: (result) => {
      queries.setQueryData(['quiet-hours', organizationSlug], result);
      setSaved(true);
    },
  });

  return (
    <SettingsShell
      section="quiet-hours"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={t('QuietHoursScreen.eyebrow')}
      title={t('QuietHoursScreen.title')}
    >
      {preferences.isPending || notification.isPending ? (
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
              noValidate
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
                  <select
                    id="tm-quiet-start"
                    className="tm-prefs-field__control"
                    value={startTime.slice(0, 5)}
                    onChange={(event) => setStartTime(event.target.value)}
                  >
                    {timeChoices(startTime).map((time) => (
                      <option key={time} value={time}>
                        {time}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="tm-prefs-field">
                  <label className="tm-prefs-field__label" htmlFor="tm-quiet-end">
                    {t('QuietHoursScreen.endTime')}
                  </label>
                  <select
                    id="tm-quiet-end"
                    className="tm-prefs-field__control"
                    value={endTime.slice(0, 5)}
                    onChange={(event) => setEndTime(event.target.value)}
                  >
                    {timeChoices(endTime).map((time) => (
                      <option key={time} value={time}>
                        {time}
                      </option>
                    ))}
                  </select>
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
                {/* A range reads start to end in Arabic too: isolated left to right. */}
                {enabled ? (
                  <bdi dir="ltr">{`${startTime} – ${endTime}`}</bdi>
                ) : (
                  t('QuietHoursScreen.summaryOff')
                )}
              </h2>
              <p className="tm-prefs-card__body">
                {enabled
                  ? `${timezone || browserTimezone()}${
                      days.length === 7
                        ? tOr(
                            'QuietHoursScreen.summaryEveryDay',
                            ', every day. Notifications wait until the window ends.',
                          )
                        : `${tOr('QuietHoursScreen.summaryOnPrefix', ', on ')}${days.length}${tOr('QuietHoursScreen.summaryOfSevenDays', ' of 7 days. Notifications wait until the window ends.')}`
                    }`
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
    </SettingsShell>
  );
}
