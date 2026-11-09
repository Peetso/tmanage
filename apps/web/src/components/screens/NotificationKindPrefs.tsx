'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { NotificationKind } from '../../lib/api/notification-kind-prefs';
import {
  FORCED_EMAIL_SETTING_KEY,
  forcedEmailValue,
  getNotificationMatrix,
  setNotificationMatrixCell,
  type NotificationMatrixChannel,
} from '../../lib/api/notification-matrix';
import { setOrgSetting } from '../../lib/api/org-settings';
import { getQuietHours } from '../../lib/api/quiet-hours';
import {
  effectiveQuietHours,
  getNotificationPreferences,
} from '../../lib/api/notification-preferences';
import { getDigestPreference, type DigestPrefView } from '../../lib/api/digest';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import type { MessageKey } from '../../lib/i18n/t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import '../../styles/screens/preferences.css';
import '../../styles/screens/notification-matrix.css';

export interface NotificationKindPrefsProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The message keys for what each kind is called on screen, and its one-line description. */
const KIND_LABEL_KEYS: Readonly<Record<NotificationKind, { label: MessageKey; hint: MessageKey }>> =
  {
    client_request: {
      label: 'NotificationKindPrefs.kindClientRequestLabel',
      hint: 'NotificationKindPrefs.kindClientRequestHint',
    },
    work_item: {
      label: 'NotificationKindPrefs.kindWorkItemLabel',
      hint: 'NotificationKindPrefs.kindWorkItemHint',
    },
    message: {
      label: 'NotificationKindPrefs.kindMessageLabel',
      hint: 'NotificationKindPrefs.kindMessageHint',
    },
    file: {
      label: 'NotificationKindPrefs.kindFileLabel',
      hint: 'NotificationKindPrefs.kindFileHint',
    },
    mention: {
      label: 'NotificationKindPrefs.kindMentionLabel',
      hint: 'NotificationKindPrefs.kindMentionHint',
    },
  };

/** The matrix columns, in reading order (the row mirrors in RTL through the flex direction). */
const CHANNELS: readonly {
  readonly channel: NotificationMatrixChannel;
  readonly key: string;
  readonly english: string;
}[] = [
  { channel: 'in_app', key: 'NotificationKindPrefs.channelInApp', english: 'In-app' },
  { channel: 'email', key: 'NotificationKindPrefs.channelEmail', english: 'Email' },
  { channel: 'digest', key: 'NotificationKindPrefs.channelDigest', english: 'Digest' },
];

const KIND_ORDER: readonly NotificationKind[] = [
  'client_request',
  'work_item',
  'message',
  'file',
  'mention',
];

/** Indexed by `dayOfWeek` (0 = Sunday), the same keys the digest screen uses. */
const WEEKDAY_KEYS: readonly MessageKey[] = [
  'DigestPreferenceScreen.daySunday',
  'DigestPreferenceScreen.dayMonday',
  'DigestPreferenceScreen.dayTuesday',
  'DigestPreferenceScreen.dayWednesday',
  'DigestPreferenceScreen.dayThursday',
  'DigestPreferenceScreen.dayFriday',
  'DigestPreferenceScreen.daySaturday',
];

/**
 * **Notifications (PREF-03; 53-15 notification matrix).**
 *
 * PREF-03's frame: "What reaches you, and how" — the kind × channel matrix on the left (Figma
 * "R35 L4-53-15"), the quiet-hours and daily-summary cards on the right. The table reads
 * `GET .../me/notification-matrix` (behind `work.read`, the acting member's own): rows are the five
 * kinds, columns In-app / E-mail / Digest. Each tick is one `PUT` and the whole matrix re-renders from
 * the response. In-app is the kind's master switch (off greys its other cells); a kind the company
 * forces shows "Required by your company" with In-app and E-mail locked; the account & security row
 * is always on and never digested. A member holding `org.manage` also sees the company rule card,
 * which writes `notification_forced_email_kinds` through the settings PUT. Push waits for its keys.
 */
