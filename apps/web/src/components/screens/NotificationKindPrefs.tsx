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
import { getDigestPreference, type DigestPrefView } from '../../lib/api/digest';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/preferences.css';

export interface NotificationKindPrefsProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** What each kind is called on screen, and the one-line description read with its switch. */
const KIND_LABELS: Readonly<Record<NotificationKind, { label: string; hint: string }>> = {
  client_request: {
    label: 'Client requests',
    hint: 'When a client submits or moves a request.',
  },
  work_item: {
    label: 'Work updates',
    hint: 'When a work item you follow changes or becomes blocked.',
  },
  message: {
    label: 'Messages',
    hint: 'When a new message is posted in a channel you are in.',
  },
  file: {
    label: 'Files',
    hint: 'When a file is ready, rejected, or removed.',
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
  const api = client ?? browserApiClient();
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
  const quiet = quietHours.data;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="inbox"
      eyebrow="Preferences · Notifications"
      title="What reaches you, and how"
      description="Turning a kind off stops future notifications of that kind."
    >
      <div className="tm-prefs tm-prefs--notifications">
        <section className="tm-prefs__main" aria-labelledby="tm-notif-kinds-heading">
          <h2 id="tm-notif-kinds-heading" className="tm-visually-hidden">
            Notification kinds
          </h2>

          {prefs.isError ? (
            <InlineAlert tone="danger" title="Could not load your notification settings" live>
              {describeError(prefs.error)}
            </InlineAlert>
          ) : null}

          {setKind.isError ? (
            <InlineAlert tone="danger" title="Could not save that change" live>
              {describeError(setKind.error)}
            </InlineAlert>
          ) : null}

          {prefs.isPending ? (
            <LoadingRegion label="Loading your notification settings.">
              <Skeleton height="46px" />
              <Skeleton height="46px" />
            </LoadingRegion>
          ) : null}

          {!prefs.isPending && !prefs.isError ? (
            <>
              <div className="tm-prefs-table">
                <div className="tm-prefs-table__head" aria-hidden="true">
                  <span className="tm-prefs-table__event">When this happens</span>
                  <span className="tm-prefs-table__channel">Notify me</span>
                </div>
                {kinds.map(({ kind, enabled }) => {
                  const id = `tm-notif-kind-${kind}`;
                  return (
                    <div className="tm-prefs-table__row" key={kind}>
                      <span className="tm-prefs-table__event">
                        <label className="tm-prefs-table__label" htmlFor={id}>
                          {KIND_LABELS[kind].label}
                        </label>
                        <span className="tm-prefs-table__hint" id={`${id}-hint`}>
                          {KIND_LABELS[kind].hint}
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
                  your choice — saved the moment you tick it
                </span>
              </p>
            </>
          ) : null}
        </section>

        <div className="tm-prefs__side">
          <section className="tm-prefs-card tm-prefs-card--tight" aria-labelledby="tm-quiet-card">
            <h2 id="tm-quiet-card" className="tm-prefs-card__title">
              Quiet hours
            </h2>
            <p className="tm-prefs-card__body">
              {quiet && typeof quiet.enabled === 'boolean'
                ? quiet.enabled
                  ? `${quiet.startTime} – ${quiet.endTime} ${quiet.timezone}. Notifications wait until the window ends.`
                  : 'Off. Notifications arrive whenever they happen.'
                : quietHours.isPending
                  ? 'Loading…'
                  : 'Your quiet hours could not be read.'}
            </p>
            <Link className="tm-prefs-capsule" href={`/${organizationSlug}/settings/quiet-hours`}>
              Change quiet hours
            </Link>
          </section>

          <section
            className="tm-prefs-card tm-prefs-card--paper tm-prefs-card--grow"
            aria-labelledby="tm-digest-card"
          >
            <h2 id="tm-digest-card" className="tm-prefs-eyebrow">
              Summary email
            </h2>
            <p className="tm-prefs-card__lead">{describeDigest(digest.data, digest.isPending)}</p>
            <p className="tm-prefs-card__note">
              How often your notifications are bundled into one email.
            </p>
            <div className="tm-prefs-card__foot">
              <Link className="tm-prefs-capsule" href={`/${organizationSlug}/settings/digest`}>
                Change the summary
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

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
