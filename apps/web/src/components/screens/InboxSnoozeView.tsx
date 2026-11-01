'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { listSnoozed, snoozeBundle, unsnoozeBundle } from '../../lib/api/inbox-snooze';
import type {
  InboxSnooze,
  InboxSnoozeView as InboxSnoozeViewData,
} from '../../lib/api/inbox-snooze';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import '../../styles/screens/inbox.css';
import { appLocale } from '../../lib/i18n/app-locale';

export interface InboxSnoozeViewProps {
  organizationSlug: string;
  /** The bundle a "Snooze" control on an inbox row targets, if this view is rendered for one. */
  bundleId?: string;
  client?: ApiClient | undefined;
}

/** The three quick snooze horizons the menu offers, resolved to a future instant at click time. */
const HORIZONS: readonly { readonly labelKey: MessageKey; readonly hours: number }[] = [
  { labelKey: 'InboxSnoozeView.horizonLaterToday', hours: 3 },
  { labelKey: 'InboxSnoozeView.horizonTomorrow', hours: 24 },
  { labelKey: 'InboxSnoozeView.horizonNextWeek', hours: 24 * 7 },
];

/**
 * **INBOX snooze (IN-01/IN-02, x259)** — the snooze menu for one bundle row and the caller's snoozed
 * list, additive and disjoint from the inbox screen it sits beside.
 *
 * A faithful reader of the API's membership-scoped snoozes: it reads `GET .../inbox/snoozed` (behind
 * `work.read`, taking no membership id — the snoozes are the acting member's own), and offers a
 * bundle a snooze until a chosen horizon (`PUT .../inbox/{bundleId}/snooze`) and an un-snooze
 * (`DELETE`). Each horizon resolves to a future instant from a bound `Date` at click time, so the
 * server's future check is met without depending on any clock but the browser's.
 */
export function InboxSnoozeView({ organizationSlug, bundleId, client }: InboxSnoozeViewProps) {
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const t = useT();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const snoozed = useQuery({
    queryKey: ['inbox', 'snoozed', organizationSlug],
    queryFn: () => listSnoozed(api, organizationSlug),
  });

  const onSuccess = (result: InboxSnoozeViewData) => {
    queries.setQueryData(['inbox', 'snoozed', organizationSlug], result);
  };

  const snooze = useMutation({
    mutationFn: (hours: number): Promise<InboxSnoozeViewData> => {
      if (!bundleId) throw new Error('no bundle to snooze');
      const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
      return snoozeBundle(api, organizationSlug, bundleId, until);
    },
    onSuccess: (result) => {
      onSuccess(result);
      setMessage(t('InboxSnoozeView.snoozedMessage'));
    },
  });

  const unsnooze = useMutation({
    mutationFn: (id: string): Promise<InboxSnoozeViewData> =>
      unsnoozeBundle(api, organizationSlug, id),
    onSuccess: (result) => {
      onSuccess(result);
      setMessage(t('InboxSnoozeView.unsnoozedMessage'));
    },
  });

  const rows = useMemo<readonly InboxSnooze[]>(() => snoozed.data?.snoozes ?? [], [snoozed.data]);

  return (
    <section className="tm-card tm-inbox-panel" aria-labelledby="tm-inbox-snoozed">
      <h2 id="tm-inbox-snoozed" className="tm-card__title">
        {t('InboxSnoozeView.heading')}
      </h2>

      {bundleId ? (
        <div className="tm-row" role="group" aria-label={t('InboxSnoozeView.groupLabel')}>
          {HORIZONS.map((horizon) => (
            <Button
              key={horizon.hours}
              type="button"
              tone="outline"
              disabled={snooze.isPending}
              onClick={() => snooze.mutate(horizon.hours)}
            >
              {t(horizon.labelKey)}
            </Button>
          ))}
        </div>
      ) : null}

      {message ? (
        <InlineAlert tone="success" title={message} live>
          {message}
        </InlineAlert>
      ) : null}

      {snoozed.isError ? (
        <InlineAlert tone="danger" title={t('InboxSnoozeView.loadErrorTitle')} live>
          {describeError(snoozed.error)}
        </InlineAlert>
      ) : null}

      {snoozed.isPending ? (
        <LoadingRegion label={t('InboxSnoozeView.loading')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!snoozed.isPending && !snoozed.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title={t('InboxSnoozeView.emptyTitle')}>
          {t('InboxSnoozeView.emptyBody')}
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <ul className="tm-list" aria-label={t('InboxSnoozeView.listLabel')}>
          {rows.map((row) => (
            <li key={row.bundleId} className="tm-row">
              <span>{row.bundleId}</span>
              <time dateTime={row.snoozedUntil}>
                {t('InboxSnoozeView.until')}{' '}
                {new Date(row.snoozedUntil).toLocaleString(appLocale())}
              </time>
              <Button
                type="button"
                tone="text"
                disabled={unsnooze.isPending}
                onClick={() => unsnooze.mutate(row.bundleId)}
              >
                {t('InboxSnoozeView.unsnooze')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
