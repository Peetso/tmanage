'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';
import { browserApiClient } from '../../lib/api/browser-client';
import { clearSearchHistory, listSearchHistory } from '../../lib/api/search-history';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';

export interface SearchHistoryListProps {
  organizationSlug: string;
  /** Called with a recent query when the member picks one — the search box re-runs it. */
  onSelect?: (query: string) => void;
  client?: ApiClient;
}

/**
 * **Search recent history (x288).**
 *
 * `22-SCREEN` SR: a "recent" list under the search box. This is that surface — the caller's own
 * recently-run queries (newest first, deduped and bounded by the API), each a button that re-runs
 * the query, plus a clear-all. Everything here is the caller's own: the API scopes the read and the
 * clear by tenant and membership, so the component renders what it is given.
 *
 * Recording a query is the search screen's job (it calls `recordSearch` after a successful search);
 * this component lists, selects and clears.
 */
export function SearchHistoryList({ organizationSlug, onSelect, client }: SearchHistoryListProps) {
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const t = useT();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const historyKey = ['search-history', organizationSlug];

  const history = useQuery({
    queryKey: historyKey,
    queryFn: () => listSearchHistory(api, organizationSlug),
  });

  const clear = useMutation({
    mutationFn: () => clearSearchHistory(api, organizationSlug),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: historyKey });
    },
  });

  const entries = history.data ?? [];

  if (!history.isPending && !history.isError && entries.length === 0) {
    return (
      <InlineAlert tone="neutral" title={t('SearchHistoryList.noRecentTitle')}>
        {t('SearchHistoryList.emptyBody')}
      </InlineAlert>
    );
  }

  return (
    <section className="tm-stack" aria-labelledby="tm-search-history-heading">
      <div className="tm-row">
        <h2 id="tm-search-history-heading" className="tm-eyebrow">
          {t('SearchHistoryList.recentHeading')}
        </h2>
        {entries.length > 0 ? (
          <Button
            type="button"
            tone="outline"
            size="accessible"
            onClick={() => clear.mutate()}
            disabled={clear.isPending}
          >
            {t('SearchHistoryList.clearAll')}
          </Button>
        ) : null}
      </div>
      {history.isError ? (
        <InlineAlert tone="danger" title={t('SearchHistoryList.loadError')} live>
          {describeError(history.error)}
        </InlineAlert>
      ) : null}
      {clear.isError ? (
        <InlineAlert tone="danger" title={t('SearchHistoryList.clearError')} live>
          {describeError(clear.error)}
        </InlineAlert>
      ) : null}
      {entries.length > 0 ? (
        <ul className="tm-stack tm-list" aria-label={t('SearchHistoryList.listAria')}>
          {entries.map((entry) => (
            <li key={`${entry.recordedAt}:${entry.query}`} className="tm-row">
              <Button
                type="button"
                tone="text"
                size="accessible"
                onClick={() => onSelect?.(entry.query)}
              >
                {entry.query}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
