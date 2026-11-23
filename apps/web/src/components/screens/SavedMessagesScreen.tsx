'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState } from '../help/TeachingEmptyState';
import { listMyMessageBookmarks } from '../../lib/api/message-bookmarks';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { MessageBookmarkView } from './MessageBookmarkView';
import { appIntlLocale } from '../../lib/i18n/app-locale';

export interface SavedMessagesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const savedMessagesKey = (organizationSlug: string) =>
  ['message-bookmarks', organizationSlug] as const;

/**
 * x248 — **My Saved Messages** (CH-07). The list half, paired with {@link MessageBookmarkView}: a
 * member's privately saved chat messages across conversations, newest first.
 *
 * The list follows readability: the API returns only saved messages in conversations the caller
 * still reads, and a moderated message comes back with its body withheld — drawn here as a
 * tombstone rather than empty. Each row carries the same Save toggle used on the message itself, so
 * unsaving here removes the row on the next refetch.
 */
export function SavedMessagesScreen({
  organizationSlug,
  organizationName,
  client,
}: SavedMessagesScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();

  const saved = useQuery({
    queryKey: savedMessagesKey(organizationSlug),
    queryFn: () => listMyMessageBookmarks(api, organizationSlug),
  });

  const rows = saved.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="chat"
      title={t('SavedMessagesScreen.title')}
      description={t('SavedMessagesScreen.description')}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-saved-messages">
        <h2 id="tm-saved-messages" className="tm-eyebrow">
          {t('SavedMessagesScreen.heading')}
        </h2>

        {saved.isPending ? (
          <LoadingRegion label={t('SavedMessagesScreen.loading')}>
            <Skeleton />
            <Skeleton />
          </LoadingRegion>
        ) : saved.isError ? (
          <InlineAlert tone="danger" live>
            {saved.error instanceof ApiRequestError
              ? t('SavedMessagesScreen.loadFailedApi')
              : saved.error instanceof NetworkError
                ? t('SavedMessagesScreen.loadFailedNetwork')
                : t('SavedMessagesScreen.loadFailedGeneric')}
          </InlineAlert>
        ) : rows.length === 0 ? (
          <TeachingEmptyState
            title={t('teachEmpty.savedMessagesTitle')}
            explanation={t('teachEmpty.savedMessagesBody')}
          />
        ) : (
          <ul className="tm-stack">
            {rows.map((message) => (
              <li key={message.messageId} className="tm-panel">
                <p className="tm-message-body">
                  {message.body ?? (
                    <em className="tm-muted">{t('SavedMessagesScreen.messageRemoved')}</em>
                  )}
                </p>
                <p className="tm-muted tm-caption">
                  {t('SavedMessagesScreen.savedPrefix')}
                  {new Date(message.bookmarkedAt).toLocaleString(appIntlLocale())}
                </p>
                <MessageBookmarkView
                  organizationSlug={organizationSlug}
                  conversationId={message.conversationId}
                  messageId={message.messageId}
                  initialSaved
                  client={api}
                  onChange={() => {
                    void queries.invalidateQueries({
                      queryKey: savedMessagesKey(organizationSlug),
                    });
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
