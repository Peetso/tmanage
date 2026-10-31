'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { SearchField } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { listPlatformOrgs } from '../../../lib/api/platform-organizations';
import type { PlatformOrgSummaryView } from '../../../lib/api/platform-organizations';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import type { PlatformColumn } from '../shared/PlatformTable';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';

/** `/platform/content` — content lives under one organization (B5); pick it here. */
export function PlatformContentPickerScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <PlatformGate
      api={api}
      section="content"
      crumbs={[t('PlatformContent.crumb')]}
      title={t('PlatformContent.pickTitle')}
      description={t('PlatformContent.pickSubtitle')}
    >
      {() => <PickerBody api={api} />}
    </PlatformGate>
  );
}

function PickerBody({ api }: { api: ApiClient }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const filters = debounced ? { q: debounced } : {};
  const list = useInfiniteQuery({
    queryKey: ['platform', 'orgs', 'content-picker', filters],
    queryFn: ({ pageParam }) =>
      listPlatformOrgs(api, { ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((page) => page.organizations) ?? [];
  const columns: readonly PlatformColumn<PlatformOrgSummaryView>[] = [
    {
      id: 'org',
      header: t('PlatformOrgs.colOrganization'),
      cell: (row) => (
        <div className="tm-stack tm-stack--tight">
          <Link className="tm-cc-cell-title" href={`/platform/organizations/${row.id}/content`}>
            {row.name}
          </Link>
          <span className="tm-cc-cell-mono">{row.slug}</span>
        </div>
      ),
    },
    {
      id: 'open',
      header: '',
      cell: (row) => (
        <Link className="tm-cc-row-button" href={`/platform/organizations/${row.id}/content`}>
          {t('PlatformContent.pickOpen')}
        </Link>
      ),
    },
  ];
  return (
    <div className="tm-stack">
      <SearchField
        label={t('PlatformOrgs.searchLabel')}
        placeholder={t('PlatformOrgs.searchPlaceholder')}
        value={q}
        onChange={(event) => setQ(event.target.value)}
      />
      {list.isPending ? <PlatformPageState state="loading" /> : null}
      {list.isError ? (
        <PlatformPageState state="error" error={list.error} onRetry={() => void list.refetch()} />
      ) : null}
      {list.isSuccess && rows.length === 0 ? (
        <PlatformPageState
          state="empty"
          title={t('PlatformOrgs.noMatchesTitle')}
          body={t('PlatformOrgs.noMatchesBody')}
        />
      ) : null}
      {list.isSuccess && rows.length > 0 ? (
        <PlatformTable
          label={t('PlatformContent.pickTitle')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          isMuted={(row) => row.status !== 'active'}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
        />
      ) : null}
    </div>
  );
}
