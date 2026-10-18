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
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/inbox.css';

export interface InboxSnoozeViewProps {
  organizationSlug: string;
  /** The bundle a "Snooze" control on an inbox row targets, if this view is rendered for one. */
  bundleId?: string;
  client?: ApiClient | undefined;
}

/** The three quick snooze horizons the menu offers, resolved to a future instant at click time. */
const HORIZONS: readonly { readonly label: string; readonly hours: number }[] = [
  { label: 'Later today (3h)', hours: 3 },
  { label: 'Tomorrow', hours: 24 },
  { label: 'Next week', hours: 24 * 7 },
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
      setMessage('Snoozed. It will return to your inbox then.');
    },
  });

  const unsnooze = useMutation({
    mutationFn: (id: string): Promise<InboxSnoozeViewData> =>
      unsnoozeBundle(api, organizationSlug, id),
    onSuccess: (result) => {
      onSuccess(result);
      setMessage('Un-snoozed.');
    },
  });

  const rows = useMemo<readonly InboxSnooze[]>(() => snoozed.data?.snoozes ?? [], [snoozed.data]);

  return (
    <section className="tm-card tm-inbox-panel" aria-labelledby="tm-inbox-snoozed">
      <h2 id="tm-inbox-snoozed" className="tm-card__title">
        Snoozed
      </h2>

      {bundleId ? (
        <div className="tm-row" role="group" aria-label="Snooze this item">
          {HORIZONS.map((horizon) => (
            <Button
              key={horizon.hours}
              type="button"
              tone="outline"
              disabled={snooze.isPending}
              onClick={() => snooze.mutate(horizon.hours)}
            >
              {horizon.label}
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
        <InlineAlert tone="danger" title="Could not load your snoozed items" live>
          {describeError(snoozed.error)}
        </InlineAlert>
      ) : null}

      {snoozed.isPending ? (
        <LoadingRegion label="Loading your snoozed items.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!snoozed.isPending && !snoozed.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="Nothing snoozed">
          Snooze an inbox item to hide it until a time you choose; it returns to your inbox then.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <ul className="tm-list" aria-label="Snoozed items">
          {rows.map((row) => (
            <li key={row.bundleId} className="tm-row">
              <span>{row.bundleId}</span>
              <time dateTime={row.snoozedUntil}>
                until {new Date(row.snoozedUntil).toLocaleString()}
              </time>
              <Button
                type="button"
                tone="text"
                disabled={unsnooze.isPending}
                onClick={() => unsnooze.mutate(row.bundleId)}
              >
                Un-snooze
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
