'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getNotificationKindPrefs,
  setNotificationKindPref,
  type NotificationKind,
} from '../../lib/api/notification-kind-prefs';
import { getQuietHours } from '../../lib/api/quiet-hours';
import {
  effectiveQuietHours,
  getNotificationPreferences,
} from '../../lib/api/notification-preferences';
import { getDigestPreference, type DigestPrefView } from '../../lib/api/digest';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import '../../styles/screens/preferences.css';

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

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * **Notifications (PREF-03; per-kind notification opt-out, x152).**
 *
 * PREF-03's frame: "What reaches you, and how" — a per-event table on the left, the quiet-hours and
 * daily-summary cards on the right. A faithful reader of the API's membership-scoped per-kind
 * settings: it reads `GET .../notification-preferences/kinds` (behind `work.read`, the acting
 * member's own) and shows one switch per kind. Flipping a switch is the action itself —
 * `PUT .../kinds/:kind` — and the whole set re-renders from the response. The two side cards read
 * the member's quiet hours and digest cadence and link to the screens that edit them.
 *
 * The API stores one on/off per kind, so the table has one channel column; the design's separate
 * email and push columns wait for per-channel settings.
 */
export function NotificationKindPrefs({
  organizationSlug,
  organizationName,
  client,
}: NotificationKindPrefsProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const queryClient = useQueryClient();
  const queryKey = ['notification-kind-prefs', organizationSlug];

  const prefs = useQuery({
    queryKey,
    queryFn: () => getNotificationKindPrefs(api, organizationSlug),
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

  const setKind = useMutation({
    mutationFn: ({ kind, enabled }: { kind: NotificationKind; enabled: boolean }) =>
      setNotificationKindPref(api, organizationSlug, kind, { enabled }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
    },
  });

  const kinds = prefs.data?.kinds ?? [];
  const quiet =
    quietHours.data && !notification.isPending
      ? effectiveQuietHours(quietHours.data, notification.data)
      : undefined;

  return (
    <AppShell
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

          {setKind.isError ? (
            <InlineAlert tone="danger" title={t('NotificationKindPrefs.saveError')} live>
              {describeError(setKind.error)}
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
              <div className="tm-prefs-table">
                <div className="tm-prefs-table__head" aria-hidden="true">
                  <span className="tm-prefs-table__event">
                    {t('NotificationKindPrefs.whenThisHappens')}
                  </span>
                  <span className="tm-prefs-table__channel">
                    {t('NotificationKindPrefs.notifyMe')}
                  </span>
                </div>
                {kinds.map(({ kind, enabled }) => {
                  const id = `tm-notif-kind-${kind}`;
                  return (
                    <div className="tm-prefs-table__row" key={kind}>
                      <span className="tm-prefs-table__event">
                        <label className="tm-prefs-table__label" htmlFor={id}>
                          {t(KIND_LABEL_KEYS[kind].label)}
                        </label>
                        <span className="tm-prefs-table__hint" id={`${id}-hint`}>
                          {t(KIND_LABEL_KEYS[kind].hint)}
                        </span>
                      </span>
                      <span className="tm-prefs-table__channel">
                        <input
                          id={id}
                          type="checkbox"
                          role="switch"
                          className="tm-prefs-check"
                          checked={enabled}
                          disabled={setKind.isPending}
                          aria-describedby={`${id}-hint`}
                          onChange={(event) =>
                            setKind.mutate({ kind, enabled: event.target.checked })
                          }
                        />
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="tm-prefs-legend">
                <span className="tm-prefs-legend__item">
                  <span className="tm-prefs-legend__swatch" aria-hidden="true" />
                  {t('NotificationKindPrefs.legend')}
                </span>
              </p>
            </>
          ) : null}
        </section>

        <div className="tm-prefs__side">
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
            <p className="tm-prefs-card__lead">{describeDigest(digest.data, digest.isPending)}</p>
            <p className="tm-prefs-card__note">{t('NotificationKindPrefs.summaryNote')}</p>
            <div className="tm-prefs-card__foot">
              <Link className="tm-prefs-capsule" href={`/${organizationSlug}/settings/digest`}>
                {t('NotificationKindPrefs.changeSummary')}
              </Link>
            </div>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

function describeDigest(digest: DigestPrefView | undefined, pending: boolean): string {
  if (!digest || typeof digest.cadence !== 'string') {
    return pending ? 'Loading…' : 'Your summary setting could not be read.';
  }
  const hour = `${String(digest.sendHour).padStart(2, '0')}:00`;
  if (digest.cadence === 'immediate') return 'Each notification is sent as it happens';
  if (digest.cadence === 'weekly') {
    return `One email every ${WEEKDAYS[digest.dayOfWeek] ?? 'week'} at ${hour}`;
  }
  return `One email a day at ${hour}`;
}
