'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  addMessageReaction,
  getMessageReactions,
  removeMessageReaction,
  type MessageReactionTally,
} from '../../lib/api/message-reactions';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface MessageReactionsViewProps {
  organizationSlug: string;
  /** The channel and message the reactions hang off — carried in the route/props. */
  conversationId: string;
  messageId: string;
  client?: ApiClient;
}

/**
 * **CH-07 "Message actions" — the reaction bar under a message (x246).**
 *
 * A row of chips, one per reaction the studio allows. Each shows its emoji and, when anyone has
 * reacted, its count; a chip the acting member has pressed is drawn pressed (`aria-pressed`) so
 * the state is not colour alone. Clicking a chip toggles the member's own reaction — add if they
 * have not reacted with it, remove if they have — and the API answers the whole tally, so the bar
 * redraws its counts from the response rather than guessing.
 *
 * The reaction is the member's own: the API scopes every add and remove to the acting
 * membership, so this bar can only ever change the current member's reactions, never anyone
 * else's. A message in a channel the member cannot reach, or in another studio, is a 404 from the
 * API and the bar shows nothing rather than confirming the message exists.
 *
 * The allowlist is duplicated here only to lay out the chips; the API validates it
 * authoritatively and refuses anything outside it, so this list is presentation, not a trust
 * decision.
 */
const ALLOWED_REACTIONS: readonly { emoji: string; label: string }[] = [
  { emoji: '\u{1F44D}', label: 'Thumbs up' },
  { emoji: '\u{1F44E}', label: 'Thumbs down' },
  { emoji: '❤️', label: 'Heart' },
  { emoji: '\u{1F389}', label: 'Celebrate' },
  { emoji: '\u{1F604}', label: 'Smile' },
  { emoji: '\u{1F615}', label: 'Confused' },
  { emoji: '\u{1F680}', label: 'Rocket' },
  { emoji: '\u{1F440}', label: 'Eyes' },
];

function messageOf(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Try again.';
}

export function MessageReactionsView({
  organizationSlug,
  conversationId,
  messageId,
  client,
}: MessageReactionsViewProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const queryKey = ['message-reactions', organizationSlug, conversationId, messageId] as const;

  const tally = useQuery({
    queryKey,
    queryFn: () => getMessageReactions(api, organizationSlug, conversationId, messageId),
  });

  const toggle = useMutation({
    mutationFn: ({ emoji, reacted }: { emoji: string; reacted: boolean }) =>
      reacted
        ? removeMessageReaction(api, organizationSlug, conversationId, messageId, emoji).then(() =>
            getMessageReactions(api, organizationSlug, conversationId, messageId),
          )
        : addMessageReaction(api, organizationSlug, conversationId, messageId, emoji),
    onSuccess: (next: MessageReactionTally) => {
      queries.setQueryData(queryKey, next);
    },
  });

  const counts = useMemo(() => {
    const map = new Map<string, { count: number; reacted: boolean }>();
    for (const row of tally.data?.reactions ?? []) {
      map.set(row.emoji, { count: row.count, reacted: row.reacted });
    }
    return map;
  }, [tally.data]);

  if (tally.isLoading) {
    return (
      <div className="tm-message-reactions" role="group" aria-label="Reactions" aria-busy="true">
        <Skeleton width="12rem" />
      </div>
    );
  }
  if (tally.isError) {
    return <InlineAlert tone="danger">{messageOf(tally.error)}</InlineAlert>;
  }

  return (
    <div className="tm-message-reactions" role="group" aria-label="Reactions">
      {ALLOWED_REACTIONS.map(({ emoji, label }) => {
        const state = counts.get(emoji);
        const reacted = state?.reacted ?? false;
        const count = state?.count ?? 0;
        return (
          <Button
            key={emoji}
            tone={reacted ? 'lime' : 'outline'}
            size="compact"
            aria-pressed={reacted}
            aria-label={count > 0 ? `${label}, ${count}` : label}
            loading={toggle.isPending}
            onClick={() => toggle.mutate({ emoji, reacted })}
          >
            <span aria-hidden="true">{emoji}</span>
            {count > 0 ? <span aria-hidden="true"> {count}</span> : null}
          </Button>
        );
      })}
      {toggle.isError ? <InlineAlert tone="danger">{messageOf(toggle.error)}</InlineAlert> : null}
    </div>
  );
}
