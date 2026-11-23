'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  listWatchers,
  subscribeToWorkItem,
  unsubscribeFromWorkItem,
  type ItemWatcher,
} from '../../lib/api/work-items';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { appIntlLocale } from '../../lib/i18n/app-locale';

export interface WorkWatchersPanelProps {
  organizationSlug: string;
  workItemId: string;
  api: ApiClient;
}

function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(appIntlLocale());
}

/**
 * **x232 — a work item's watchers / subscribers.** (Work module 7; the audit's "Work built; no
 * watcher/subscriber model".)
 *
 * The smallest useful unit of the watch list: subscribe yourself to an item so a later
 * notification path can reach you, unsubscribe yourself, and see who else is watching. Behind
 * `work.read` — anyone who may read the item may watch it. No notification is dispatched here;
 * that path is the notifications module and a later slice.
 *
 * It is mounted additively beside the rest of the detail screen (and disjoint from the checklist
 * and comments panels), reads its own query, and invalidates that query on every write so the
 * roster reflects the server. The toggle drives idempotent PUT/DELETE — a repeat is harmless.
 */
export function WorkWatchersPanel({ organizationSlug, workItemId, api }: WorkWatchersPanelProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const queries = useQueryClient();
  const queryKey = ['work-item-watchers', organizationSlug, workItemId] as const;
  const [watching, setWatching] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const watchers = useQuery({
    queryKey,
    queryFn: () => listWatchers(api, organizationSlug, workItemId),
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const subscribe = useMutation({
    mutationFn: () => subscribeToWorkItem(api, organizationSlug, workItemId),
    onSuccess: () => {
      setWatching(true);
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const unsubscribe = useMutation({
    mutationFn: () => unsubscribeFromWorkItem(api, organizationSlug, workItemId),
    onSuccess: () => {
      setWatching(false);
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const items: readonly ItemWatcher[] = watchers.data ?? [];
  const pending = subscribe.isPending || unsubscribe.isPending;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-work-watchers">
      <h2 id="tm-work-watchers" className="tm-eyebrow">
        {t('WorkWatchersPanel.heading')}
      </h2>

      {watchers.isPending ? (
        <LoadingRegion label={t('WorkWatchersPanel.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {watchers.isError ? (
        <InlineAlert tone="danger" title={t('WorkWatchersPanel.loadError')} live>
          {describe(watchers.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title={t('WorkWatchersPanel.failureTitle')} live>
          {failure}
        </InlineAlert>
      ) : null}

      <div className="tm-row">
        {watching ? (
          <Button
            type="button"
            tone="outline"
            size="accessible"
            loading={unsubscribe.isPending}
            loadingLabel={t('WorkWatchersPanel.updating')}
            disabled={pending}
            onClick={() => unsubscribe.mutate()}
          >
            {t('WorkWatchersPanel.stopWatching')}
          </Button>
        ) : (
          <Button
            type="button"
            tone="ink"
            size="accessible"
            loading={subscribe.isPending}
            loadingLabel={t('WorkWatchersPanel.updating')}
            disabled={pending}
            onClick={() => subscribe.mutate()}
          >
            {t('WorkWatchersPanel.watch')}
          </Button>
        )}
      </div>

      {watchers.data ? (
        items.length === 0 ? (
          <p className="tm-prose">{t('WorkWatchersPanel.empty')}</p>
        ) : (
          <ul className="tm-list" aria-label={t('WorkWatchersPanel.listLabel')}>
            {items.map((watcher) => (
              <li key={watcher.id} className="tm-stack">
                <p className="tm-prose">{watcher.memberId}</p>
                <time className="tm-eyebrow" dateTime={watcher.createdAt}>
                  {formatWhen(watcher.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
