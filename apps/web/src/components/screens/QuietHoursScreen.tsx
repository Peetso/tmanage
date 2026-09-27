'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getQuietHours, updateQuietHours } from '../../lib/api/quiet-hours';
import type { QuietHoursView } from '../../lib/api/quiet-hours';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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
      title="Quiet hours"
      description="Set a do-not-disturb window for notifications, in your timezone, on the days you choose."
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
        <form
          className="tm-panel tm-stack"
          aria-labelledby="tm-quiet-heading"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            save.mutate();
          }}
        >
          <h2 id="tm-quiet-heading" className="tm-eyebrow">
            Do-not-disturb window
          </h2>

          <div className="tm-field tm-field--inline">
            <input
              id="tm-quiet-enabled"
              className="tm-field__control"
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <label className="tm-field__label" htmlFor="tm-quiet-enabled">
              Enable quiet hours
            </label>
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-quiet-start">
              Start time
            </label>
            <input
              id="tm-quiet-start"
              className="tm-field__control"
              type="time"
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
            />
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-quiet-end">
              End time
            </label>
            <input
              id="tm-quiet-end"
              className="tm-field__control"
              type="time"
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
            />
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-quiet-timezone">
              Timezone
            </label>
            <input
              id="tm-quiet-timezone"
              className="tm-field__control"
              type="text"
              value={timezone}
              placeholder="e.g. America/New_York"
              onChange={(event) => setTimezone(event.target.value)}
            />
          </div>

          <fieldset className="tm-fieldset tm-stack">
            <legend className="tm-field__label">Days</legend>
            {DAY_LABELS.map(({ value, label }) => (
              <div className="tm-field tm-field--inline" key={value}>
                <input
                  id={`tm-quiet-day-${value}`}
                  className="tm-field__control"
                  type="checkbox"
                  checked={days.includes(value)}
                  onChange={() => toggleDay(value)}
                />
                <label className="tm-field__label" htmlFor={`tm-quiet-day-${value}`}>
                  {label}
                </label>
              </div>
            ))}
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
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save quiet hours'}
            </Button>
          </div>
        </form>
      )}
    </AppShell>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
