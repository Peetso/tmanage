'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InadmissibleRichTextError, sanitizeRichText } from '@tmanage/domain';
import {
  Button,
  InlineAlert,
  LoadingRegion,
  Skeleton,
  StateCapsule,
  VisuallyHidden,
} from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ChatSidebar } from '../chat/ChatSidebar';
import {
  MentionButton,
  MentionPicker,
  decodeMentions,
  memberRoleLabel,
  useMentionComposer,
  type MentionGroup,
} from '../chat/MentionPicker';
import { RichTextBody } from '../RichTextBody';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import { newCorrelationId } from '../../lib/api/client';
import { getProject } from '../../lib/api/projects';
import { listProjectMembers } from '../../lib/api/project-members';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useMembers } from '../../lib/use-members';
import {
  MAX_MESSAGE_PAGE,
  clearDraft,
  convertMessageToWork,
  getConversation,
  getDraft,
  listChannelDirectory,
  listMessages,
  listRevisions,
  moderateMessage,
  postMessage,
  saveDraft,
} from '../../lib/api/conversations';
import type {
  ChannelDirectoryEntry,
  ConvertMessageResult,
  MessageSummary,
  PostMessageInput,
} from '../../lib/api/conversations';
import { composeMessage } from '../../lib/rich-composer';
import { useChannelLiveFeed } from '../../lib/use-channel-live-feed';
import type { LiveSocketFactory } from '../../lib/use-channel-live-feed';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { audienceLabel } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import { workItemKeys } from '../../lib/query-keys';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useDictation } from '../voice/useDictation';
import { MicButton, MicNotice } from '../voice/VoiceControls';
import {
  addChannelMember,
  editChannelMessage,
  listChannelMembers,
} from '../../lib/api/channel-members';
import {
  getMessageAttachmentsBatched,
  type MessageAttachmentSummary,
} from '../../lib/api/message-attachments';
import { NotScannedDownload } from './NotScannedDownload';
import { useIsMobile } from '../../lib/hooks/useIsMobile';
import { MessageReactionPills, useMessageReactionTally } from './MessageReactionsView';
import { MessageActionsSheet } from '../chat/MessageActionsSheet';
import {
  RecordDecisionDialog,
  recordedDecisionHref,
  type RecordDecisionMessage,
} from '../decisions/RecordDecisionDialog';
import '../../styles/screens/chat.css';
import '../chat/chat-shell.css';

type Translate = ReturnType<typeof useT>;

export interface ProjectChannelScreenProps {
  organizationSlug: string;
  organizationName: string;
  conversationId: string;
  client?: ApiClient;
  /** RT-001's test seam: jsdom has no WebSocket, so a suite injects a fake. */
  socketFactory?: LiveSocketFactory;
  reconnectBaseMs?: number;
}

type WorkAudience = 'internal' | 'client_visible' | 'client_action_required';

/**
 * **TM-06 Project channel**, with **TM-08's thread pane** as the detail lens and **TM-09's
 * convert dialog** inline under its message. WEB-003 — both halves: the second added the
 * rich-text composer (a toolbar over a notation converted to CHAT-002's closed grammar,
 * never HTML — see `lib/rich-composer.ts`) and transcript paging on the sequence-number
 * cursor, for the channel and for a thread's replies alike.
 *
 * `22-SCREEN-BY-SCREEN` §4 lists the message actions: "reply, react, save, create work,
 * quote to decision, edit history." Three of those exist as API — reply (a thread), create
 * work (CHAT-003's conversion) and edit history (CHAT-002's revisions) — and are built here.
 * React, save and quote-to-decision are not wired to this transcript, so they are not drawn
 * as buttons that could never work. A conversation has no audience column — no client role
 * holds any conversation capability, a gap the status file records — so every channel is
 * internal today: CH-02's audience capsule and composer notice say "Internal" rather than the
 * frame's client-visible example.
 *
 * Painted as CH-02 / CH-05 / CH-08: the channel list as the context rail, the transcript as
 * orb-led messages, the composer as the rounded CH-06 card, the thread and the convert form
 * in the 400px lens, the edit history as CH-07's dark card.
 *
 * ## The retry that cannot double-post
 *
 * The composer mints a `clientGeneratedId` when a send starts and keeps it until that send
 * succeeds. A network failure leaves the text in the box and the id in hand; pressing Send
 * again replays the same id, and the API's dedupe answers with the original message rather
 * than a twin. The id is abandoned only on success, when the next message is genuinely new.
 *
 * ## What a removed message looks like
 *
 * The API answers moderation with the message — body withheld, removal recorded — and this
 * screen draws the tombstone: "Removed by a moderator", with the time. It does not collapse
 * the row, because a transcript where messages vanish without trace reads as if they were
 * never said, and the moderation ledger's whole point is the difference between hiding and
 * erasing.
 *
 * ## Who is speaking
 *
 * The author's name comes from the member directory (`useMembers`). Where the directory has
 * no row for them — a former member, or a directory that could not be read — the author falls
 * back to the first eight characters of their id, monospaced: an id is not a name, but in a
 * transcript the reader needs *at least* to tell speakers apart.
 */