export function NotificationKindPrefs({
  organizationSlug,
  organizationName,
  client,
}: NotificationKindPrefsProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const tOr = useTOr();
  const queryClient = useQueryClient();
  const queryKey = ['notification-matrix', organizationSlug];

  const prefs = useQuery({
    queryKey,
    queryFn: () => getNotificationMatrix(api, organizationSlug),
  });

  const quietHours = useQuery({
    queryKey: ['quiet-hours', organizationSlug],
    queryFn: () => getQuietHours(api, organizationSlug),
    retry: false,
  });

  // NOTIF-001 holds the window delivery honours; the card shows it when one is saved there.
  const notification = useQuery({
    queryKey: ['notification-preferences', organizationSlug],
    queryFn: () => getNotificationPreferences(api, organizationSlug),
    retry: false,
  });

  const digest = useQuery({
    queryKey: ['digest-preference', organizationSlug],
    queryFn: () => getDigestPreference(api, organizationSlug),
    retry: false,
  });

  const setCell = useMutation({
    mutationFn: (input: {
      kind: NotificationKind;
      channel: NotificationMatrixChannel;
      enabled: boolean;
    }) => setNotificationMatrixCell(api, organizationSlug, input),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      void queryClient.invalidateQueries({
        queryKey: ['notification-kind-prefs', organizationSlug],
      });
    },
  });

  const setForced = useMutation({
    mutationFn: (kinds: readonly NotificationKind[]) =>
      setOrgSetting(
        api,
        organizationSlug,
        FORCED_EMAIL_SETTING_KEY,
        forcedEmailValue(kinds, KIND_ORDER),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const rows = prefs.data?.rows ?? [];
  const forcedKinds = prefs.data?.forcedEmailKinds ?? [];
  const quiet =
    quietHours.data && !notification.isPending
      ? effectiveQuietHours(quietHours.data, notification.data)
      : undefined;

  return (
    <SettingsShell
      section="notifications"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="inbox"
      eyebrow={t('NotificationKindPrefs.eyebrow')}
      title={t('NotificationKindPrefs.title')}
      description={t('NotificationKindPrefs.description')}
    >
      <div className="tm-prefs tm-prefs--notifications">
        <section className="tm-prefs__main" aria-labelledby="tm-notif-kinds-heading">
          <h2 id="tm-notif-kinds-heading" className="tm-visually-hidden">
            {t('NotificationKindPrefs.kindsHeading')}
          </h2>

          {prefs.isError ? (
            <InlineAlert tone="danger" title={t('NotificationKindPrefs.loadError')} live>
              {describeError(prefs.error)}
            </InlineAlert>
          ) : null}

          {setCell.isError ? (
            <InlineAlert tone="danger" title={t('NotificationKindPrefs.saveError')} live>
              {describeError(setCell.error)}
            </InlineAlert>
          ) : null}

          {prefs.isPending ? (
            <LoadingRegion label={t('NotificationKindPrefs.loading')}>
              <Skeleton height="46px" />
              <Skeleton height="46px" />
            </LoadingRegion>
          ) : null}

          {!prefs.isPending && !prefs.isError ? (
            <>
              <div className="tm-prefs-table tm-notif-matrix">
                <div className="tm-prefs-table__head" aria-hidden="true">
                  <span className="tm-prefs-table__event">
                    {t('NotificationKindPrefs.whenThisHappens')}
                  </span>
                  {CHANNELS.map(({ channel, key, english }) => (
                    <span className="tm-prefs-table__channel" key={channel}>
                      {tOr(key, english)}
                    </span>
                  ))}
                </div>
                {rows.map((row) => {
                  const id = `tm-notif-kind-${row.kind}`;
                  const label = t(KIND_LABEL_KEYS[row.kind].label);
                  const value: Record<NotificationMatrixChannel, boolean> = {
                    in_app: row.inApp,
                    email: row.email,
                    digest: row.digest,
                  };
                  return (
                    <div
                      className="tm-prefs-table__row"
                      key={row.kind}
                      role="group"
                      aria-labelledby={id}
                    >
                      <span className="tm-prefs-table__event">
                        <span className="tm-prefs-table__label" id={id}>
                          {label}
                          {row.forcedEmail ? (
                            <span className="tm-notif-matrix__badge">
                              {tOr('NotificationKindPrefs.forcedBadge', 'Required by your company')}
                            </span>
                          ) : null}
                        </span>
                        <span className="tm-prefs-table__hint" id={`${id}-hint`}>
                          {t(KIND_LABEL_KEYS[row.kind].hint)}
                        </span>
                      </span>
                      {CHANNELS.map(({ channel, key, english }) => {
                        const locked = row.forcedEmail && channel !== 'digest';
                        const unavailable =
                          (channel === 'email' && !row.available.email) ||
                          (channel === 'digest' && !row.available.digest);
                        const muted = channel !== 'in_app' && !row.inApp;
                        return (
                          <span className="tm-prefs-table__channel" key={channel}>
                            <input
                              type="checkbox"
                              className="tm-prefs-check"
                              checked={value[channel] && !unavailable}
                              disabled={setCell.isPending || locked || unavailable || muted}
                              aria-label={`${label}: ${tOr(key, english)}`}
                              aria-describedby={`${id}-hint`}
                              onChange={(event) =>
                                setCell.mutate({
                                  kind: row.kind,
                                  channel,
                                  enabled: event.target.checked,
                                })
                              }
                            />
                          </span>
                        );
                      })}
                    </div>
                  );
                })}
                <div
                  className="tm-prefs-table__row tm-notif-matrix__account"
                  role="group"
                  aria-labelledby="tm-notif-account"
                >
                  <span className="tm-prefs-table__event">
                    <span className="tm-prefs-table__label" id="tm-notif-account">
                      {tOr('NotificationKindPrefs.kindAccountLabel', 'Account, billing & security')}
                    </span>
                    <span className="tm-prefs-table__hint">
                      {tOr(
                        'NotificationKindPrefs.kindAccountHint',
                        'Always on — sign-in alerts, storage limits, privacy notices',
                      )}
                    </span>
                  </span>
                  <span className="tm-prefs-table__channel">
                    <input
                      type="checkbox"
                      className="tm-prefs-check"
                      checked
                      disabled
                      readOnly
                      aria-label={tOr('NotificationKindPrefs.channelInApp', 'In-app')}
                    />
                  </span>
                  <span className="tm-prefs-table__channel">
                    <input
                      type="checkbox"
                      className="tm-prefs-check"
                      checked
                      disabled
                      readOnly
                      aria-label={tOr('NotificationKindPrefs.channelEmail', 'Email')}
                    />
                  </span>
                  <span className="tm-prefs-table__channel" aria-hidden="true">
                    —
                  </span>
                </div>
              </div>
              <p className="tm-prefs-legend">
                <span className="tm-prefs-legend__item">
                  <span className="tm-prefs-legend__swatch" aria-hidden="true" />
                  {tOr('NotificationKindPrefs.matrixLegend', 'Tick = on · Faded = locked')}
                </span>
              </p>
            </>
          ) : null}
        </section>

        <div className="tm-prefs__side">
          {prefs.data?.canManageCompany ? (
            <section
              className="tm-prefs-card tm-prefs-card--tight"
              aria-labelledby="tm-company-card"
            >
              <h2 id="tm-company-card" className="tm-prefs-card__title">
                {tOr('NotificationKindPrefs.companyRuleTitle', 'Company rule')}
              </h2>
              <p className="tm-prefs-card__body">
                {tOr(
                  'NotificationKindPrefs.companyRuleBody',
                  'Keep e-mail on for these kinds for everyone in the company.',
                )}
              </p>
              <div className="tm-notif-matrix__chips">
                {KIND_ORDER.map((kind) => {
                  const on = forcedKinds.includes(kind);
                  return (
                    <button
                      key={kind}
                      type="button"
                      className="tm-notif-matrix__chip"
                      aria-pressed={on}
                      disabled={setForced.isPending}
                      onClick={() =>
                        setForced.mutate(
                          on ? forcedKinds.filter((k) => k !== kind) : [...forcedKinds, kind],
                        )
                      }
                    >
                      {t(KIND_LABEL_KEYS[kind].label)}
                    </button>
                  );
                })}
              </div>
              {setForced.isError ? (
                <InlineAlert tone="danger" title={t('NotificationKindPrefs.saveError')} live>
                  {describeError(setForced.error)}
                </InlineAlert>
              ) : null}
            </section>
          ) : null}

          <section className="tm-prefs-card tm-prefs-card--tight" aria-labelledby="tm-quiet-card">
            <h2 id="tm-quiet-card" className="tm-prefs-card__title">
              {t('NotificationKindPrefs.quietHours')}
            </h2>
            <p className="tm-prefs-card__body">
              {quiet && typeof quiet.enabled === 'boolean'
                ? quiet.enabled
                  ? `${quiet.startTime} – ${quiet.endTime} ${quiet.timezone}. ${t('NotificationKindPrefs.notificationsWait')}`
                  : t('NotificationKindPrefs.quietOff')
                : quietHours.isPending || notification.isPending
                  ? t('NotificationKindPrefs.loadingEllipsis')
                  : t('NotificationKindPrefs.quietUnreadable')}
            </p>
            <Link className="tm-prefs-capsule" href={`/${organizationSlug}/settings/quiet-hours`}>
              {t('NotificationKindPrefs.changeQuietHours')}
            </Link>
          </section>

          <section
            className="tm-prefs-card tm-prefs-card--paper tm-prefs-card--grow"
            aria-labelledby="tm-digest-card"
          >
            <h2 id="tm-digest-card" className="tm-prefs-eyebrow">
              {t('NotificationKindPrefs.summaryEmail')}
            </h2>
            <p className="tm-prefs-card__lead">
              {describeDigest(t, tOr, digest.data, digest.isPending)}
            </p>
            <p className="tm-prefs-card__note">
              {tOr(
                'NotificationKindPrefs.matrixSummaryNote',
                'Only the kinds with Digest ticked, and only what you have not read yet.',
              )}
            </p>
            <div className="tm-prefs-card__foot">
              <Link className="tm-prefs-capsule" href={`/${organizationSlug}/settings/digest`}>
                {t('NotificationKindPrefs.changeSummary')}
              </Link>
            </div>
          </section>
        </div>
      </div>
    </SettingsShell>
  );
}

function describeDigest(
  t: (key: MessageKey) => string,
  tOr: (key: string, english: string) => string,
  digest: DigestPrefView | undefined,
  pending: boolean,
): string {
  if (!digest || typeof digest.cadence !== 'string') {
    return pending
      ? t('NotificationKindPrefs.loadingEllipsis')
      : tOr('NotificationKindPrefs.summaryUnreadable', 'Your summary setting could not be read.');
  }
  const hour = `${String(digest.sendHour).padStart(2, '0')}:00`;
  if (digest.cadence === 'immediate') return t('DigestPreferenceScreen.leadImmediate');
  if (digest.cadence === 'weekly') {
    const dayKey = WEEKDAY_KEYS[digest.dayOfWeek];
    const day = dayKey ? t(dayKey) : '';
    return `${t('DigestPreferenceScreen.leadWeeklyPrefix')}${day}${t('DigestPreferenceScreen.leadWeeklyMid')}${hour}`;
  }
  return `${t('DigestPreferenceScreen.leadDailyPrefix')}${hour}`;
}
