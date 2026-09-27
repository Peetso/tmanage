'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listMyMessageBookmarks } from '../../lib/api/message-bookmarks';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { MessageBookmarkView } from './MessageBookmarkView';

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
      title="Saved messages"
      description="Messages you have privately saved, across your conversations."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-saved-messages">
        <h2 id="tm-saved-messages" className="tm-eyebrow">
          My saved messages
        </h2>

        {saved.isPending ? (
          <LoadingRegion label="Loading your saved messages">
            <Skeleton />
            <Skeleton />
          </LoadingRegion>
        ) : saved.isError ? (
          <InlineAlert tone="danger" live>
            {saved.error instanceof ApiRequestError
              ? 'Your saved messages could not be loaded.'
              : saved.error instanceof NetworkError
                ? 'Could not reach the server. Try again.'
                : 'Something went wrong.'}
          </InlineAlert>
        ) : rows.length === 0 ? (
          <p className="tm-muted">You have not saved any messages yet.</p>
        ) : (
          <ul className="tm-stack">
            {rows.map((message) => (
              <li key={message.messageId} className="tm-panel">
                <p className="tm-message-body">
                  {message.body ?? <em className="tm-muted">This message was removed.</em>}
                </p>
                <p className="tm-muted tm-caption">
                  Saved {new Date(message.bookmarkedAt).toLocaleString()}
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
