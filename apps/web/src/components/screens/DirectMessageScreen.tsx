'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ChatSidebar } from '../chat/ChatSidebar';
import { initialsOf } from '../chat/channel-browser';
import { memberRoleLabel } from '../chat/MentionPicker';
import { browserApiClient } from '../../lib/api/browser-client';
import { newCorrelationId } from '../../lib/api/client';
import type { ApiClient } from '../../lib/api/client';
import {
  MAX_DIRECT_PAGE,
  directKeys,
  listDirectConversations,
  listDirectMessages,
  markDirectConversationRead,
  postDirectMessage,
  type DirectMessageSummary,
} from '../../lib/api/direct-conversations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useMembers } from '../../lib/use-members';
import { useDirectConversationLiveFeed } from '../../lib/use-channel-live-feed';
import type { LiveSocketFactory } from '../../lib/use-channel-live-feed';
import '../../styles/screens/chat.css';
import '../chat/chat-shell.css';

export interface DirectMessageScreenProps {
  organizationSlug: string;
  organizationName: string;
  directConversationId: string;
  client?: ApiClient;
  /** RT-001's test seam: jsdom has no WebSocket, so a suite injects a fake. */
  socketFactory?: LiveSocketFactory;
  reconnectBaseMs?: number;
}

/**
 * **d-conversation** — a direct message between two people, beside the chat column.
 *
 * Header: the other person's orb and name, "Direct message · <role>". The transcript opens on
 * the "This is the start of your direct messages with X." lines, a TODAY divider before today's
 * messages, then orb-led messages. Opening the screen — and every new message that arrives while
 * it is open — marks the conversation read up to its latest message, so the sidebar pill clears.
 * Live delivery is the realtime hub's (`direct_message.created.v1` is published on the DM's id);
 * a frame only triggers a refetch through the ordinary read path.
 *
 * The composer keeps one `clientGeneratedId` per send across retries, so a retry after a lost
 * answer is deduplicated by the API instead of posting twice.
 */
