'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  addMessageReaction,
  getMessageReactions,
  getMessageReactionsBatched,
  removeMessageReaction,
  type MessageReactionTally,
} from '../../lib/api/message-reactions';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import type { MessageKey } from '../../lib/i18n/t';

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
export const ALLOWED_REACTIONS: readonly {
  emoji: string;
  labelKey: MessageKey;
  /** English fallback for a key the committer has not merged into the catalogs yet (A16). */
  english?: string;
}[] = [
  { emoji: '\u{1F44D}', labelKey: 'MessageReactionsView.thumbsUp' },
  { emoji: '\u{1F44E}', labelKey: 'MessageReactionsView.thumbsDown' },
  { emoji: '❤️', labelKey: 'MessageReactionsView.heart' },
  { emoji: '\u{1F389}', labelKey: 'MessageReactionsView.celebrate' },
  { emoji: '\u{1F604}', labelKey: 'MessageReactionsView.smile' },
  { emoji: '\u{1F615}', labelKey: 'MessageReactionsView.confused' },
  { emoji: '\u{1F680}', labelKey: 'MessageReactionsView.rocket' },
  { emoji: '\u{1F440}', labelKey: 'MessageReactionsView.eyes' },
  // A16: the approved Figma's quick reactions (♥ ✓ ☺ ★); the API allowlist carries them too.
  { emoji: '\u{2713}', labelKey: 'MessageReactionsView.check' as MessageKey, english: 'Done' },
  { emoji: '\u{263A}', labelKey: 'MessageReactionsView.smiling' as MessageKey, english: 'Smiling' },
  { emoji: '\u{2605}', labelKey: 'MessageReactionsView.star' as MessageKey, english: 'Star' },
];

/** The four reactions the channel offers first — the sheet's quick row and the pill bar's order. */
export const QUICK_REACTIONS: readonly string[] = ['❤️', '\u{2713}', '\u{263A}', '\u{2605}'];

/** A reaction's accessible name, falling back to English for a not-yet-merged key. */
export function reactionLabel(
  emoji: string,
  tOr: (key: string, english: string) => string,
  t: (key: MessageKey) => string,
): string {
  const entry = ALLOWED_REACTIONS.find((reaction) => reaction.emoji === emoji);
  if (entry === undefined) return emoji;
  return entry.english === undefined ? t(entry.labelKey) : tOr(entry.labelKey, entry.english);
}

/**
 * A16: one message's reaction tally and the member's own toggle, shared by the channel's pill bar
 * and the phone actions sheet so both draw the same answer from the same cache entry.
 */
export function useMessageReactionTally(
  api: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
) {
  const queries = useQueryClient();
  const queryKey = ['message-reactions', organizationSlug, conversationId, messageId] as const;
  const tally = useQuery({
    queryKey,
    // C5: read with the other messages on screen in one batched request, not one GET each.
    queryFn: () => getMessageReactionsBatched(api, organizationSlug, conversationId, messageId),
    staleTime: 30_000,
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
  const rows = tally.data?.reactions ?? [];
  const react = (emoji: string) => {
    const reacted = rows.find((row) => row.emoji === emoji)?.reacted ?? false;
    toggle.mutate({ emoji, reacted });
  };
  return { tally, toggle, rows, react };
}

/**
 * A16 — the Figma's reaction pills under a message: only reactions someone has used, each with
 * its count (the member's own drawn pressed), then a "☺ +" pill that opens the full picker.
 * `MessageReactionsView` below stays the full chip bar for the screens that already use it.
 */
export function MessageReactionPills({
  api,
  organizationSlug,
  conversationId,
  messageId,
  pickerOpen,
  onPickerOpenChange,
  showAdd = true,
}: {
  api: ApiClient;
  organizationSlug: string;
  conversationId: string;
  messageId: string;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  showAdd?: boolean;
}) {
  const t = useT();
  const tOr = useTOr();
  const { rows, react, toggle } = useMessageReactionTally(
    api,
    organizationSlug,
    conversationId,
    messageId,
  );
  const used = rows.filter((row) => row.count > 0);
  if (used.length === 0 && !pickerOpen) return null;

  return (
    <div
      className="tm-chat-reacts"
      role="group"
      aria-label={t('MessageReactionsView.reactionsGroup')}
    >
      {used.map((row) => {
        const label = reactionLabel(row.emoji, tOr, t);
        return (
          <button
            key={row.emoji}
            type="button"
            className="tm-chat-react"
            aria-pressed={row.reacted}
            aria-label={`${label}, ${row.count}`}
            disabled={toggle.isPending}
            onClick={() => react(row.emoji)}
          >
            <span aria-hidden="true">
              {row.emoji} {row.count}
            </span>
          </button>
        );
      })}
      {showAdd && used.length > 0 ? (
        <button
          type="button"
          className="tm-chat-react"
          aria-expanded={pickerOpen}
          aria-label={tOr('ProjectChannelScreen.addReaction', 'Add a reaction')}
          onClick={() => onPickerOpenChange(!pickerOpen)}
        >
          <span aria-hidden="true">{'\u{263A}'} +</span>
        </button>
      ) : null}
      {pickerOpen ? (
        <div
          className="tm-chat-react-picker"
          role="group"
          aria-label={tOr('ProjectChannelScreen.addReaction', 'Add a reaction')}
        >
          {ALLOWED_REACTIONS.map(({ emoji }) => (
            <button
              key={emoji}
              type="button"
              className="tm-chat-react-picker__item"
              aria-label={reactionLabel(emoji, tOr, t)}
              disabled={toggle.isPending}
              onClick={() => {
                react(emoji);
                onPickerOpenChange(false);
              }}
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
        </div>
      ) : null}
      {toggle.isError ? (
        <InlineAlert tone="danger">{messageOf(t, toggle.error)}</InlineAlert>
      ) : null}
    </div>
  );
}

function messageOf(t: (key: MessageKey) => string, error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return t('MessageReactionsView.errorGeneric');
}

export function MessageReactionsView({
  organizationSlug,
  conversationId,
  messageId,
  client,
}: MessageReactionsViewProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const tOr = useTOr();
  const queries = useQueryClient();
  const queryKey = ['message-reactions', organizationSlug, conversationId, messageId] as const;

  const tally = useQuery({
    queryKey,
    queryFn: () => getMessageReactionsBatched(api, organizationSlug, conversationId, messageId),
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
      <div
        className="tm-message-reactions"
        role="group"
        aria-label={t('MessageReactionsView.reactionsGroup')}
        aria-busy="true"
      >
        <Skeleton width="12rem" />
      </div>
    );
  }
  if (tally.isError) {
    return <InlineAlert tone="danger">{messageOf(t, tally.error)}</InlineAlert>;
  }

  return (
    <div
      className="tm-message-reactions"
      role="group"
      aria-label={t('MessageReactionsView.reactionsGroup')}
    >
      {ALLOWED_REACTIONS.map(({ emoji }) => {
        const label = reactionLabel(emoji, tOr, t);
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
      {toggle.isError ? (
        <InlineAlert tone="danger">{messageOf(t, toggle.error)}</InlineAlert>
      ) : null}
    </div>
  );
}
