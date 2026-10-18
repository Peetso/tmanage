'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getQuietHours, updateQuietHours } from '../../lib/api/quiet-hours';
import type { QuietHoursView } from '../../lib/api/quiet-hours';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { PreferenceToggle } from './PreferencesScreen';
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

const DAY_LABELS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

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
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

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
      eyebrow="Preferences · Notifications"
      title="Quiet hours"
    >
      {preferences.isPending ? (
        <LoadingRegion label="Loading your quiet hours">
          <Skeleton />
        </LoadingRegion>
      ) : preferences.isError ? (
        <InlineAlert tone="danger" title="We could not load your quiet hours">
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
                Do-not-disturb window
              </h2>

              <PreferenceToggle
                label="Enable quiet hours"
                hint="notifications wait until the window ends"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />

              <hr className="tm-prefs-rule" />

              <div className="tm-prefs-fields">
                <div className="tm-prefs-field">
                  <label className="tm-prefs-field__label" htmlFor="tm-quiet-start">
                    Start time
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
                    End time
                  </label>
                  <input
                    id="tm-quiet-end"
                    className="tm-prefs-field__control"
                    type="time"
                    value={endTime}
                    onChange={(event) => setEndTime(event.target.value)}
                  />
                </div>

                <div className="tm-prefs-field tm-prefs-field--wide">
                  <label className="tm-prefs-field__label" htmlFor="tm-quiet-timezone">
                    Timezone
                  </label>
                  <input
                    id="tm-quiet-timezone"
                    className="tm-prefs-field__control"
                    type="text"
                    value={timezone}
                    placeholder="e.g. America/New_York"
                    onChange={(event) => setTimezone(event.target.value)}
                  />
                </div>
              </div>

              <fieldset className="tm-prefs-section">
                <legend className="tm-prefs-eyebrow">Days</legend>
                <div className="tm-prefs-choices">
                  {DAY_LABELS.map(({ value, label }) => (
                    <label className="tm-prefs-choice" key={value}>
                      <input
                        id={`tm-quiet-day-${value}`}
                        type="checkbox"
                        checked={days.includes(value)}
                        onChange={() => toggleDay(value)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>

              {save.isError ? (
                <InlineAlert tone="danger" title="We could not save your quiet hours">
                  {errorMessage(save.error)}
                </InlineAlert>
              ) : null}

              {saved && !save.isPending && !save.isError ? (
                <InlineAlert tone="success" title="Saved">
                  Your quiet hours have been saved.
                </InlineAlert>
              ) : null}

              <div>
                <button
                  type="submit"
                  className="tm-prefs-capsule tm-prefs-capsule--ink"
                  disabled={save.isPending}
                >
                  {save.isPending ? 'Saving…' : 'Save quiet hours'}
                </button>
              </div>
            </form>
          </div>

          <aside className="tm-prefs__side" aria-labelledby="tm-quiet-summary">
            <div className="tm-prefs-card tm-prefs-card--tight">
              <h2 id="tm-quiet-summary" className="tm-prefs-card__title">
                {enabled ? `${startTime} – ${endTime}` : 'Quiet hours are off'}
              </h2>
              <p className="tm-prefs-card__body">
                {enabled
                  ? `${timezone || browserTimezone()}, on ${days.length === 7 ? 'every day' : `${days.length} day${days.length === 1 ? '' : 's'} a week`}. Notifications wait until the window ends.`
                  : 'Notifications arrive whenever they happen. Turn quiet hours on to hold them overnight.'}
              </p>
            </div>
            <div className="tm-prefs-card tm-prefs-card--paper tm-prefs-card--grow">
              <h3 className="tm-prefs-eyebrow">Also in notifications</h3>
              <p className="tm-prefs-card__body">
                Which kinds of notification reach you, and how often the summary email arrives.
              </p>
              <div className="tm-prefs-card__foot">
                <Link
                  className="tm-prefs-capsule"
                  href={`/${organizationSlug}/inbox/notification-preferences`}
                >
                  Notifications
                </Link>
                <Link className="tm-prefs-capsule" href={`/${organizationSlug}/settings/digest`}>
                  Summary email
                </Link>
              </div>
            </div>
          </aside>
        </div>
      )}
    </AppShell>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
