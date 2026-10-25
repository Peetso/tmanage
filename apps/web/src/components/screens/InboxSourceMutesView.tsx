'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  listSourceMutes,
  muteSource,
  mutedSourceKeys,
  unmuteSource,
} from '../../lib/api/inbox-source-mutes';
import type {
  InboxMuteObjectType,
  InboxSourceMute,
  InboxSourceMutesView as InboxSourceMutesViewData,
} from '../../lib/api/inbox-source-mutes';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import '../../styles/screens/inbox.css';

export interface InboxSourceMutesViewProps {
  organizationSlug: string;
  /** The source an inbox row's mute toggle targets, if this view is rendered for one. */
  source?: { readonly objectType: InboxMuteObjectType; readonly objectId: string };
  client?: ApiClient | undefined;
}

/** A message key for an object-type prefix, for the muted-sources list. */
const TYPE_LABEL_KEYS: Readonly<Record<InboxMuteObjectType, MessageKey>> = {
  work_item: 'InboxSourceMutesView.typeWorkItem',
  client_request: 'InboxSourceMutesView.typeRequest',
  organization_usage: 'InboxSourceMutesView.typeUsageNotice',
};

/**
 * **INBOX source mutes (x318)** — a mute toggle for one inbox source row and the caller's muted-sources
 * list, additive and disjoint from the inbox screen it sits beside.
 *
 * A faithful reader of the API's member-scoped mutes: it reads `GET .../inbox/source-mutes` (behind
 * `work.read`, taking no member id — the mutes are the acting member's own), toggles a source's mute
 * (`PUT`/`DELETE .../inbox/source-mutes`), and lists them. Muting is a self-scoped read-side filter:
 * a muted source's bundle is excluded from the caller's inbox (via `filterMutedInbox`); dispatch is
 * unchanged.
 */
export function InboxSourceMutesView({
  organizationSlug,
  source,
  client,
}: InboxSourceMutesViewProps) {
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const t = useT();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const muted = useQuery({
    queryKey: ['inbox', 'source-mutes', organizationSlug],
    queryFn: () => listSourceMutes(api, organizationSlug),
  });

  const setData = (result: InboxSourceMutesViewData) => {
    queries.setQueryData(['inbox', 'source-mutes', organizationSlug], result);
  };

  const rows = useMemo<readonly InboxSourceMute[]>(() => muted.data?.mutes ?? [], [muted.data]);
  const isMuted = useMemo<boolean>(() => {
    if (!source) return false;
    return mutedSourceKeys(rows).has(`${source.objectType}\u0000${source.objectId}`);
  }, [rows, source]);

  const mute = useMutation({
    mutationFn: (): Promise<InboxSourceMutesViewData> => {
      if (!source) throw new Error('no source to mute');
      return muteSource(api, organizationSlug, source.objectType, source.objectId);
    },
    onSuccess: (result) => {
      setData(result);
      setMessage(t('InboxSourceMutesView.mutedMessage'));
    },
  });

  const unmute = useMutation({
    mutationFn: async (item: InboxSourceMute): Promise<void> => {
      await unmuteSource(api, organizationSlug, item.objectType, item.objectId);
    },
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ['inbox', 'source-mutes', organizationSlug] });
      setMessage(t('InboxSourceMutesView.unmutedMessage'));
    },
  });

  return (
    <section className="tm-card tm-inbox-panel" aria-labelledby="tm-inbox-muted">
      <h2 id="tm-inbox-muted" className="tm-card__title">
        {t('InboxSourceMutesView.heading')}
      </h2>

      {source ? (
        <div className="tm-row" role="group" aria-label={t('InboxSourceMutesView.groupLabel')}>
          <Button
            type="button"
            tone="outline"
            disabled={mute.isPending || unmute.isPending || isMuted}
            onClick={() => mute.mutate()}
          >
            {isMuted ? t('InboxSourceMutesView.muted') : t('InboxSourceMutesView.muteThisSource')}
          </Button>
        </div>
      ) : null}

      {message ? (
        <InlineAlert tone="success" title={message} live>
          {message}
        </InlineAlert>
      ) : null}

      {muted.isError ? (
        <InlineAlert tone="danger" title={t('InboxSourceMutesView.loadErrorTitle')} live>
          {describeError(muted.error)}
        </InlineAlert>
      ) : null}

      {muted.isPending ? (
        <LoadingRegion label={t('InboxSourceMutesView.loading')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!muted.isPending && !muted.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title={t('InboxSourceMutesView.emptyTitle')}>
          {t('InboxSourceMutesView.emptyBody')}
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <ul className="tm-list" aria-label={t('InboxSourceMutesView.listLabel')}>
          {rows.map((row) => (
            <li key={`${row.objectType}:${row.objectId}`} className="tm-row">
              <span>
                {t(TYPE_LABEL_KEYS[row.objectType])} · {row.objectId}
              </span>
              <Button
                type="button"
                tone="text"
                disabled={unmute.isPending}
                onClick={() => unmute.mutate(row)}
              >
                {t('InboxSourceMutesView.unmute')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