export function DirectMessageScreen({
  organizationSlug,
  organizationName,
  directConversationId,
  client,
  socketFactory,
  reconnectBaseMs,
}: DirectMessageScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const tOr = useTOr();

  const list = useQuery({
    queryKey: directKeys.list(organizationSlug),
    queryFn: () => listDirectConversations(api, organizationSlug),
  });
  const conversation = (list.data ?? []).find((row) => row.id === directConversationId);

  const messages = useQuery({
    queryKey: directKeys.messages(organizationSlug, directConversationId),
    // Oldest first on the sequence cursor; read on until a short page so the newest is on screen.
    queryFn: async () => {
      const all: DirectMessageSummary[] = [];
      for (let page = 0; page < 10; page += 1) {
        const after = all.length > 0 ? all[all.length - 1]?.sequenceNo : undefined;
        const batch = await listDirectMessages(api, organizationSlug, directConversationId, {
          limit: MAX_DIRECT_PAGE,
          ...(after === undefined ? {} : { afterSequenceNo: after }),
        });
        all.push(...batch);
        if (batch.length < MAX_DIRECT_PAGE) break;
      }
      return all;
    },
  });

  const directory = useMembers(api, organizationSlug);
  const memberById = useMemo(() => {
    const byId = new Map<string, { displayName: string; role: string }>();
    for (const member of directory.members ?? []) byId.set(member.userId, member);
    return byId;
  }, [directory.members]);

  const otherName =
    conversation?.otherDisplayName ??
    (conversation ? memberById.get(conversation.otherUserId)?.displayName : undefined) ??
    '';
  const nameOf = (userId: string): string =>
    userId === conversation?.otherUserId && otherName !== ''
      ? otherName
      : (memberById.get(userId)?.displayName ?? userId.slice(0, 8));

  const rows = useMemo(() => messages.data ?? [], [messages.data]);
  const latest = rows.length > 0 ? (rows[rows.length - 1] as DirectMessageSummary).sequenceNo : 0;

  // Mark read on open and whenever a newer message is on screen. Forward-only on the server.
  const markedUpTo = useRef(-1);
  useEffect(() => {
    if (!messages.isSuccess || latest <= markedUpTo.current) return;
    markedUpTo.current = latest;
    void markDirectConversationRead(api, organizationSlug, directConversationId)
      .then(() => queries.invalidateQueries({ queryKey: directKeys.list(organizationSlug) }))
      .catch(() => {
        // A failed mark-read leaves the pill as it was; the next open tries again.
        markedUpTo.current = -1;
      });
  }, [api, organizationSlug, directConversationId, latest, messages.isSuccess, queries]);

  const liveStatus = useDirectConversationLiveFeed({
    api,
    organizationSlug,
    directConversationId,
    enabled: messages.isSuccess,
    onCatchUp: () => {
      void queries.invalidateQueries({
        queryKey: directKeys.messages(organizationSlug, directConversationId),
      });
    },
    ...(socketFactory === undefined ? {} : { socketFactory }),
    ...(reconnectBaseMs === undefined ? {} : { reconnectBaseMs }),
  });

  const role = conversation
    ? memberRoleLabel(memberById.get(conversation.otherUserId)?.role, tOr)
    : undefined;
  const subtitle = [tOr('DirectMessageScreen.directMessage', 'Direct message'), role]
    .filter(Boolean)
    .join(' · ');

  const today = new Date().toDateString();
  const firstTodayIndex = rows.findIndex(
    (message) => new Date(message.createdAt).toDateString() === today,
  );

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="chat"
      title={otherName !== '' ? otherName : tOr('DirectMessageScreen.fallback', 'Direct message')}
      description={conversation ? subtitle : undefined}
      contextRail={
        <ChatSidebar
          api={api}
          organizationSlug={organizationSlug}
          organizationName={organizationName}
          activeDirectConversationId={directConversationId}
        />
      }
    >
      <div className="tm-chat-channel tm-dm">
        {/*
         * The frame's header: orb, name, "Direct message · role". The shell's own header (the
         * page's h1 and the same line) stays for assistive technology and is clipped from view,
         * so this one is hidden from it rather than read twice.
         */}
        <div className="tm-dm__header" aria-hidden="true">
          {otherName !== '' ? (
            <span className="tm-chat-side__orb tm-dm__head-orb">{initialsOf(otherName)}</span>
          ) : null}
          <span className="tm-dm__header-text">
            <span className="tm-dm__header-name">{otherName}</span>
            {conversation ? <span className="tm-dm__header-sub">{subtitle}</span> : null}
          </span>
        </div>
        {messages.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('DirectMessageScreen.loadError', 'Could not load this conversation')}
            live
          >
            {describe(messages.error, tOr)}
          </InlineAlert>
        ) : null}
        {liveStatus === 'revoked' ? (
          <InlineAlert
            tone="warning"
            title={tOr('DirectMessageScreen.noAccess', 'You can no longer see this conversation')}
            live
          >
            {tOr('DirectMessageScreen.noAccessBody', 'Pick another conversation from the list.')}
          </InlineAlert>
        ) : null}

        <div className="tm-dm__scroll">
          {messages.isPending ? (
            <LoadingRegion label={tOr('DirectMessageScreen.loading', 'Loading messages')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {messages.isSuccess && otherName !== '' ? (
            <div className="tm-dm__start">
              <span className="tm-chat-side__orb tm-dm__start-orb" aria-hidden="true">
                {initialsOf(otherName)}
              </span>
              <p className="tm-dm__start-lead">
                {tOr(
                  'DirectMessageScreen.startLead',
                  'This is the start of your direct messages with {name}.',
                ).replace('{name}', otherName)}
              </p>
              <p className="tm-dm__start-note">
                {tOr(
                  'DirectMessageScreen.startNote',
                  'Only the two of you can see this conversation.',
                )}
              </p>
            </div>
          ) : null}

          {rows.length > 0 ? (
            <ol
              className="tm-dm__transcript"
              aria-label={tOr('DirectMessageScreen.messagesLabel', 'Messages, oldest first')}
              aria-live="polite"
            >
              {rows.map((message, index) => (
                <li key={message.id} className="tm-dm__item">
                  {index === firstTodayIndex ? (
                    <p className="tm-dm__divider" role="separator">
                      <span>{tOr('DirectMessageScreen.today', 'Today')}</span>
                    </p>
                  ) : null}
                  <div className="tm-dm__message">
                    <span className="tm-chat-side__orb tm-dm__orb" aria-hidden="true">
                      {initialsOf(nameOf(message.authorUserId))}
                    </span>
                    <div className="tm-dm__main">
                      <p className="tm-dm__head">
                        <span className="tm-dm__author">{nameOf(message.authorUserId)}</span>
                        <time className="tm-dm__time" dateTime={message.createdAt}>
                          {formatTime(message.createdAt)}
                        </time>
                      </p>
                      <p className="tm-dm__body tm-break">{message.body}</p>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
        </div>

        {messages.isSuccess && liveStatus !== 'revoked' ? (
          <DirectComposer
            api={api}
            organizationSlug={organizationSlug}
            directConversationId={directConversationId}
            placeholder={
              otherName !== ''
                ? tOr('DirectMessageScreen.messagePrefix', 'Message {name}').replace(
                    '{name}',
                    otherName,
                  )
                : tOr('DirectMessageScreen.messageLabel', 'Message')
            }
          />
        ) : null}
      </div>
    </AppShell>
  );
}

function DirectComposer({
  api,
  organizationSlug,
  directConversationId,
  placeholder,
}: {
  api: ApiClient;
  organizationSlug: string;
  directConversationId: string;
  placeholder: string;
}) {
  const tOr = useTOr();
  const queries = useQueryClient();
  const [draft, setDraft] = useState('');
  const [attemptId, setAttemptId] = useState<string | undefined>(undefined);
  const controlRef = useRef<HTMLTextAreaElement | null>(null);

  const send = useMutation({
    mutationFn: (input: { body: string; clientGeneratedId: string }) =>
      postDirectMessage(api, organizationSlug, directConversationId, input),
    onSuccess: () => {
      setDraft('');
      setAttemptId(undefined);
      void queries.invalidateQueries({
        queryKey: directKeys.messages(organizationSlug, directConversationId),
      });
      void queries.invalidateQueries({ queryKey: directKeys.list(organizationSlug) });
    },
  });

  function performSend() {
    const body = draft.trim();
    if (body === '' || send.isPending) return;
    // Reuse the attempt id on a retry of a failed send; mint one otherwise.
    const clientGeneratedId = attemptId ?? newCorrelationId();
    setAttemptId(clientGeneratedId);
    send.mutate({ body, clientGeneratedId });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    performSend();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      performSend();
    }
  }

  /** The round "@" button: a direct message has no one else to mention, so it types the sign. */
  function insertAt() {
    const control = controlRef.current;
    const caret = control?.selectionStart ?? draft.length;
    const next = `${draft.slice(0, caret)}@${draft.slice(caret)}`;
    setDraft(next);
    requestAnimationFrame(() => {
      control?.focus();
      control?.setSelectionRange(caret + 1, caret + 1);
    });
  }

  return (
    <form className="tm-dm__composer" onSubmit={submit}>
      <label className="tm-visually-hidden" htmlFor="tm-dm-composer">
        {placeholder}
      </label>
      <textarea
        id="tm-dm-composer"
        ref={controlRef}
        className="tm-dm__input"
        rows={2}
        maxLength={16000}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {send.isError ? (
        <InlineAlert tone="danger" title={tOr('DirectMessageScreen.notSent', 'Not sent')} live>
          {describe(send.error, tOr)}
        </InlineAlert>
      ) : null}
      <div className="tm-dm__bar">
        <button
          type="button"
          className="tm-chat-side__round"
          aria-label={tOr('DirectMessageScreen.at', 'Type @')}
          title={tOr('DirectMessageScreen.at', 'Type @')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={insertAt}
        >
          <span aria-hidden="true">@</span>
        </button>
        <button
          type="submit"
          className="tm-chat-side__send"
          aria-label={tOr('DirectMessageScreen.send', 'Send')}
          title={tOr('DirectMessageScreen.send', 'Send')}
          disabled={draft.trim() === '' || send.isPending}
          aria-busy={send.isPending}
        >
          <span aria-hidden="true" className="tm-chat-side__send-arrow">
            →
          </span>
        </button>
      </div>
    </form>
  );
}

function describe(error: unknown, tOr: (key: string, en: string) => string): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 404) {
      return tOr(
        'DirectMessageScreen.notFound',
        'This conversation does not exist, or you are no longer part of it.',
      );
    }
    return error.message;
  }
  if (error instanceof NetworkError) {
    return tOr('DirectMessageScreen.noAnswer', 'The server did not answer. Try again.');
  }
  return tOr('DirectMessageScreen.genericError', 'Something went wrong. Try again.');
}

/** "09:12" — 24-hour, as the frame draws it. */
function formatTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
}
