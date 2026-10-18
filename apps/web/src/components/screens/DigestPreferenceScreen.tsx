'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getDigestPreference, updateDigestPreference } from '../../lib/api/digest';
import type { DigestCadence, DigestPrefView } from '../../lib/api/digest';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/preferences.css';

export interface DigestPreferenceScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The default an unsaved account reads by; the same values the API's `DEFAULT_DIGEST_PREFERENCE` holds. */
const DEFAULTS: DigestPrefView = {
  cadence: 'daily',
  sendHour: 8,
  dayOfWeek: 1,
};

const CADENCE_OPTIONS: readonly { value: DigestCadence; label: string; hint: string }[] = [
  { value: 'immediate', label: 'Immediately', hint: 'Send each notification as it happens.' },
  { value: 'daily', label: 'Daily', hint: 'One digest per day, at the hour you choose.' },
  {
    value: 'weekly',
    label: 'Weekly',
    hint: 'One digest per week, on the day and hour you choose.',
  },
];

const DAY_LABELS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
];

/**
 * **Notification digest frequency (module 20 Preferences & accessibility, PREF-DIGEST, x245).**
 *
 * `38-MODULE-MAP` §Preferences & accessibility. The audit found appearance, accessibility and
 * quiet-hours preferences built (x182/x183/x215) but no digest-cadence preference; this is the screen
 * that adds it. A member reads their own cadence (defaults when never saved), chooses immediate,
 * daily or weekly, sets the hour of day and — for weekly — the weekday, and saves — persisted behind
 * `work.read`, scoped to the caller's own membership by the server. This is *how often* the digest is
 * delivered, distinct from the quiet-hours time window and the per-kind opt-out. No digest is sent
 * from here — the preference is storage only in this slice.
 */
export function DigestPreferenceScreen({
  organizationSlug,
  organizationName,
  client,
}: DigestPreferenceScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const preference = useQuery({
    queryKey: ['digest-preference', organizationSlug],
    queryFn: () => getDigestPreference(api, organizationSlug),
  });

  const [cadence, setCadence] = useState<DigestCadence>(DEFAULTS.cadence);
  const [sendHour, setSendHour] = useState(DEFAULTS.sendHour);
  const [dayOfWeek, setDayOfWeek] = useState(DEFAULTS.dayOfWeek);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!preference.data) return;
    setCadence(preference.data.cadence);
    setSendHour(preference.data.sendHour);
    setDayOfWeek(preference.data.dayOfWeek);
  }, [preference.data]);

  const save = useMutation({
    mutationFn: (): Promise<DigestPrefView> =>
      updateDigestPreference(api, organizationSlug, { cadence, sendHour, dayOfWeek }),
    onSuccess: (result) => {
      queries.setQueryData(['digest-preference', organizationSlug], result);
      setCadence(result.cadence);
      setSendHour(result.sendHour);
      setDayOfWeek(result.dayOfWeek);
      setSaved(true);
    },
  });

  const chosen = CADENCE_OPTIONS.find((option) => option.value === cadence);
  const hourLabel = `${String(sendHour).padStart(2, '0')}:00`;
  const dayLabel = DAY_LABELS.find((day) => day.value === dayOfWeek)?.label ?? '';

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow="Preferences · Notifications"
      title="Summary email"
    >
      {preference.isPending ? (
        <LoadingRegion label="Loading your digest preference">
          <Skeleton />
        </LoadingRegion>
      ) : preference.isError ? (
        <InlineAlert tone="danger" title="We could not load your digest preference">
          {errorMessage(preference.error)}
        </InlineAlert>
      ) : (
        <div className="tm-prefs tm-prefs--a11y">
          <div className="tm-prefs__main">
            <form
              className="tm-prefs-card"
              aria-labelledby="tm-digest-heading"
              onSubmit={(event) => {
                event.preventDefault();
                setSaved(false);
                save.mutate();
              }}
            >
              <h2 id="tm-digest-heading" className="tm-visually-hidden">
                Digest frequency
              </h2>

              <fieldset className="tm-prefs-section">
                <legend className="tm-prefs-eyebrow">How often</legend>
                <div className="tm-prefs-choices">
                  {CADENCE_OPTIONS.map(({ value, label }) => (
                    <label className="tm-prefs-choice" key={value}>
                      <input
                        id={`tm-digest-cadence-${value}`}
                        type="radio"
                        name="tm-digest-cadence"
                        checked={cadence === value}
                        onChange={() => setCadence(value)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                {chosen ? <p className="tm-prefs-card__note">{chosen.hint}</p> : null}
              </fieldset>

              {cadence !== 'immediate' ? (
                <>
                  <hr className="tm-prefs-rule" />
                  <div className="tm-prefs-fields">
                    <div className="tm-prefs-field">
                      <label className="tm-prefs-field__label" htmlFor="tm-digest-hour">
                        Send at
                      </label>
                      <select
                        id="tm-digest-hour"
                        className="tm-prefs-field__control"
                        value={sendHour}
                        onChange={(event) => setSendHour(Number(event.target.value))}
                      >
                        {Array.from({ length: 24 }, (_, hour) => (
                          <option key={hour} value={hour}>
                            {String(hour).padStart(2, '0')}:00
                          </option>
                        ))}
                      </select>
                    </div>

                    {cadence === 'weekly' ? (
                      <div className="tm-prefs-field">
                        <label className="tm-prefs-field__label" htmlFor="tm-digest-day">
                          Send on
                        </label>
                        <select
                          id="tm-digest-day"
                          className="tm-prefs-field__control"
                          value={dayOfWeek}
                          onChange={(event) => setDayOfWeek(Number(event.target.value))}
                        >
                          {DAY_LABELS.map(({ value, label }) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                  </div>
                </>
              ) : null}

              {save.isError ? (
                <InlineAlert tone="danger" title="We could not save your digest preference">
                  {errorMessage(save.error)}
                </InlineAlert>
              ) : null}

              {saved && !save.isPending && !save.isError ? (
                <InlineAlert tone="success" title="Saved">
                  Your digest preference has been saved.
                </InlineAlert>
              ) : null}

              <div>
                <button
                  type="submit"
                  className="tm-prefs-capsule tm-prefs-capsule--ink"
                  disabled={save.isPending}
                >
                  {save.isPending ? 'Saving…' : 'Save digest preference'}
                </button>
              </div>
            </form>
          </div>

          <aside className="tm-prefs__side" aria-labelledby="tm-digest-summary">
            <div className="tm-prefs-card tm-prefs-card--paper tm-prefs-card--grow">
              <h2 id="tm-digest-summary" className="tm-prefs-eyebrow">
                What you will get
              </h2>
              <p className="tm-prefs-card__lead">
                {cadence === 'immediate'
                  ? 'Each notification, as it happens'
                  : cadence === 'weekly'
                    ? `One email every ${dayLabel} at ${hourLabel}`
                    : `One email a day at ${hourLabel}`}
              </p>
              <p className="tm-prefs-card__note">
                Which kinds of notification you get is set in Notifications.
              </p>
              <div className="tm-prefs-card__foot">
                <Link
                  className="tm-prefs-capsule"
                  href={`/${organizationSlug}/inbox/notification-preferences`}
                >
                  Notifications
                </Link>
                <Link
                  className="tm-prefs-capsule"
                  href={`/${organizationSlug}/settings/quiet-hours`}
                >
                  Quiet hours
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