export function ProjectChannelScreen({
  organizationSlug,
  organizationName,
  conversationId,
  client,
  socketFactory,
  reconnectBaseMs,
}: ProjectChannelScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();

  const [threadRootId, setThreadRootId] = useState<string | undefined>(undefined);
  const [convertTargetId, setConvertTargetId] = useState<string | undefined>(undefined);
  const [historyMessageId, setHistoryMessageId] = useState<string | undefined>(undefined);
  const [removeTargetId, setRemoveTargetId] = useState<string | undefined>(undefined);
  // F3. "Record as decision" from a message's actions.
  const [recordFrom, setRecordFrom] = useState<RecordDecisionMessage | undefined>(undefined);

  /*
   * WCAG 2.2 4.1.3, verbosity. The transcript's <ol> is a live region so a genuinely new message
   * (a live frame's refetch appends one) is announced. But "Load more" appends a whole page —
   * up to MAX_MESSAGE_PAGE rows — at once, and a live region would read the lot out. We hold the
   * region silent across a manual page fetch and re-enable it only afterwards. `announceMessages`
   * mirrors `!isFetchingNextPage` one render late, which is exactly what keeps the region `off`
   * through the commit that appends the page; a live refetch never toggles that flag, so it stays
   * announced.
   */
  const [announceMessages, setAnnounceMessages] = useState(true);

  /*
   * WCAG 2.2 2.4.3. The thread pane is an <aside> rendered after <main>, so opening it leaves
   * focus on the trigger and closing it (the close button unmounts) would drop focus to <body>.
   * We remember the control that opened the pane and restore focus to it on close; the pane
   * itself takes focus on open (see ThreadPane).
   */
  const threadReturnFocusRef = useRef<HTMLElement | null>(null);
  const openThread = (messageId: string, trigger: HTMLElement) => {
    threadReturnFocusRef.current = trigger;
    setThreadRootId(messageId);
  };
  const closeThread = () => {
    setThreadRootId(undefined);
    const trigger = threadReturnFocusRef.current;
    threadReturnFocusRef.current = null;
    trigger?.focus();
  };

  const conversation = useQuery({
    queryKey: ['conversation', organizationSlug, conversationId],
    queryFn: () => getConversation(api, organizationSlug, conversationId),
  });

  const project = useQuery({
    queryKey: ['project', organizationSlug, conversation.data?.projectId],
    queryFn: () => getProject(api, organizationSlug, conversation.data?.projectId ?? ''),
    enabled: conversation.data !== undefined,
  });

  /*
   * WEB-002's paging shape on WEB-003's transcript: the cursor is the last loaded message's
   * sequence number — the channel's own order — and pages accumulate under one key. The API
   * reads oldest-first, so "Load more" continues the transcript forward rather than paging
   * a mirror of it backwards.
   */
  const messages = useInfiniteQuery({
    queryKey: ['messages', organizationSlug, conversationId, 'channel'],
    queryFn: ({ pageParam }) =>
      listMessages(api, organizationSlug, conversationId, {
        limit: MAX_MESSAGE_PAGE,
        ...(pageParam === undefined ? {} : { afterSequenceNo: pageParam }),
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length === MAX_MESSAGE_PAGE ? lastPage[lastPage.length - 1]?.sequenceNo : undefined,
  });

  const moderate = useMutation({
    mutationFn: (messageId: string) =>
      moderateMessage(api, organizationSlug, conversationId, messageId),
    onSuccess: () => {
      setRemoveTargetId(undefined);
      void queries.invalidateQueries({ queryKey: ['messages', organizationSlug, conversationId] });
    },
  });

  useEffect(() => {
    setAnnounceMessages(!messages.isFetchingNextPage);
  }, [messages.isFetchingNextPage]);

  const rows = useMemo(() => messages.data?.pages.flat() ?? [], [messages.data]);
  const threadRoot = rows.find((message) => message.id === threadRootId);
  const archived = conversation.data?.archivedAt != null;

  /*
   * RT-001's browser half. Every frame — and the subscription itself — answers with a
   * refetch through the ordinary read path; frame content is never applied. Where the
   * deployment runs no socket the hook settles at 'off' and the reload behaviour stands.
   */
  const liveStatus = useChannelLiveFeed({
    api,
    organizationSlug,
    conversationId,
    enabled: conversation.data !== undefined && !archived,
    onCatchUp: () => {
      void queries.invalidateQueries({ queryKey: ['messages', organizationSlug, conversationId] });
    },
    ...(socketFactory === undefined ? {} : { socketFactory }),
    ...(reconnectBaseMs === undefined ? {} : { reconnectBaseMs }),
  });

  /*
   * The worker revoked *this channel* — a suspended membership, a withdrawn capability, or
   * the routine "remove Dana from #design". None of those ends a session, so nothing here
   * clears caches, announces `session-ended` or tells other tabs anything: the person stays
   * signed in and every other channel keeps working. What ends is this screen's channel, and
   * it says so — the live chip is gone, the transcript and the composer go with the access,
   * and the way out is the channel list. The genuine session end has its own path
   * (`ApiClient`'s refresh-refused `onSessionEnded`), which unmounts this screen anyway.
   */
  const channelRevoked = liveStatus === 'revoked';

  // Author names from the member directory; an id the directory does not know keeps its short
  // form (see "Who is speaking" above).
  const directory = useMembers(api, organizationSlug);
  const names = useMemo(() => {
    const byId = new Map<string, string>();
    for (const member of directory.members ?? []) byId.set(member.userId, member.displayName);
    return byId;
  }, [directory.members]);
  const nameOf = (userId: string) => names.get(userId) ?? shortAuthor(userId);

  // A4 (m-mention): who is on the channel's project, for the picker's PROJECT MEMBERS group.
  const tOr = useTOr();
  const projectId = conversation.data?.projectId;
  const projectMembers = useQuery({
    queryKey: ['project-members', organizationSlug, projectId],
    queryFn: () => listProjectMembers(api, organizationSlug, projectId ?? ''),
    enabled: projectId !== undefined,
  });
  const projectMemberIds = useMemo(
    () =>
      new Set(
        (Array.isArray(projectMembers.data) ? projectMembers.data : []).map(
          (member) => member.userId,
        ),
      ),
    [projectMembers.data],
  );
  const roles = useMemo(() => {
    const byId = new Map<string, string>();
    for (const member of directory.members ?? []) byId.set(member.userId, member.role);
    return byId;
  }, [directory.members]);
  const projectName = project.data?.name;
  const subtitleOf = useMemo(
    () => (userId: string, group: MentionGroup) => {
      const role = memberRoleLabel(roles.get(userId), tOr) ?? tOr('MentionPicker.client', 'Client');
      const place = group === 'project' ? projectName : organizationName;
      return [role, place].filter(Boolean).join(' · ');
    },
    [roles, tOr, projectName, organizationName],
  );

  const convertTarget = rows.find((message) => message.id === convertTargetId);
  const selectedId = convertTargetId ?? threadRootId;
  const channelName = conversation.data?.name;

  /*
   * A16 — who is in the room. The channel directory (the same cache entry the chat sidebar reads)
   * carries the authoritative member and client counts; the channel's member list names them.
   * A person counts as a client when the directory preview marks them so or their org role is a
   * client role — the transcript's "Client" chip and the Members panel's CLIENT group agree.
   */
  const isMobile = useIsMobile();
  const channelDirectory = useQuery({
    queryKey: ['conversations', organizationSlug, 'directory'],
    queryFn: () => listChannelDirectory(api, organizationSlug),
  });
  const directoryEntry: ChannelDirectoryEntry | undefined = Array.isArray(channelDirectory.data)
    ? (channelDirectory.data as readonly ChannelDirectoryEntry[]).find(
        (entry) => entry.id === conversationId,
      )
    : undefined;
  const channelMembers = useQuery({
    queryKey: ['channel-members', organizationSlug, conversationId],
    queryFn: () => listChannelMembers(api, organizationSlug, conversationId),
    enabled: conversation.data !== undefined,
  });
  const memberIds = useMemo(
    () => (Array.isArray(channelMembers.data) ? channelMembers.data.map((m) => m.userId) : []),
    [channelMembers.data],
  );
  const previewClients = useMemo(
    () =>
      new Set(
        (directoryEntry?.memberPreview ?? [])
          .filter((member) => member.isClient)
          .map((member) => member.userId),
      ),
    [directoryEntry],
  );
  const isClient = (userId: string) =>
    previewClients.has(userId) || (roles.get(userId)?.startsWith('client') ?? false);
  const listedClients = memberIds.filter(isClient).length;
  const totalMembers = directoryEntry?.memberCount ?? memberIds.length;
  const clientMembers = directoryEntry?.clientMemberCount ?? listedClients;
  const internalMembers = Math.max(0, totalMembers - clientMembers);
  const clientVisible = clientMembers > 0;

  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [pickerFor, setPickerFor] = useState<string | undefined>(undefined);
  const [moreFor, setMoreFor] = useState<string | undefined>(undefined);
  const [sheetFor, setSheetFor] = useState<string | undefined>(undefined);
  const sheetReturnFocusRef = useRef<HTMLElement | null>(null);
  const closeSheet = () => {
    setSheetFor(undefined);
    const trigger = sheetReturnFocusRef.current;
    sheetReturnFocusRef.current = null;
    trigger?.focus();
  };

  const countsLine = `${internalMembers} ${tOr('ProjectChannelScreen.internalCount', 'internal')} · ${clientMembers} ${tOr('ProjectChannelScreen.clientMembersCount', 'client members')}`;
  const phoneCountsLine = `${internalMembers} ${tOr('ProjectChannelScreen.internalCount', 'internal')} · ${clientMembers} ${tOr('ProjectChannelScreen.clientCount', 'client')}`;
  const hash = channelName === undefined ? undefined : `#${channelName}`;

  const rowContext: ChannelRowContext = {
    api,
    organizationSlug,
    conversationId,
    isMobile,
    nameOf,
    isClient,
    archived,
    threadRootId,
    convertTargetId,
    historyMessageId,
    removeTargetId,
    editingId,
    pickerFor,
    moreFor,
    sheetFor,
    openThread,
    setConvertTargetId,
    setHistoryMessageId,
    setRemoveTargetId,
    setEditingId,
    setPickerFor,
    setMoreFor,
    openSheet: (messageId, trigger) => {
      sheetReturnFocusRef.current = trigger;
      setSheetFor(messageId);
    },
    closeSheet,
    moderate,
    recordDecision: (message) =>
      setRecordFrom({
        id: message.id,
        body: message.body ?? '',
        authorName: nameOf(message.authorUserId),
        createdAt: message.createdAt,
      }),
  };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="chat"
      title={hash ?? t('ProjectChannelScreen.channelFallback')}
      actionsPlacement="inline"
      actions={
        <span className={`tm-chat-pill${clientVisible ? ' tm-chat-pill--client' : ''}`}>
          {clientVisible
            ? tOr('ProjectChannelScreen.clientVisible', 'Client visible')
            : tOr('ProjectChannelScreen.internalPill', 'Internal')}
        </span>
      }
      description={
        <>
          {t('ProjectChannelScreen.projectChannelDesc')} · {countsLine}
          {archived ? <> · {t('ProjectChannelScreen.archived')}</> : null}
          {liveStatus === 'retrying' ? ' · ' : null}
          {/*
           * WCAG 2.2 4.1.3. Mounted from the first render so a later flip is a text mutation of a
           * region that already exists, which is what assistive technology announces. A16: the
           * steady "Live" state is announced but not drawn (the approved frame shows no chip);
           * a dropped connection still shows its short visible word, since that is a fault.
           */}
          <span role="status">
            {liveStatus === 'live' ? (
              <VisuallyHidden>{t('ProjectChannelScreen.liveConnected')}</VisuallyHidden>
            ) : liveStatus === 'retrying' ? (
              <>
                <span aria-hidden="true">{t('ProjectChannelScreen.reconnectingShort')}</span>
                <VisuallyHidden>{t('ProjectChannelScreen.reconnectingFull')}</VisuallyHidden>
              </>
            ) : null}
          </span>
        </>
      }
      contextRail={
        <ChatSidebar
          api={api}
          organizationSlug={organizationSlug}
          organizationName={organizationName}
          activeConversationId={conversationId}
        />
      }
      lens={
        convertTarget ? (
          <ConvertDialog
            key={convertTarget.id}
            api={api}
            organizationSlug={organizationSlug}
            conversationId={conversationId}
            message={convertTarget}
            authorName={nameOf(convertTarget.authorUserId)}
            projectName={project.data?.name}
            onDone={() => {
              void queries.invalidateQueries({
                queryKey: workItemKeys.all(organizationSlug),
              });
            }}
            onClose={() => setConvertTargetId(undefined)}
          />
        ) : threadRoot ? (
          <ThreadPane
            /*
             * WCAG 2.2 2.4.3, second half. Keying on the root id makes each open a fresh mount,
             * so the focus move to the pane heading happens on every open, not only the first.
             */
            key={threadRoot.id}
            api={api}
            organizationSlug={organizationSlug}
            conversationId={conversationId}
            root={threadRoot}
            archived={archived}
            nameOf={nameOf}
            onClose={closeThread}
          />
        ) : conversation.data !== undefined && !channelRevoked && !isMobile ? (
          <ChannelMembersPanel
            api={api}
            organizationSlug={organizationSlug}
            conversationId={conversationId}
            memberIds={memberIds}
            total={totalMembers}
            nameOf={nameOf}
            isClient={isClient}
            archived={archived}
          />
        ) : undefined
      }
    >
      <div className={`tm-chat-channel${isMobile ? ' tm-chat-channel--phone' : ''}`}>
        {isMobile ? (
          <div className="tm-chat-phone-head">
            <Link
              className="tm-chat-phone-head__back"
              href={`/${organizationSlug}/chat`}
              aria-label={t('ProjectChannelScreen.backToAllChannels')}
            >
              <span aria-hidden="true">←</span>
            </Link>
            <span className="tm-chat-phone-head__text">
              <span className="tm-chat-phone-head__name">
                {hash ?? t('ProjectChannelScreen.channelFallback')}
              </span>
              <span className="tm-chat-phone-head__sub">{phoneCountsLine}</span>
            </span>
            <span className="tm-chat-phone-head__members">
              <span aria-hidden="true">☺ {totalMembers}</span>
              <span className="tm-visually-hidden">
                {`${totalMembers} ${tOr('ProjectChannelScreen.membersCount', 'members')}`}
              </span>
            </span>
          </div>
        ) : null}

        {channelRevoked ? (
          <InlineAlert tone="warning" title={t('ProjectChannelScreen.noAccessTitle')} live>
            <p className="tm-prose">{t('ProjectChannelScreen.noAccessBody')}</p>
            <Link href={`/${organizationSlug}/chat`}>
              {t('ProjectChannelScreen.backToAllChannels')}
            </Link>
          </InlineAlert>
        ) : null}

        {conversation.isError ? (
          <InlineAlert tone="danger" title={t('ProjectChannelScreen.couldNotLoadChannel')} live>
            {describeError(conversation.error, t)}
          </InlineAlert>
        ) : null}

        {messages.isPending ? (
          <LoadingRegion label={t('ProjectChannelScreen.loadingConversation')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {messages.isError ? (
          <InlineAlert tone="danger" title={t('ProjectChannelScreen.couldNotLoadMessages')} live>
            {describeError(messages.error, t)}
          </InlineAlert>
        ) : null}

        {messages.hasNextPage && !channelRevoked ? (
          <InlineAlert tone="warning" title={t('ProjectChannelScreen.notWholeTranscript')}>
            {rows.length} {t('ProjectChannelScreen.messagesLoadedMore')}
          </InlineAlert>
        ) : null}

        {!messages.isPending && !messages.isError && rows.length === 0 && !channelRevoked ? (
          <p className="tm-chat-empty">
            <span>
              <strong>{t('ProjectChannelScreen.nothingSaidYet')}</strong>
              {t('ProjectChannelScreen.nothingSaidBody')}
            </span>
          </p>
        ) : null}

        {rows.length > 0 && !channelRevoked ? (
          <ol
            className="tm-chat-transcript"
            aria-label={t('ProjectChannelScreen.messagesListAria')}
            aria-live={announceMessages ? 'polite' : 'off'}
            aria-relevant="additions"
            {...(sheetFor === undefined ? {} : { 'data-sheet-open': 'true' })}
          >
            {rows.map((message) => (
              <ChannelMessage
                key={message.id}
                message={message}
                selected={selectedId === message.id}
                context={rowContext}
              />
            ))}
          </ol>
        ) : null}

        {messages.hasNextPage && !channelRevoked ? (
          <div className="tm-row">
            <Button
              tone="outline"
              size="accessible"
              loading={messages.isFetchingNextPage}
              loadingLabel={t('ProjectChannelScreen.loadingMore')}
              onClick={() => void messages.fetchNextPage()}
            >
              {t('ProjectChannelScreen.loadMore')}
            </Button>
          </div>
        ) : null}

        {/*
         * Only for a channel that actually loaded. A member outside the room gets the load
         * error and nothing else — a composer under a denial would be a control that cannot
         * work, and AUTH-04's e2e journey asserts its absence. A revoked channel is the same
         * denial arriving mid-session.
         */}
        {conversation.data !== undefined && !channelRevoked ? (
          <div className="tm-chat-foot">
            <Composer
              api={api}
              organizationSlug={organizationSlug}
              conversationId={conversationId}
              archived={archived}
              label={t('ProjectChannelScreen.messageChannelLabel')}
              placeholder={`${t('ProjectChannelScreen.messagePrefix')} #${conversation.data.name}`}
              mentions={{ projectMemberIds, subtitleOf }}
            />
          </div>
        ) : null}
        {recordFrom !== undefined ? (
          <RecordDecisionDialog
            api={api}
            organizationSlug={organizationSlug}
            message={recordFrom}
            {...(projectId === undefined ? {} : { defaultProjectId: projectId })}
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

/** What one transcript row needs from the screen — state and the setters that change it. */
interface ChannelRowContext {
  api: ApiClient;
  organizationSlug: string;
  conversationId: string;
  isMobile: boolean;
  nameOf: (userId: string) => string;
  isClient: (userId: string) => boolean;
  archived: boolean;
  threadRootId: string | undefined;
  convertTargetId: string | undefined;
  historyMessageId: string | undefined;
  removeTargetId: string | undefined;
  editingId: string | undefined;
  pickerFor: string | undefined;
  moreFor: string | undefined;
  sheetFor: string | undefined;
  openThread: (messageId: string, trigger: HTMLElement) => void;
  setConvertTargetId: (update: (current: string | undefined) => string | undefined) => void;
  setHistoryMessageId: (update: (current: string | undefined) => string | undefined) => void;
  setRemoveTargetId: (next: string | undefined) => void;
  setEditingId: (next: string | undefined) => void;
  setPickerFor: (next: string | undefined) => void;
  setMoreFor: (next: string | undefined) => void;
  openSheet: (messageId: string, trigger: HTMLElement) => void;
  closeSheet: () => void;
  moderate: { isPending: boolean; isError: boolean; error: unknown; mutate: (id: string) => void };
  /** F3. Opens "Record as decision" filled in from the message. */
  recordDecision: (message: MessageSummary) => void;
}

const LONG_PRESS_MS = 500;

/** The download address of a stored file — the same route the work item's files use. */
function fileContentHref(organizationSlug: string, fileAssetId: string): string {
  return `${apiBaseUrl()}/v1/organizations/${encodeURIComponent(organizationSlug)}/files/${encodeURIComponent(fileAssetId)}/content`;
}

/** "4.2 MB" / "820 KB" — the Figma's attachment size line. */
export function formatFileSize(bytes: number | null): string | undefined {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** "atlas-mobile-flow-v3.pdf" → "PDF"; a name without an extension has no type line. */
export function fileTypeOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toUpperCase();
}

/** L2: whether the download door serves this attachment now (clean, or labelled Not scanned). */
function isDownloadable(file: MessageAttachmentSummary): boolean {
  const status = file.scanStatus;
  return status === 'clean' || status === 'not_scanned';
}

/**
 * L2 — one attachment card. A clean file opens; a file the virus scan has not checked yet shows
 * B5's "Not scanned" label and Download (`NotScannedDownload`); under "Block until scanned" the
 * card says the file is being checked, with Download disabled and the reason — never a bare link
 * that answers a raw 409. A file no longer served (rejected after it was attached) says so.
 */
export function ChannelFileCard({
  file,
  href,
  isMobile,
}: {
  file: MessageAttachmentSummary;
  href: string;
  isMobile: boolean;
}) {
  const t = useT();
  const tOr = useTOr();
  const status = file.scanStatus;
  const meta = [formatFileSize(file.sizeBytes), fileTypeOf(file.name)].filter(Boolean).join(' · ');
  const scanRow = status === 'not_scanned' || status === 'being_checked';
  const whyId = `tm-chat-file-why-${file.fileAssetId}`;
  return (
    <li className={scanRow ? 'tm-chat-file tm-scan-row' : 'tm-chat-file'}>
      <span className="tm-chat-file__icon" aria-hidden="true">
        ▣
      </span>
      <span className="tm-chat-file__text">
        <span className="tm-chat-file__name">{file.name}</span>
        {meta !== '' ? <span className="tm-chat-file__meta">{meta}</span> : null}
      </span>
      {status === 'not_scanned' ? <NotScannedDownload href={href} fileName={file.name} /> : null}
      {status === 'being_checked' ? (
        <>
          <span className="tm-scan-row__actions">
            <StateCapsule state="waiting" className="tm-scan-capsule">
              {t('WorkDetail.scanning')}
            </StateCapsule>
            <Button type="button" tone="outline" disabled aria-describedby={whyId}>
              {t('DownloadScan.download')}
            </Button>
          </span>
          <div className="tm-scan-row__message" id={whyId}>
            <InlineAlert tone="warning">{t('DownloadScan.blocked')}</InlineAlert>
          </div>
        </>
      ) : null}
      {status === 'unavailable' ? (
        <span className="tm-chat-file__meta" role="status">
          {t('WorkDetail.unavailable')}
        </span>
      ) : null}
      {status === 'clean' && !isMobile ? (
        <a
          className="tm-chat-file__open"
          href={href}
          aria-label={`${tOr('ProjectChannelScreen.openFile', 'Open')} ${file.name}`}
        >
          {tOr('ProjectChannelScreen.openFile', 'Open')}
        </a>
      ) : null}
    </li>
  );
}

/**
 * A16 — one transcript row as the approved Figma draws it: orb (client-ringed for a client),
 * author · time · "Client" chip · "(edited)", the body or the inline edit card, the attachment
 * cards, the reaction pills, and — on desktop — the hover bar Reply · React · Edit · ⋯ (⋯ holds
 * Create work from this, Edit history and Delete message). On a phone the row opens the actions
 * sheet on a long press, or from its "More actions" control for keyboard and screen-reader users.
 */
function ChannelMessage({
  message,
  selected,
  context,
}: {
  message: MessageSummary;
  selected: boolean;
  context: ChannelRowContext;
}) {
  const t = useT();
  const tOr = useTOr();
  const queries = useQueryClient();
  const { api, organizationSlug, conversationId, isMobile, nameOf, isClient, archived, moderate } =
    context;
  const author = nameOf(message.authorUserId);
  const client = isClient(message.authorUserId);
  const removed = message.deletedAt !== null;
  // Only a plain-text message is edited in place: a rich document has no notation to round-trip.
  const editable = !removed && !archived && message.bodyRich === null && message.body !== null;
  const editing = context.editingId === message.id;

  const attachments = useQuery({
    queryKey: ['message-attachments', organizationSlug, conversationId, message.id],
    // L2: read with the other messages of the page in one batched request, not one GET each.
    queryFn: () => getMessageAttachmentsBatched(api, organizationSlug, conversationId, message.id),
    enabled: !removed,
    staleTime: 30_000,
  });
  const files: readonly MessageAttachmentSummary[] = Array.isArray(attachments.data)
    ? attachments.data
    : [];
  const reactions = useMessageReactionTally(api, organizationSlug, conversationId, message.id);

  const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rowRef = useRef<HTMLLIElement>(null);
  const cancelPress = () => {
    if (pressTimer.current !== undefined) clearTimeout(pressTimer.current);
    pressTimer.current = undefined;
  };
  useEffect(() => cancelPress, []);
  const pressProps = isMobile
    ? {
        onPointerDown: () => {
          cancelPress();
          pressTimer.current = setTimeout(() => {
            if (rowRef.current !== null) context.openSheet(message.id, rowRef.current);
          }, LONG_PRESS_MS);
        },
        onPointerUp: cancelPress,
        onPointerLeave: cancelPress,
        onPointerCancel: cancelPress,
        onContextMenu: (event: { preventDefault: () => void }) => {
          event.preventDefault();
          if (rowRef.current !== null) context.openSheet(message.id, rowRef.current);
        },
      }
    : {};

  const sheetOpen = context.sheetFor === message.id;
  const reactedSet = new Set(reactions.rows.filter((row) => row.reacted).map((row) => row.emoji));

  return (
    <li
      ref={rowRef}
      id={`message-${message.id}`}
      className="tm-chat-message"
      {...(selected ? { 'data-selected': 'true' } : {})}
      {...(sheetOpen ? { 'data-sheet-target': 'true' } : {})}
      {...pressProps}
    >
      <AuthorOrb name={author} client={client} />
      <div className="tm-chat-message__main">
        <div className="tm-chat-message__head">
          <span className="tm-chat-message__author">{author}</span>
          <span className="tm-chat-mono">
            <time dateTime={message.createdAt}>{formatStamp(message.createdAt)}</time>
          </span>
          {client ? (
            <span className="tm-chat-pill tm-chat-pill--client tm-chat-pill--sm">
              {tOr('MentionPicker.client', 'Client')}
            </span>
          ) : null}
          {message.editedAt !== null && !removed ? (
            <span className="tm-chat-message__edited">({t('ProjectChannelScreen.edited')})</span>
          ) : null}
          {selected ? (
            <VisuallyHidden>{t('ProjectChannelScreen.selectedMessage')}</VisuallyHidden>
          ) : null}
        </div>

        {editing ? (
          <InlineEditCard
            api={api}
            organizationSlug={organizationSlug}
            conversationId={conversationId}
            message={message}
            onDone={() => {
              context.setEditingId(undefined);
              void queries.invalidateQueries({
                queryKey: ['messages', organizationSlug, conversationId],
              });
              void queries.invalidateQueries({
                queryKey: ['revisions', organizationSlug, conversationId, message.id],
              });
            }}
            onCancel={() => context.setEditingId(undefined)}
          />
        ) : (
          <MessageBody message={message} nameOf={nameOf} />
        )}

        {files.length > 0 ? (
          <ul className="tm-chat-files">
            {files.map((file) => (
              <ChannelFileCard
                key={file.fileAssetId}
                file={file}
                href={fileContentHref(organizationSlug, file.fileAssetId)}
                isMobile={isMobile}
              />
            ))}
          </ul>
        ) : null}

        {removed ? null : (
          <MessageReactionPills
            api={api}
            organizationSlug={organizationSlug}
            conversationId={conversationId}
            messageId={message.id}
            pickerOpen={context.pickerFor === message.id}
            onPickerOpenChange={(open) => context.setPickerFor(open ? message.id : undefined)}
            showAdd={!isMobile}
          />
        )}

        {isMobile ? (
          <button
            type="button"
            className="tm-chat-phone-more"
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            onClick={(event) => context.openSheet(message.id, event.currentTarget)}
          >
            {tOr('ProjectChannelScreen.moreActions', 'More actions')}
          </button>
        ) : (
          <div className="tm-chat-message__actions">
            <button
              type="button"
              className="tm-chat-hover"
              aria-label={t('ProjectChannelScreen.replyInThread')}
              aria-expanded={context.threadRootId === message.id}
              onClick={(event) => context.openThread(message.id, event.currentTarget)}
            >
              <span aria-hidden="true">↩</span>
              {tOr('ProjectChannelScreen.replyShort', 'Reply')}
            </button>
            {removed ? null : (
              <button
                type="button"
                className="tm-chat-hover"
                aria-expanded={context.pickerFor === message.id}
                onClick={() =>
                  context.setPickerFor(context.pickerFor === message.id ? undefined : message.id)
                }
              >
                <span aria-hidden="true">☺</span>
                {tOr('ProjectChannelScreen.reactShort', 'React')}
              </button>
            )}
            {editable ? (
              <button
                type="button"
                className="tm-chat-hover"
                aria-expanded={editing}
                onClick={() => context.setEditingId(editing ? undefined : message.id)}
              >
                <span aria-hidden="true">✎</span>
                {tOr('ProjectChannelScreen.editShort', 'Edit')}
              </button>
            ) : null}
            {removed && message.editedAt === null ? null : (
              <button
                type="button"
                className="tm-chat-hover"
                aria-label={tOr('ProjectChannelScreen.moreActions', 'More actions')}
                aria-expanded={context.moreFor === message.id}
                onClick={() =>
                  context.setMoreFor(context.moreFor === message.id ? undefined : message.id)
                }
              >
                <span aria-hidden="true">⋯</span>
              </button>
            )}
            {context.moreFor === message.id ? (
              <div className="tm-chat-more">
                {removed ? null : (
                  <button
                    type="button"
                    className="tm-chat-more__item"
                    aria-expanded={context.convertTargetId === message.id}
                    onClick={() => {
                      context.setMoreFor(undefined);
                      context.setConvertTargetId((current) =>
                        current === message.id ? undefined : message.id,
                      );
                    }}
                  >
                    {t('ProjectChannelScreen.createWorkFromThis')}
                  </button>
                )}
                {removed || message.body === null ? null : (
                  <button
                    type="button"
                    className="tm-chat-more__item"
                    aria-haspopup="dialog"
                    onClick={() => {
                      context.setMoreFor(undefined);
                      context.recordDecision(message);
                    }}
                  >
                    {tOr('RecordDecision.action', 'Record as decision')}
                  </button>
                )}
                {message.editedAt !== null ? (
                  <button
                    type="button"
                    className="tm-chat-more__item"
                    aria-expanded={context.historyMessageId === message.id}
                    onClick={() => {
                      context.setMoreFor(undefined);
                      context.setHistoryMessageId((current) =>
                        current === message.id ? undefined : message.id,
                      );
                    }}
                  >
                    {t('ProjectChannelScreen.editHistory')}
                  </button>
                ) : null}
                {removed ? null : (
                  <button
                    type="button"
                    className="tm-chat-more__item tm-chat-more__item--danger"
                    onClick={() => {
                      context.setMoreFor(undefined);
                      context.setRemoveTargetId(message.id);
                    }}
                  >
                    {tOr('MessageActionsSheet.delete', 'Delete message')}
                  </button>
                )}
              </div>
            ) : null}
          </div>
        )}

        {context.removeTargetId === message.id ? (
          <InlineAlert tone="warning" title={t('ProjectChannelScreen.removeConfirmTitle')} live>
            <p className="tm-prose">{t('ProjectChannelScreen.removeConfirmBody')}</p>
            <div className="tm-row">
              <Button
                tone="destructive"
                size="accessible"
                loading={moderate.isPending}
                loadingLabel={t('ProjectChannelScreen.removing')}
                onClick={() => moderate.mutate(message.id)}
              >
                {t('ProjectChannelScreen.removeIt')}
              </Button>
              <Button
                tone="outline"
                size="accessible"
                onClick={() => context.setRemoveTargetId(undefined)}
              >
                {t('ProjectChannelScreen.leaveIt')}
              </Button>
            </div>
            {moderate.isError ? (
              <p className="tm-prose">{describeError(moderate.error, t)}</p>
            ) : null}
          </InlineAlert>
        ) : null}

        {context.historyMessageId === message.id ? (
          <RevisionHistory
            api={api}
            organizationSlug={organizationSlug}
            conversationId={conversationId}
            messageId={message.id}
          />
        ) : null}
      </div>

      {sheetOpen ? (
        <MessageActionsSheet
          reacted={reactedSet}
          onReact={reactions.react}
          onMoreReactions={() => context.setPickerFor(message.id)}
          onReply={() => {
            if (rowRef.current !== null) context.openThread(message.id, rowRef.current);
          }}
          {...(editable ? { onEdit: () => context.setEditingId(message.id) } : {})}
          {...(!removed && message.body !== null
            ? { onRecordDecision: () => context.recordDecision(message) }
            : {})}
          {...(!removed && message.body !== null
            ? {
                onCopy: () => {
                  const text = message.body ?? '';
                  void navigator.clipboard?.writeText(text).catch(() => {});
                },
              }
            : {})}
          {...(files[0] !== undefined && isDownloadable(files[0])
            ? {
                attachmentHref: fileContentHref(organizationSlug, files[0].fileAssetId),
                attachmentName: files[0].name,
              }
            : {})}
          {...(removed ? {} : { onDelete: () => context.setRemoveTargetId(message.id) })}
          onClose={context.closeSheet}
        />
      ) : null}
    </li>
  );
}

/**
 * A16 — the inline edit card: the message's text in place, "Enter to save · Esc to cancel",
 * Cancel and Save. Saving PATCHes the body; the API keeps the replaced text as a revision, which
 * is what the "(edited)" mark and Edit history read.
 */
function InlineEditCard({
  api,
  organizationSlug,
  conversationId,
  message,
  onDone,
  onCancel,
}: {
  api: ApiClient;
  organizationSlug: string;
  conversationId: string;
  message: MessageSummary;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const tOr = useTOr();
  const [draft, setDraft] = useState(message.body ?? '');
  const controlRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const control = controlRef.current;
    if (control === null) return;
    control.focus();
    control.setSelectionRange(control.value.length, control.value.length);
  }, []);
  const save = useMutation({
    mutationFn: (body: string) =>
      editChannelMessage(api, organizationSlug, conversationId, message.id, body),
    onSuccess: onDone,
  });
  const trimmed = draft.trim();
  const unchanged = trimmed === (message.body ?? '').trim();
  const performSave = () => {
    if (trimmed === '' || save.isPending) return;
    if (unchanged) {
      onCancel();
      return;
    }
    save.mutate(trimmed);
  };
  const controlId = `tm-edit-${message.id}`;

  return (
    <div className="tm-chat-edit">
      <label className="tm-visually-hidden" htmlFor={controlId}>
        {tOr('MessageActionsSheet.edit', 'Edit message')}
      </label>
      <textarea
        id={controlId}
        ref={controlRef}
        className="tm-chat-edit__input"
        rows={1}
        maxLength={16000}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            performSave();
          }
        }}
      />
      {save.isError ? (
        <InlineAlert tone="danger" title={tOr('ProjectChannelScreen.notSaved', 'Not saved')} live>
          {describeError(save.error, t)}
        </InlineAlert>
      ) : null}
      <div className="tm-chat-edit__foot">
        <span className="tm-chat-edit__hint">
          {tOr('ProjectChannelScreen.editHint', 'Enter to save · Esc to cancel')}
        </span>
        <button type="button" className="tm-chat-edit__cancel" onClick={onCancel}>
          {t('ProjectChannelScreen.cancel')}
        </button>
        <button
          type="button"
          className="tm-chat-edit__save"
          disabled={trimmed === '' || save.isPending}
          aria-busy={save.isPending}
          onClick={performSave}
        >
          {tOr('ProjectChannelScreen.save', 'Save')}
        </button>
      </div>
    </div>
  );
}

/**
 * A16 — the right Members panel: "Members · n", INTERNAL · n and CLIENT · n groups (a client
 * ringed and chipped "Client"), and "Add people", which lists the organization's members who are
 * not in the channel yet and adds the one picked. Presence is not drawn: the API has no online
 * signal, and a dot that always said "Online" would be invented.
 */
function ChannelMembersPanel({
  api,
  organizationSlug,
  conversationId,
  memberIds,
  total,
  nameOf,
  isClient,
  archived,
}: {
  api: ApiClient;
  organizationSlug: string;
  conversationId: string;
  memberIds: readonly string[];
  total: number;
  nameOf: (userId: string) => string;
  isClient: (userId: string) => boolean;
  archived: boolean;
}) {
  const tOr = useTOr();
  const queries = useQueryClient();
  const [adding, setAdding] = useState(false);
  const directory = useMembers(api, organizationSlug);
  const internal = memberIds.filter((id) => !isClient(id));
  const clients = memberIds.filter((id) => isClient(id));
  const inChannel = new Set(memberIds);
  const candidates = (directory.members ?? []).filter(
    (member) => !inChannel.has(member.userId) && member.status !== 'suspended',
  );
  const add = useMutation({
    mutationFn: (userId: string) => addChannelMember(api, organizationSlug, conversationId, userId),
    onSuccess: () => {
      void queries.invalidateQueries({
        queryKey: ['channel-members', organizationSlug, conversationId],
      });
      void queries.invalidateQueries({
        queryKey: ['conversations', organizationSlug, 'directory'],
      });
    },
  });

  const person = (userId: string, client: boolean) => (
    <li key={userId} className="tm-chat-members__row">
      <AuthorOrb name={nameOf(userId)} size="sm" client={client} />
      <span className="tm-chat-members__name">{nameOf(userId)}</span>
      {client ? (
        <span className="tm-chat-pill tm-chat-pill--client tm-chat-pill--sm">
          {tOr('MentionPicker.client', 'Client')}
        </span>
      ) : null}
    </li>
  );

  return (
    <section
      className="tm-chat-members"
      aria-label={tOr('ProjectChannelScreen.membersHeading', 'Members')}
    >
      <h2 className="tm-chat-members__head">
        <span>{tOr('ProjectChannelScreen.membersHeading', 'Members')}</span>
        <span className="tm-chat-members__total">{total}</span>
      </h2>
      <h3 className="tm-chat-members__group">
        {tOr('ProjectChannelScreen.internalGroup', 'Internal')} · {internal.length}
      </h3>
      <ul className="tm-chat-members__list">{internal.map((id) => person(id, false))}</ul>
      {clients.length > 0 ? (
        <>
          <h3 className="tm-chat-members__group">
            {tOr('ProjectChannelScreen.clientGroup', 'Client')} · {clients.length}
          </h3>
          <ul className="tm-chat-members__list">{clients.map((id) => person(id, true))}</ul>
        </>
      ) : null}
      {archived ? null : (
        <button
          type="button"
          className="tm-chat-members__add"
          aria-expanded={adding}
          onClick={() => setAdding((open) => !open)}
        >
          {tOr('ProjectChannelScreen.addPeople', 'Add people')}
        </button>
      )}
      {adding ? (
        candidates.length === 0 ? (
          <p className="tm-chat-members__empty">
            {tOr('ProjectChannelScreen.everyoneIsHere', 'Everyone in the organization is here.')}
          </p>
        ) : (
          <ul
            className="tm-chat-members__list"
            aria-label={tOr('ProjectChannelScreen.addPeople', 'Add people')}
          >
            {candidates.map((member) => (
              <li key={member.userId}>
                <button
                  type="button"
                  className="tm-chat-members__pick"
                  disabled={add.isPending}
                  onClick={() => add.mutate(member.userId)}
                >
                  <AuthorOrb name={member.displayName} size="sm" />
                  <span className="tm-chat-members__name">{member.displayName}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {add.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('ProjectChannelScreen.couldNotAdd', 'Not added')}
          live
        >
          {add.error instanceof ApiRequestError ? add.error.message : ''}
        </InlineAlert>
      ) : null}
    </section>
  );
}

function describeError(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('ProjectChannelScreen.apiError');
  return t('ProjectChannelScreen.genericError');
}

/** The first eight characters of an author id — see the screen comment on the directory gap. */
function shortAuthor(userId: string): string {
  return userId.slice(0, 8);
}

/** Up to two initials for an author orb: "Lina Samir" → "LS", a short id → its first two. */
function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '');
  if (words.length >= 2) return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function AuthorOrb({
  name,
  size,
  client = false,
}: {
  name: string;
  size?: 'sm' | 'md';
  client?: boolean;
}) {
  return (
    <span
      className={`tm-chat-orb${size === undefined ? '' : ` tm-chat-orb--${size}`}${client ? ' tm-chat-orb--client' : ''}`}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  );
}

function MessageHeader({
  message,
  author,
  selected = false,
}: {
  message: MessageSummary;
  author: string;
  selected?: boolean;
}) {
  const t = useT();
  return (
    <div className="tm-chat-message__head">
      <span className="tm-chat-message__author">{author}</span>
      <span className="tm-chat-mono">
        <time dateTime={message.createdAt}>{formatStamp(message.createdAt)}</time>
        {message.editedAt !== null && message.deletedAt === null ? (
          <> · {t('ProjectChannelScreen.edited')}</>
        ) : null}
        {selected ? <> · {t('ProjectChannelScreen.selectedMessage')}</> : null}
      </span>
    </div>
  );
}

/** CH-02's transcript stamp: the time alone for today, the day and time otherwise. */
function formatStamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const today = new Date();
  const sameDay = parsed.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(
    undefined,
    sameDay
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  ).format(parsed);
}

function formatWhen(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    parsed,
  );
}

function MessageBody({
  message,
  nameOf,
}: {
  message: MessageSummary;
  nameOf?: (userId: string) => string;
}) {
  const t = useT();
  if (message.deletedAt !== null) {
    return (
      <p className="tm-chat-message__tombstone">
        {t('ProjectChannelScreen.removedByModerator')}{' '}
        <time dateTime={message.deletedAt}>{formatWhen(message.deletedAt)}</time>
        {t('ProjectChannelScreen.removalKept')}
      </p>
    );
  }
  if (message.bodyRich !== null) {
    return (
      <div className="tm-chat-message__body">
        <RichTextBody document={message.bodyRich} />
      </div>
    );
  }
  // A plain body renders as text with its line breaks honoured — the one formatting a plain
  // message can carry.
  // A mention is stored as the API's `@<userId>` token and read back as the person's name.
  const body =
    nameOf === undefined || message.body === null
      ? message.body
      : decodeMentions(message.body, (id) => {
          const name = nameOf(id);
          return name === shortAuthor(id) ? undefined : name;
        });
  return <p className="tm-chat-message__body tm-break">{body}</p>;
}

/**
 * The formatting a toolbar button applies: wrap the selection inline, prefix the selected
 * lines, or fence them. All three edit the *notation* in the textarea — the person always
 * sees exactly what will be converted, and the preview shows what it converts to.
 */
type ToolbarEdit =
  | { readonly kind: 'wrap'; readonly before: string; readonly after: string }
  | { readonly kind: 'prefix'; readonly marker: string }
  | { readonly kind: 'fence' };

const TOOLBAR: readonly { labelKey: MessageKey; glyph: string; edit: ToolbarEdit }[] = [
  {
    labelKey: 'ProjectChannelScreen.toolbarBold',
    glyph: 'B',
    edit: { kind: 'wrap', before: '**', after: '**' },
  },
  {
    labelKey: 'ProjectChannelScreen.toolbarItalic',
    glyph: 'I',
    edit: { kind: 'wrap', before: '_', after: '_' },
  },
  {
    labelKey: 'ProjectChannelScreen.toolbarStrikethrough',
    glyph: 'S',
    edit: { kind: 'wrap', before: '~~', after: '~~' },
  },
  {
    labelKey: 'ProjectChannelScreen.toolbarCode',
    glyph: '`',
    edit: { kind: 'wrap', before: '`', after: '`' },
  },
  {
    labelKey: 'ProjectChannelScreen.toolbarLink',
    glyph: '↗',
    edit: { kind: 'wrap', before: '[', after: '](https://)' },
  },
  {
    labelKey: 'ProjectChannelScreen.toolbarQuote',
    glyph: '❝',
    edit: { kind: 'prefix', marker: '> ' },
  },
  {
    labelKey: 'ProjectChannelScreen.toolbarBulletedList',
    glyph: '•',
    edit: { kind: 'prefix', marker: '- ' },
  },
  {
    labelKey: 'ProjectChannelScreen.toolbarNumberedList',
    glyph: '1.',
    edit: { kind: 'prefix', marker: '1. ' },
  },
  { labelKey: 'ProjectChannelScreen.toolbarCodeBlock', glyph: '{}', edit: { kind: 'fence' } },
];

/** Apply one toolbar edit to the draft at the current selection. Returns the new draft. */
function applyToolbarEdit(
  draft: string,
  selectionStart: number,
  selectionEnd: number,
  edit: ToolbarEdit,
): string {
  const before = draft.slice(0, selectionStart);
  const selected = draft.slice(selectionStart, selectionEnd);
  const after = draft.slice(selectionEnd);

  if (edit.kind === 'wrap') {
    return `${before}${edit.before}${selected || 'text'}${edit.after}${after}`;
  }
  if (edit.kind === 'prefix') {
    // Prefix every line the selection touches, from the start of its first line.
    const lineStart = before.lastIndexOf('\n') + 1;
    const head = draft.slice(0, lineStart);
    const target = draft.slice(lineStart, selectionEnd) || 'text';
    const prefixed = target
      .split('\n')
      .map((line) => `${edit.marker}${line}`)
      .join('\n');
    return `${head}${prefixed}${after}`;
  }
  const block = selected || 'code';
  const openFence = before === '' || before.endsWith('\n') ? '```\n' : '\n```\n';
  return `${before}${openFence}${block}\n\`\`\`\n${after}`;
}

/**
 * The composer, used by the channel and by the thread pane. One component so the dedupe
 * behaviour — mint the id when a send starts, keep it until that send succeeds — cannot
 * drift between the two.
 *
 * ## The rich half — WEB-003's second half
 *
 * The toolbar writes the composer's notation into the textarea; `composeMessage` converts
 * it to CHAT-002's closed grammar; the preview renders the converted document through the
 * same `RichTextBody` the transcript uses, so what is previewed is what a reader will see —
 * not a second renderer's opinion. A draft that uses no notation is sent as plain `body`,
 * exactly as before. Before a rich send, `sanitizeRichText` — the domain's own gate, the
 * same one the API applies — runs here so an inadmissible document is refused with its
 * path *before* the network, not after. No HTML exists at any point in this path.
 */
function Composer({
  api,
  organizationSlug,
  conversationId,
  archived,
  label,
  placeholder,
  parentMessageId,
  mentions,
}: {
  api: ApiClient;
  organizationSlug: string;
  conversationId: string;
  archived: boolean;
  label: string;
  placeholder?: string;
  parentMessageId?: string;
  /** A4 (m-mention): the channel composer's @ picker. Absent on a thread reply. */
  mentions?: {
    projectMemberIds: ReadonlySet<string>;
    subtitleOf: (userId: string, group: MentionGroup) => string | undefined;
  };
}) {
  const queries = useQueryClient();
  const t = useT();
  const [draft, setDraft] = useState('');
  const dictation = useDictation({
    value: draft,
    onChange: (next) => setDraft(next.slice(0, 16000)),
  });
  const [attemptId, setAttemptId] = useState<string | undefined>(undefined);
  const [inadmissible, setInadmissible] = useState<string | undefined>(undefined);
  const [toolsOpen, setToolsOpen] = useState(false);
  const controlRef = useRef<HTMLTextAreaElement | null>(null);
  const tOr = useTOr();
  const mention = useMentionComposer({
    api,
    organizationSlug,
    conversationId,
    draft,
    setDraft,
    controlRef,
    ...(mentions === undefined
      ? {}
      : { projectMemberIds: mentions.projectMemberIds, subtitleOf: mentions.subtitleOf }),
  });
  const mentionsOn = mentions !== undefined;

  // x251. Only the channel composer persists an unsent draft; a thread reply is transient and
  // has no per-thread draft on the server (the draft is keyed to the conversation). The notation
  // in the textarea is what is saved verbatim, so what is restored is exactly what was typed.
  const persistDraft = parentMessageId === undefined;
  const restoredRef = useRef(false);

  // Restore the saved draft once, on open, and never over text the author has already started —
  // the seed only ever fills an empty box.
  useEffect(() => {
    if (!persistDraft || restoredRef.current) return;
    let cancelled = false;
    void getDraft(api, organizationSlug, conversationId)
      .then((saved) => {
        if (cancelled) return;
        restoredRef.current = true;
        if (typeof saved.body === 'string' && saved.body !== '') {
          setDraft((current) => (current === '' ? (saved.body as string) : current));
        }
      })
      .catch(() => {
        // A draft that cannot be loaded is not worth surfacing: the composer opens empty, which
        // is the same state as "no draft", and the send path is unaffected.
        restoredRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [api, organizationSlug, conversationId, persistDraft]);

  // Save what is typed, debounced, once the restore has settled so a save cannot race the seed.
  // An emptied box clears the stored draft; a non-empty one upserts it. A failed save is silent —
  // the draft is a convenience, not the message, and the next keystroke tries again.
  useEffect(() => {
    if (!persistDraft || !restoredRef.current) return;
    const handle = setTimeout(() => {
      const write =
        draft === ''
          ? clearDraft(api, organizationSlug, conversationId)
          : saveDraft(api, organizationSlug, conversationId, draft);
      void Promise.resolve(write).catch(() => {});
    }, 800);
    return () => clearTimeout(handle);
  }, [draft, api, organizationSlug, conversationId, persistDraft]);

  // Picked names go out as the API's mention tokens (`@<userId>`).
  const encodeMentions = mention.encode;
  const composed = useMemo(
    () => (draft.trim() === '' ? undefined : composeMessage(encodeMentions(draft))),
    [draft, encodeMentions],
  );

  const send = useMutation({
    mutationFn: (input: PostMessageInput) =>
      postMessage(api, organizationSlug, conversationId, {
        ...input,
        ...(parentMessageId === undefined ? {} : { parentMessageId }),
      }),
    onSuccess: () => {
      setDraft('');
      setAttemptId(undefined);
      // The message is sent, so its draft is spent — clear it so a reopen does not restore text
      // that is already in the transcript.
      if (persistDraft) void clearDraft(api, organizationSlug, conversationId).catch(() => {});
      void queries.invalidateQueries({ queryKey: ['messages', organizationSlug, conversationId] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    performSend();
  }

  /**
   * COL-13: Enter sends; Shift+Enter inserts a newline. The guard against `isComposing` keeps an
   * IME mid-composition Enter (choosing a candidate) from sending, so composing Arabic, Japanese or
   * any other input method is unaffected. Any modifier (Ctrl/Cmd/Alt) is left to the browser.
   */
  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionsOn && mention.onKeyDown(event)) return;
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

  function performSend() {
    if (composed === undefined || send.isPending) return;
    setInadmissible(undefined);

    let content: Pick<PostMessageInput, 'body' | 'bodyRich'>;
    if (composed.kind === 'plain') {
      content = { body: composed.body.trim() };
    } else {
      try {
        // The same refusal the API would give, raised before the network so the path to
        // the offending node points at something the author can still edit.
        content = { bodyRich: sanitizeRichText(composed.document) };
      } catch (error) {
        setInadmissible(
          error instanceof InadmissibleRichTextError
            ? error.message
            : t('ProjectChannelScreen.cannotFormat'),
        );
        return;
      }
    }

    // Reuse the attempt id when this is a retry of a failed send; mint one otherwise.
    const clientGeneratedId = attemptId ?? newCorrelationId();
    setAttemptId(clientGeneratedId);
    send.mutate({ ...content, clientGeneratedId });
  }

  function applyEdit(edit: ToolbarEdit) {
    const control = controlRef.current;
    const start = control?.selectionStart ?? draft.length;
    const end = control?.selectionEnd ?? draft.length;
    setDraft(applyToolbarEdit(draft, start, end, edit));
    control?.focus();
  }

  const controlId = parentMessageId === undefined ? 'tm-composer' : 'tm-thread-composer';
  // A16: the channel composer is the Figma's "+ · @ · →" card — the formatting toolbar sits
  // behind "+" — while the thread reply keeps its full toolbar, dictation and labelled Send.
  const channelStyle = parentMessageId === undefined;
  const toolbar = (
    <div
      className="tm-chat-composer__tools"
      role="group"
      aria-label={t('ProjectChannelScreen.formattingGroup')}
    >
      {TOOLBAR.map((tool) => (
        <button
          key={tool.labelKey}
          type="button"
          className="tm-chat-composer__tool"
          aria-label={t(tool.labelKey)}
          title={t(tool.labelKey)}
          onClick={() => applyEdit(tool.edit)}
        >
          <span aria-hidden="true">{tool.glyph}</span>
        </button>
      ))}
    </div>
  );

  if (archived) {
    return <p className="tm-chat-archived">{t('ProjectChannelScreen.channelArchived')}</p>;
  }

  return (
    <form className="tm-chat-composer" onSubmit={submit}>
      <label className="tm-visually-hidden" htmlFor={controlId}>
        {label}
      </label>
      <textarea
        id={controlId}
        ref={controlRef}
        className="tm-chat-composer__input"
        rows={parentMessageId === undefined ? 1 : 3}
        maxLength={16000}
        value={draft}
        placeholder={placeholder ?? label}
        onChange={(event) => {
          setDraft(event.target.value);
          if (mentionsOn) {
            mention.sync(
              event.target.value,
              event.target.selectionStart ?? event.target.value.length,
            );
          }
        }}
        onKeyDown={onComposerKeyDown}
        {...(mentionsOn ? mention.controlProps : {})}
      />

      {mentionsOn && mention.open ? (
        <MentionPicker
          id={mention.listboxId}
          options={mention.options}
          activeIndex={mention.activeIndex}
          onPick={mention.pick}
          onHover={mention.setActiveIndex}
        />
      ) : null}

      {composed?.kind === 'rich' ? (
        <section className="tm-chat-preview" aria-label={t('ProjectChannelScreen.previewAria')}>
          <h3 className="tm-chat-eyebrow">{t('ProjectChannelScreen.previewHeading')}</h3>
          <RichTextBody document={composed.document} />
        </section>
      ) : null}

      {inadmissible !== undefined ? (
        <InlineAlert tone="danger" title={t('ProjectChannelScreen.formattingCannotSend')} live>
          {inadmissible}
        </InlineAlert>
      ) : null}

      {send.isError ? (
        <InlineAlert tone="danger" title={t('ProjectChannelScreen.notSent')} live>
          {describeError(send.error, t)}{' '}
          {send.error instanceof NetworkError ? t('ProjectChannelScreen.textStillHere') : ''}
        </InlineAlert>
      ) : null}

      {channelStyle ? (
        <div className="tm-chat-composer__bar tm-chat-composer__bar--channel">
          <button
            type="button"
            className="tm-chat-side__round"
            aria-label={tOr('ProjectChannelScreen.formattingToggle', 'Formatting')}
            title={tOr('ProjectChannelScreen.formattingToggle', 'Formatting')}
            aria-expanded={toolsOpen}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setToolsOpen((open) => !open)}
          >
            <span aria-hidden="true">+</span>
          </button>
          {toolsOpen ? toolbar : null}
          <span className="tm-chat-composer__spacer" aria-hidden="true" />
          {mentionsOn ? (
            <MentionButton
              label={tOr('MentionPicker.button', 'Mention someone')}
              onClick={mention.openAtCaret}
            />
          ) : null}
          <button
            type="submit"
            className="tm-chat-side__send"
            aria-label={
              send.isPending ? t('ProjectChannelScreen.sending') : t('ProjectChannelScreen.send')
            }
            title={t('ProjectChannelScreen.send')}
            disabled={composed === undefined || send.isPending}
            aria-busy={send.isPending}
          >
            <span className="tm-chat-side__send-arrow" aria-hidden="true">
              →
            </span>
          </button>
        </div>
      ) : (
        <div className="tm-chat-composer__bar">
          {toolbar}
          <MicButton dictation={dictation} compact />
          <button
            type="submit"
            className="tm-chat-send"
            disabled={composed === undefined || send.isPending}
            aria-busy={send.isPending}
          >
            <span className="tm-chat-send__orb" aria-hidden="true">
              ↑
            </span>
            {send.isPending ? t('ProjectChannelScreen.sending') : t('ProjectChannelScreen.send')}
          </button>
        </div>
      )}
      {channelStyle ? null : <MicNotice dictation={dictation} />}
    </form>
  );
}

/**
 * TM-08: the source message pinned, its replies under it, a composer for the next one.
 * Reading order is source, then replies oldest-first, then the composer — the keyboard
 * order §4 asks to maintain, achieved by DOM order rather than by script.
 */
function ThreadPane({
  api,
  organizationSlug,
  conversationId,
  root,
  archived,
  nameOf,
  onClose,
}: {
  api: ApiClient;
  organizationSlug: string;
  conversationId: string;
  root: MessageSummary;
  archived: boolean;
  nameOf: (userId: string) => string;
  onClose: () => void;
}) {
  const t = useT();
  // The transcript's paging, applied to a thread: same cursor, same accumulation.
  const replies = useInfiniteQuery({
    queryKey: ['messages', organizationSlug, conversationId, 'thread', root.id],
    queryFn: ({ pageParam }) =>
      listMessages(api, organizationSlug, conversationId, {
        parentMessageId: root.id,
        limit: MAX_MESSAGE_PAGE,
        ...(pageParam === undefined ? {} : { afterSequenceNo: pageParam }),
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length === MAX_MESSAGE_PAGE ? lastPage[lastPage.length - 1]?.sequenceNo : undefined,
  });

  const replyRows = useMemo(() => replies.data?.pages.flat() ?? [], [replies.data]);

  /*
   * WCAG 2.2 4.1.3, verbosity — the x46 pattern (61f4f44) applied to the thread pane. The replies
   * <ol> is a live region so a genuinely new reply (one that arrives through the ordinary refetch
   * path a live frame triggers) is announced. But "Load more replies" appends a whole page — up to
   * MAX_MESSAGE_PAGE rows — at once, and a live region would read the lot out. We hold the region
   * silent across a manual page fetch and re-enable it only afterwards. `announceReplies` mirrors
   * `!isFetchingNextPage` one render late, which is what keeps the region `off` through the commit
   * that appends the page; a live refetch never toggles that flag, so it stays announced.
   */
  const [announceReplies, setAnnounceReplies] = useState(true);
  useEffect(() => {
    setAnnounceReplies(!replies.isFetchingNextPage);
  }, [replies.isFetchingNextPage]);

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // WCAG 2.2 2.4.3: move focus into the pane when it opens, rather than leaving the keyboard
    // user on the trigger with the pane rendered after <main> and reachable only by tabbing the
    // whole transcript. Focusing the heading also announces the pane to a screen reader.
    headingRef.current?.focus();
  }, []);

  return (
    <div className="tm-chat-thread">
      <div className="tm-chat-thread__head">
        <h2 tabIndex={-1} ref={headingRef}>
          {t('ProjectChannelScreen.thread')}
        </h2>
        <button
          type="button"
          className="tm-chat-close"
          aria-label={t('ProjectChannelScreen.closeThread')}
          onClick={onClose}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      <div className="tm-chat-source">
        <div className="tm-chat-source__head">
          <AuthorOrb name={nameOf(root.authorUserId)} size="md" />
          <span>
            {t('ProjectChannelScreen.sourceMessage')} · {nameOf(root.authorUserId)} ·{' '}
            <time dateTime={root.createdAt}>{formatStamp(root.createdAt)}</time>
          </span>
        </div>
        <MessageBody message={root} nameOf={nameOf} />
      </div>

      {replies.isPending ? (
        <LoadingRegion label={t('ProjectChannelScreen.loadingReplies')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {replies.isError ? (
        <InlineAlert tone="danger" title={t('ProjectChannelScreen.couldNotLoadReplies')} live>
          {describeError(replies.error, t)}
        </InlineAlert>
      ) : null}

      {replies.data && replyRows.length === 0 ? (
        <p className="tm-chat-mono">{t('ProjectChannelScreen.noRepliesYet')}</p>
      ) : null}

      {replyRows.length > 0 ? (
        <ol
          className="tm-chat-replies"
          aria-label={t('ProjectChannelScreen.repliesListAria')}
          aria-live={announceReplies ? 'polite' : 'off'}
          aria-relevant="additions"
        >
          {replyRows.map((reply) => (
            <li key={reply.id} className="tm-chat-message">
              <AuthorOrb name={nameOf(reply.authorUserId)} />
              <div className="tm-chat-message__main">
                <MessageHeader message={reply} author={nameOf(reply.authorUserId)} />
                <MessageBody message={reply} nameOf={nameOf} />
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {replies.hasNextPage ? (
        <div className="tm-row">
          <Button
            tone="outline"
            size="compact"
            loading={replies.isFetchingNextPage}
            loadingLabel={t('ProjectChannelScreen.loadingMore')}
            onClick={() => void replies.fetchNextPage()}
          >
            {t('ProjectChannelScreen.loadMoreReplies')}
          </Button>
        </div>
      ) : null}

      <Composer
        api={api}
        organizationSlug={organizationSlug}
        conversationId={conversationId}
        archived={archived}
        label={t('ProjectChannelScreen.replyInThisThread')}
        placeholder={t('ProjectChannelScreen.replyInThreadPlaceholder')}
        parentMessageId={root.id}
      />
    </div>
  );
}

/** CHAT-002's revisions, oldest first. The current body is the message itself, above. */
function RevisionHistory({
  api,
  organizationSlug,
  conversationId,
  messageId,
}: {
  api: ApiClient;
  organizationSlug: string;
  conversationId: string;
  messageId: string;
}) {
  const t = useT();
  const revisions = useQuery({
    queryKey: ['revisions', organizationSlug, conversationId, messageId],
    queryFn: () => listRevisions(api, organizationSlug, conversationId, messageId),
  });

  if (revisions.isPending) {
    return (
      <LoadingRegion label={t('ProjectChannelScreen.loadingEditHistory')}>
        <Skeleton height="var(--row)" />
      </LoadingRegion>
    );
  }
  if (revisions.isError) {
    return (
      <InlineAlert tone="danger" title={t('ProjectChannelScreen.couldNotLoadEditHistory')} live>
        {describeError(revisions.error, t)}
      </InlineAlert>
    );
  }

  return (
    <section className="tm-chat-history" aria-label={t('ProjectChannelScreen.editHistoryAria')}>
      <h3 className="tm-chat-eyebrow">
        {t('ProjectChannelScreen.beforeEdited')} · {revisions.data.length}
      </h3>
      {revisions.data.length === 0 ? (
        <p className="tm-prose">{t('ProjectChannelScreen.noEarlierVersions')}</p>
      ) : (
        <ol className="tm-chat-history__list">
          {revisions.data.map((revision) => (
            <li key={revision.revisionNo}>
              <span className="tm-chat-mono">
                {t('ProjectChannelScreen.version')} {revision.revisionNo}
                {t('ProjectChannelScreen.replacedComma')}{' '}
                <time dateTime={revision.replacedAt}>{formatWhen(revision.replacedAt)}</time>
              </span>
              {revision.body === null && revision.bodyRich === null ? (
                <p className="tm-prose">
                  <em>{t('ProjectChannelScreen.withheldRemoved')}</em>
                </p>
              ) : revision.bodyRich !== null ? (
                <RichTextBody document={revision.bodyRich} />
              ) : (
                <p className="tm-prose tm-break">{revision.body}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * N02: the API answers one 409 `message_already_converted` when the message already became
 * work the caller cannot open (it says nothing about that work). The client error vocabulary
 * is coarse (`conflict`), so the reason travels in the first detail. Any other 409 keeps the
 * removed-message wording.
 */
function isAlreadyConvertedHidden(error: ApiRequestError): boolean {
  return (
    (error.code as string) === 'message_already_converted' ||
    error.details[0]?.message === 'message_already_converted'
  );
}

/**
 * **TM-09 Convert message dialog**, painted as CH-08 in the 400px lens. `22-SCREEN-BY-SCREEN`
 * §4: "Type, title, project, owner, due date, audience. Source preview and access warning.
 * Defaults: internal audience; no owner/date invented. Duplicate conversion shows existing link."
 *
 * The project is shown, not chosen — the API files the work on the conversation's project by
 * design, and a dialog that offered a choice it cannot honour would be a lie with a dropdown.
 * The owner is neither shown nor invented: the conversion endpoint takes no owner, so the item
 * is created unowned, exactly as §4's "no owner/date invented" asks. The audience defaults to
 * internal and widening it warns before submit, because conversion is the moment a sentence
 * written for the room can become a sentence a client reads.
 */
function ConvertDialog({
  api,
  organizationSlug,
  conversationId,
  message,
  authorName,
  projectName,
  onDone,
  onClose,
}: {
  api: ApiClient;
  organizationSlug: string;
  conversationId: string;
  message: MessageSummary;
  authorName: string;
  projectName: string | undefined;
  onDone: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const defaultTitle = (message.body ?? '').split('\n')[0]?.trim() ?? '';
  const [title, setTitle] = useState(defaultTitle);
  const [type, setType] = useState('task');
  const [audience, setAudience] = useState<WorkAudience>('internal');
  const [dueAt, setDueAt] = useState('');
  const [result, setResult] = useState<ConvertMessageResult | undefined>(undefined);

  const convert = useMutation({
    mutationFn: () =>
      convertMessageToWork(api, organizationSlug, conversationId, message.id, {
        ...(title.trim() === '' ? {} : { title: title.trim() }),
        ...(type.trim() === '' ? {} : { type: type.trim() }),
        audience,
        ...(dueAt.trim() === '' ? {} : { dueAt: dueAt.trim() }),
      }),
    onSuccess: (conversion) => {
      setResult(conversion);
      onDone();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (convert.isPending) return;
    convert.mutate();
  }

  const source = (
    <div className="tm-chat-source">
      <div className="tm-chat-source__head">
        <AuthorOrb name={authorName} size="md" />
        <span>
          {t('ProjectChannelScreen.sourceMessage')} · {authorName} ·{' '}
          <time dateTime={message.createdAt}>{formatStamp(message.createdAt)}</time>
        </span>
      </div>
      <blockquote className="tm-chat-source__body tm-break">“{message.body}”</blockquote>
    </div>
  );

  if (result !== undefined) {
    return (
      <div className="tm-chat-thread">
        <div className="tm-chat-thread__head">
          <h2>{t('ProjectChannelScreen.convertToWork')}</h2>
        </div>
        {source}
        <InlineAlert
          tone={result.created ? 'neutral' : 'warning'}
          title={
            result.created
              ? t('ProjectChannelScreen.workItemCreated')
              : t('ProjectChannelScreen.alreadyConverted')
          }
          live
        >
          <p className="tm-prose">
            {result.created
              ? t('ProjectChannelScreen.nowLinked')
              : t('ProjectChannelScreen.convertedBefore')}
          </p>
        </InlineAlert>
        <div className="tm-chat-work">
          <span className="tm-chat-work__orb" aria-hidden="true">
            ▤
          </span>
          <Link href={`/${organizationSlug}/work/${result.workItem.id}`}>
            {result.workItem.title}
          </Link>
        </div>
        <div className="tm-chat-convert__actions">
          <Button tone="outline" size="accessible" onClick={onClose}>
            {t('ProjectChannelScreen.close')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="tm-chat-thread"
      onSubmit={submit}
      aria-label={t('ProjectChannelScreen.createWorkFormAria')}
    >
      <div className="tm-chat-thread__head">
        <h2>{t('ProjectChannelScreen.convertToWork')}</h2>
        <button
          type="button"
          className="tm-chat-close"
          aria-label={t('ProjectChannelScreen.dismiss')}
          onClick={onClose}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      {source}

      <div className="tm-field tm-chat-convert__title">
        <label className="tm-field__label" htmlFor="tm-convert-title">
          {t('ProjectChannelScreen.titleLabel')}
        </label>
        <input
          id="tm-convert-title"
          className="tm-field__control"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={300}
        />
        <span className="tm-field__hint">{t('ProjectChannelScreen.titleHint')}</span>
      </div>

      <div className="tm-chat-convert__pair">
        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-convert-type">
            {t('ProjectChannelScreen.typeLabel')}
          </label>
          <input
            id="tm-convert-type"
            className="tm-field__control"
            value={type}
            onChange={(event) => setType(event.target.value)}
            maxLength={32}
          />
        </div>

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-convert-due">
            {t('ProjectChannelScreen.dueLabel')}
          </label>
          <input
            id="tm-convert-due"
            className="tm-field__control"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
            placeholder="2026-09-30T17:00:00Z"
          />
        </div>
      </div>

      <fieldset className="tm-chat-audience-picker">
        <legend>{t('ProjectChannelScreen.audienceLegend')}</legend>
        {(['internal', 'client_visible', 'client_action_required'] as const).map((option) => (
          <label key={option} className="tm-chat-audience-option">
            <input
              type="radio"
              name="tm-convert-audience"
              value={option}
              checked={audience === option}
              onChange={() => setAudience(option)}
            />
            <span>{audienceLabel(option)}</span>
          </label>
        ))}
      </fieldset>

      <div className="tm-chat-warning">
        <span className="tm-chat-warning__orb" aria-hidden="true">
          !
        </span>
        <p>
          <strong>
            {t('ProjectChannelScreen.filedOn')}{' '}
            {projectName ?? t('ProjectChannelScreen.thisChannelsProject')}
          </strong>
          {t('ProjectChannelScreen.filedNote')}
        </p>
      </div>

      {audience !== 'internal' ? (
        <InlineAlert tone="client" title={t('ProjectChannelScreen.visibleToClientTitle')} live>
          {t('ProjectChannelScreen.visibleToClientBody')}
        </InlineAlert>
      ) : null}

      {convert.isError ? (
        <InlineAlert tone="danger" title={t('ProjectChannelScreen.couldNotCreateWork')} live>
          {describeError(convert.error, t)}
          {convert.error instanceof ApiRequestError && convert.error.status === 409
            ? ` ${t(
                isAlreadyConvertedHidden(convert.error)
                  ? 'ProjectChannelScreen.alreadyConvertedHidden'
                  : 'ProjectChannelScreen.removedCannotConvert',
              )}`
            : ''}
        </InlineAlert>
      ) : null}

      <div className="tm-chat-convert__actions">
        <Button
          type="submit"
          tone="ink"
          size="accessible"
          loading={convert.isPending}
          loadingLabel={t('ProjectChannelScreen.creating')}
        >
          {t('ProjectChannelScreen.createWorkItem')}
        </Button>
        <Button tone="outline" size="accessible" onClick={onClose}>
          {t('ProjectChannelScreen.cancel')}
        </Button>
      </div>
    </form>
  );
}
