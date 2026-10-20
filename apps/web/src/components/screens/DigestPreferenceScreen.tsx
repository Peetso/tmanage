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
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
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

const CADENCE_OPTIONS: readonly {
  value: DigestCadence;
  labelKey: MessageKey;
  hintKey: MessageKey;
}[] = [
  {
    value: 'immediate',
    labelKey: 'DigestPreferenceScreen.cadenceImmediate',
    hintKey: 'DigestPreferenceScreen.cadenceImmediateHint',
  },
  {
    value: 'daily',
    labelKey: 'DigestPreferenceScreen.cadenceDaily',
    hintKey: 'DigestPreferenceScreen.cadenceDailyHint',
  },
  {
    value: 'weekly',
    labelKey: 'DigestPreferenceScreen.cadenceWeekly',
    hintKey: 'DigestPreferenceScreen.cadenceWeeklyHint',
  },
];

const DAY_LABELS: readonly { value: number; labelKey: MessageKey }[] = [
  { value: 1, labelKey: 'DigestPreferenceScreen.dayMonday' },
  { value: 2, labelKey: 'DigestPreferenceScreen.dayTuesday' },
  { value: 3, labelKey: 'DigestPreferenceScreen.dayWednesday' },
  { value: 4, labelKey: 'DigestPreferenceScreen.dayThursday' },
  { value: 5, labelKey: 'DigestPreferenceScreen.dayFriday' },
  { value: 6, labelKey: 'DigestPreferenceScreen.daySaturday' },
  { value: 0, labelKey: 'DigestPreferenceScreen.daySunday' },
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
  const t = useT();

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
  const dayLabelKey = DAY_LABELS.find((day) => day.value === dayOfWeek)?.labelKey;
  const dayLabel = dayLabelKey ? t(dayLabelKey) : '';

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={t('DigestPreferenceScreen.eyebrow')}
      title={t('DigestPreferenceScreen.title')}
    >
      {preference.isPending ? (
        <LoadingRegion label={t('DigestPreferenceScreen.loading')}>
          <Skeleton />
        </LoadingRegion>
      ) : preference.isError ? (
        <InlineAlert tone="danger" title={t('DigestPreferenceScreen.loadError')}>
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
                {t('DigestPreferenceScreen.digestFrequency')}
              </h2>

              <fieldset className="tm-prefs-section">
                <legend className="tm-prefs-eyebrow">{t('DigestPreferenceScreen.howOften')}</legend>
                <div className="tm-prefs-choices">
                  {CADENCE_OPTIONS.map(({ value, labelKey }) => (
                    <label className="tm-prefs-choice" key={value}>
                      <input
                        id={`tm-digest-cadence-${value}`}
                        type="radio"
                        name="tm-digest-cadence"
                        checked={cadence === value}
                        onChange={() => setCadence(value)}
                      />
                      {t(labelKey)}
                    </label>
                  ))}
                </div>
                {chosen ? <p className="tm-prefs-card__note">{t(chosen.hintKey)}</p> : null}
              </fieldset>

              {cadence !== 'immediate' ? (
                <>
                  <hr className="tm-prefs-rule" />
                  <div className="tm-prefs-fields">
                    <div className="tm-prefs-field">
                      <label className="tm-prefs-field__label" htmlFor="tm-digest-hour">
                        {t('DigestPreferenceScreen.sendAt')}
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
                          {t('DigestPreferenceScreen.sendOn')}
                        </label>
                        <select
                          id="tm-digest-day"
                          className="tm-prefs-field__control"
                          value={dayOfWeek}
                          onChange={(event) => setDayOfWeek(Number(event.target.value))}
                        >
                          {DAY_LABELS.map(({ value, labelKey }) => (
                            <option key={value} value={value}>
                              {t(labelKey)}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                  </div>
                </>
              ) : null}

              {save.isError ? (
                <InlineAlert tone="danger" title={t('DigestPreferenceScreen.saveError')}>
                  {errorMessage(save.error)}
                </InlineAlert>
              ) : null}

              {saved && !save.isPending && !save.isError ? (
                <InlineAlert tone="success" title={t('DigestPreferenceScreen.savedTitle')}>
                  {t('DigestPreferenceScreen.savedBody')}
                </InlineAlert>
              ) : null}

              <div>
                <button
                  type="submit"
                  className="tm-prefs-capsule tm-prefs-capsule--ink"
                  disabled={save.isPending}
                >
                  {save.isPending
                    ? t('DigestPreferenceScreen.saving')
                    : t('DigestPreferenceScreen.saveButton')}
                </button>
              </div>
            </form>
          </div>

          <aside className="tm-prefs__side" aria-labelledby="tm-digest-summary">
            <div className="tm-prefs-card tm-prefs-card--paper tm-prefs-card--grow">
              <h2 id="tm-digest-summary" className="tm-prefs-eyebrow">
                {t('DigestPreferenceScreen.whatYouWillGet')}
              </h2>
              <p className="tm-prefs-card__lead">
                {cadence === 'immediate'
                  ? t('DigestPreferenceScreen.leadImmediate')
                  : cadence === 'weekly'
                    ? `${t('DigestPreferenceScreen.leadWeeklyPrefix')}${dayLabel}${t('DigestPreferenceScreen.leadWeeklyMid')}${hourLabel}`
                    : `${t('DigestPreferenceScreen.leadDailyPrefix')}${hourLabel}`}
              </p>
              <p className="tm-prefs-card__note">{t('DigestPreferenceScreen.kindsNote')}</p>
              <div className="tm-prefs-card__foot">
                <Link
                  className="tm-prefs-capsule"
                  href={`/${organizationSlug}/inbox/notification-preferences`}
                >
                  {t('DigestPreferenceScreen.notificationsLink')}
                </Link>
                <Link
                  className="tm-prefs-capsule"
                  href={`/${organizationSlug}/settings/quiet-hours`}
                >
                  {t('DigestPreferenceScreen.quietHoursLink')}
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
