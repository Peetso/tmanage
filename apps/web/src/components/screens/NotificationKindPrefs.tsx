'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, Switch } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getNotificationKindPrefs,
  setNotificationKindPref,
  type NotificationKind,
} from '../../lib/api/notification-kind-prefs';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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

/**
 * **Per-kind notification opt-out (x152).**
 *
 * `38-MODULE-MAP` §Notifications — the finer opt-out beside the coarse channels/quiet-hours/digest
 * preference. A faithful reader of the API's membership-scoped per-kind settings: it reads
 * `GET .../notification-preferences/kinds` (behind `work.read`, taking no membership id — the settings
 * are the acting member's own) and shows one switch per kind. Flipping a switch is the action itself —
 * `PUT .../kinds/:kind` — and the whole set re-renders from the response.
 *
 * ## Additive and disjoint
 *
 * This screen owns only the per-kind opt-out region; it does not touch the coarse-preference surface,
 * and this slice stores the intent — a disabled kind is honoured at delivery time by a later slice.
 * Each switch is a real labelled control with a persistent hint, so the region is axe-clean.
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

  const setKind = useMutation({
    mutationFn: ({ kind, enabled }: { kind: NotificationKind; enabled: boolean }) =>
      setNotificationKindPref(api, organizationSlug, kind, { enabled }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
    },
  });

  const kinds = prefs.data?.kinds ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="inbox"
      title="Notification kinds"
      description="Choose which kinds of notification you want. Turning a kind off stops future notifications of that kind."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-notif-kinds-heading">
        <h2 id="tm-notif-kinds-heading" className="tm-eyebrow">
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
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!prefs.isPending && !prefs.isError
          ? kinds.map(({ kind, enabled }) => (
              <Switch
                key={kind}
                label={KIND_LABELS[kind].label}
                hint={KIND_LABELS[kind].hint}
                checked={enabled}
                disabled={setKind.isPending}
                onChange={(event) => setKind.mutate({ kind, enabled: event.target.checked })}
              />
            ))
          : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
