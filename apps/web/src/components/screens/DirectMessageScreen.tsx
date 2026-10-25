'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ChatSidebar } from '../chat/ChatSidebar';
import { initialsOf } from '../chat/channel-browser';
import {
  MentionButton,
  MentionPicker,
  decodeMentions,
  memberRoleLabel,
  useMentionComposer,
} from '../chat/MentionPicker';
import type { MentionCandidate } from '../../lib/api/mention-candidates';
import { browserApiClient } from '../../lib/api/browser-client';
import { newCorrelationId } from '../../lib/api/client';
import type { ApiClient } from '../../lib/api/client';
import {
  MAX_DIRECT_PAGE,
  directKeys,
  fetchDirectConversations,
  listDirectMessages,
  markDirectConversationRead,
  postDirectMessage,
  type DirectConversationSummary,
  type DirectMessageSummary,
} from '../../lib/api/direct-conversations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useMembers } from '../../lib/use-members';
import { useDirectConversationLiveFeed } from '../../lib/use-channel-live-feed';
import {
  RecordDecisionDialog,
  recordedDecisionHref,
  type RecordDecisionMessage,
} from '../decisions/RecordDecisionDialog';
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
    queryKey: directKeys.overview(organizationSlug),
    queryFn: () => fetchDirectConversations(api, organizationSlug),
    select: (overview) => overview.conversations,
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

  /** A stored `@<userId>` token's name, for the people this conversation can name. */
  const nameOfKnown = (userId: string): string | undefined =>
    userId === conversation?.otherUserId && otherName !== ''
      ? otherName
      : memberById.get(userId)?.displayName;

  // C5: the @ picker inside a direct message offers the one other person in it.
  const mentionCandidates = useMemo<readonly MentionCandidate[]>(
    () =>
      conversation && otherName !== ''
        ? [
            {
              userId: conversation.otherUserId,
              displayName: otherName,
              mention: `@${conversation.otherUserId}`,
            },
          ]
        : [],
    [conversation, otherName],
  );

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

  const subtitle = conversation
    ? directSubtitle(conversation, memberById.get(conversation.otherUserId)?.role, tOr)
    : '';
  const online = conversation?.otherOnline === true;
  const onlineWord = tOr('DirectMessageScreen.online', 'Online');

  // F3. The signed-in person is the DM's other participant: whoever wrote here who is not them.
  const selfUserId = rows.find(
    (message) => conversation !== undefined && message.authorUserId !== conversation.otherUserId,
  )?.authorUserId;
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);
  const [recordFrom, setRecordFrom] = useState<RecordDecisionMessage | undefined>(undefined);
  useEffect(() => {
    if (menuFor === undefined) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setMenuFor(undefined);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuFor]);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setMenuFor(undefined);
  };

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
      description={conversation ? (online ? `${subtitle} · ${onlineWord}` : subtitle) : undefined}
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
            {conversation ? (
              <span className="tm-dm__header-sub">
                {subtitle}
                {online ? (
                  <>
                    {' · '}
                    <StatusDot tone="live">{onlineWord}</StatusDot>
                  </>
                ) : null}
              </span>
            ) : null}
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
                <li key={message.id} id={`message-${message.id}`} className="tm-dm__item">
                  {index === firstTodayIndex ? (
                    <p className="tm-dm__divider" role="separator">
                      <span>{tOr('DirectMessageScreen.today', 'Today')}</span>
                    </p>
                  ) : null}
                  <div
                    className="tm-dm__message"
                    {...(menuFor === message.id ? { 'data-selected': 'true' } : {})}
                  >
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
                      <p className="tm-dm__body tm-break">
                        {decodeMentions(message.body, nameOfKnown)}
                      </p>
                    </div>
                    <div className="tm-dm__actions">
                      <button
                        type="button"
                        className="tm-chat-hover"
                        aria-label={tOr('ProjectChannelScreen.moreActions', 'More actions')}
                        aria-expanded={menuFor === message.id}
                        onClick={() =>
                          setMenuFor((open) => (open === message.id ? undefined : message.id))
                        }
                      >
                        <span aria-hidden="true">⋯</span>
                      </button>
                      {menuFor === message.id ? (
                        <div className="tm-chat-more">
                          <button
                            type="button"
                            className="tm-chat-more__item"
                            onClick={() => copy(message.body)}
                          >
                            {tOr('MessageActionsSheet.copy', 'Copy text')}
                          </button>
                          <button
                            type="button"
                            className="tm-chat-more__item"
                            onClick={() =>
                              copy(
                                `${window.location.origin}/${organizationSlug}/chat/dm/${directConversationId}#message-${message.id}`,
                              )
                            }
                          >
                            {tOr('RecordDecision.copyLink', 'Copy link')}
                          </button>
                          <button
                            type="button"
                            className="tm-chat-more__item"
                            aria-haspopup="dialog"
                            onClick={() => {
                              setMenuFor(undefined);
                              setRecordFrom({
                                id: message.id,
                                body: message.body,
                                authorName: nameOf(message.authorUserId),
                                createdAt: message.createdAt,
                              });
                            }}
                          >
                            {tOr('RecordDecision.action', 'Record as decision')}
                          </button>
                        </div>
                      ) : null}
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
            mentionCandidates={mentionCandidates}
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
        {recordFrom !== undefined ? (
          <RecordDecisionDialog
            api={api}
            organizationSlug={organizationSlug}
            message={recordFrom}
            {...(selfUserId === undefined ? {} : { selfUserId })}
            onClose={() => setRecordFrom(undefined)}
            onRecorded={(decision) => {
              setRecordFrom(undefined);
              window.location.assign(recordedDecisionHref(organizationSlug, decision.id));
            }}
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
  mentionCandidates,
}: {
  api: ApiClient;
  organizationSlug: string;
  directConversationId: string;
  placeholder: string;
  mentionCandidates: readonly MentionCandidate[];
}) {
  const tOr = useTOr();
  const queries = useQueryClient();
  const [draft, setDraft] = useState('');
  const [attemptId, setAttemptId] = useState<string | undefined>(undefined);
  const controlRef = useRef<HTMLTextAreaElement | null>(null);
  const mention = useMentionComposer({
    api,
    organizationSlug,
    conversationId: directConversationId,
    draft,
    setDraft,
    controlRef,
    localCandidates: mentionCandidates,
  });

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
    const body = mention.encode(draft).trim();
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
    if (mention.onKeyDown(event)) return;
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
        onChange={(event) => {
          setDraft(event.target.value);
          mention.sync(
            event.target.value,
            event.target.selectionStart ?? event.target.value.length,
          );
        }}
        onKeyDown={onKeyDown}
        onBlur={mention.close}
        {...mention.controlProps}
      />
      {mention.open ? (
        <MentionPicker
          id={mention.listboxId}
          options={mention.options}
          activeIndex={mention.activeIndex}
          onPick={mention.pick}
          onHover={mention.setActiveIndex}
          othersHeading={tOr('DirectMessageScreen.inThisConversation', 'In this conversation')}
        />
      ) : null}
      {send.isError ? (
        <InlineAlert tone="danger" title={tOr('DirectMessageScreen.notSent', 'Not sent')} live>
          {describe(send.error, tOr)}
        </InlineAlert>
      ) : null}
      <div className="tm-dm__bar">
        <MentionButton
          onClick={mention.openAtCaret}
          label={tOr('DirectMessageScreen.at', 'Type @')}
        />
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

/**
 * "Direct message · <job title or role>" for a team member, "Direct message · Client · <company>"
 * for a client participant (C5). A job title the person set wins over their access role, because
 * it says what they do; a client is said as a client with their company.
 */
export function directSubtitle(
  conversation: DirectConversationSummary,
  memberRole: string | undefined,
  tOr: (key: string, en: string) => string,
): string {
  const lead = tOr('DirectMessageScreen.directMessage', 'Direct message');
  const company = conversation.otherClientCompanyName?.trim();
  if (company) return [lead, tOr('MentionPicker.client', 'Client'), company].join(' · ');
  const title = conversation.otherJobTitle?.trim();
  const second = title ? title : memberRoleLabel(memberRole, tOr);
  return [lead, second].filter(Boolean).join(' · ');
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
