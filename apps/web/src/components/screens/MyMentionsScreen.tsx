'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { MentionView } from './MentionView';
import { browserApiClient } from '../../lib/api/browser-client';
import { listMyMentions } from '../../lib/api/my-mentions';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/chat.css';

export interface MyMentionsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **CHAT my-mentions (x254).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Chat — the caller's own mentions inbox. It reads the recent
 * messages that mention the acting member (newest first), each in a conversation the caller belongs to;
 * a message from a channel the caller is not in is dropped by the API, so no channel name or body leaks
 * from a room they cannot read.
 *
 * ## What it does, and what it cannot
 *
 * - **The list is the caller's own.** The API scopes it to the acting membership; there is no view of
 *   another member's mentions.
 * - **It only lists.** Jumping to a message opens its channel; posting and mentioning happen in the
 *   composer, elsewhere.
 */
export function MyMentionsScreen({
  organizationSlug,
  organizationName,
  client,
}: MyMentionsScreenProps) {
  const api = client ?? browserApiClient();

  const mentions = useQuery({
    queryKey: ['my-mentions', organizationSlug],
    queryFn: () => listMyMentions(api, organizationSlug),
  });

  const rows = mentions.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="chat"
      eyebrow="Chat"
      title="Your mentions"
      {...(rows.length > 0 ? { titleMeta: `${rows.length} recent` } : {})}
      description="Recent messages that mention you, newest first — only from channels you are in."
    >
      <section className="tm-stack" aria-labelledby="tm-mentions-heading">
        <h2 id="tm-mentions-heading" className="tm-chat-eyebrow">
          Recent mentions
        </h2>

        {mentions.isError ? (
          <InlineAlert tone="danger" title="Could not load your mentions" live>
            {describeError(mentions.error)}
          </InlineAlert>
        ) : null}

        {mentions.isPending ? (
          <LoadingRegion label="Loading your mentions.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!mentions.isPending && !mentions.isError && rows.length === 0 ? (
          <p className="tm-chat-empty">
            <span className="tm-chat-audience__orb" aria-hidden="true">
              @
            </span>
            <span>
              <strong>No mentions yet</strong>
              When someone mentions you in a channel you are in, it will appear here.
            </span>
          </p>
        ) : null}

        {rows.length > 0 ? (
          <ul className="tm-chat-mentions" aria-label="Your mentions">
            {rows.map((mention) => (
              <MentionView
                key={mention.messageId}
                organizationSlug={organizationSlug}
                mention={mention}
              />
            ))}
          </ul>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
