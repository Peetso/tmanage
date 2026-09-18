'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InadmissibleRichTextError, sanitizeRichText } from '@tmanage/domain';
import { Badge, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { BackendPending } from './BackendPending';
import { RichTextBody } from '../RichTextBody';
import { browserApiClient } from '../../lib/api/browser-client';
import { newCorrelationId } from '../../lib/api/client';
import { getProject } from '../../lib/api/projects';
import {
  MAX_MESSAGE_PAGE,
  convertMessageToWork,
  getConversation,
  listMessages,
  listRevisions,
  moderateMessage,
  postMessage,
} from '../../lib/api/conversations';
import type {
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
 * React, save and quote-to-decision have no endpoint, no table and no ticket, so they are
 * named in `BackendPending` rather than drawn as buttons that could never work. The same is
 * true of presence, pins, and §4's "persistent external audience banner": a conversation has
 * no audience column — no client role holds any conversation capability, a gap the status
 * file records — so every channel is internal today and a banner would assert a distinction
 * the data cannot make.
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
 * There is no people directory (`28-SPRINT-TICKETS` schedules none), so the author is shown
 * as the first eight characters of their id, monospaced. An id is not a name, but in a
 * transcript the reader needs *at least* to tell speakers apart, which "Someone" for every
 * row would not do. The moment a directory exists this becomes a name lookup.
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

  const [threadRootId, setThreadRootId] = useState<string | undefined>(undefined);
  const [convertTargetId, setConvertTargetId] = useState<string | undefined>(undefined);
  const [historyMessageId, setHistoryMessageId] = useState<string | undefined>(undefined);
  const [removeTargetId, setRemoveTargetId] = useState<string | undefined>(undefined);

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

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="chat"
      title={conversation.data === undefined ? 'Channel' : `#${conversation.data.name}`}
      description={
        <>
          <Link href={`/${organizationSlug}/chat`}>Back to all channels</Link>
          {project.data ? <> · {project.data.name}</> : null}
          {archived ? <> · Archived</> : null}
          {liveStatus === 'off' ? null : ' · '}
          {/*
           * WCAG 2.2 4.1.3 and 4.1.2. This region is mounted from the first render — empty while
           * the socket is off — so a later flip (a dropped connection, above all) is a text
           * mutation of a region that already exists, which is what assistive technology
           * announces; the old chip was mounted together with its text and so was routinely not
           * announced, and a person whose channel had silently stopped updating was told nothing.
           * `role="status"` also *permits* the accessible name that a bare <span> (implicit role
           * `generic`) prohibits, so the fuller sentence is honoured rather than silently dropped.
           */}
          <span
            role="status"
            aria-label={
              liveStatus === 'live'
                ? 'Live updates connected'
                : liveStatus === 'retrying'
                  ? 'Reconnecting to live updates'
                  : undefined
            }
          >
            {liveStatus === 'live' ? 'Live' : liveStatus === 'retrying' ? 'Reconnecting…' : null}
          </span>
        </>
      }
      lens={
        threadRoot ? (
          <ThreadPane
            /*
             * WCAG 2.2 2.4.3, second half. Without a key, opening thread B while thread A's pane
             * is open re-renders the *same* ThreadPane instance: the mount effect that moves focus
             * to the heading never re-runs, so focus stays on "Reply in thread" and nothing tells
             * the person the pane now holds a different thread. Keying on the root id makes each
             * open a fresh mount, so the focus move happens on every open, not only the first.
             */
            key={threadRoot.id}
            api={api}
            organizationSlug={organizationSlug}
            conversationId={conversationId}
            root={threadRoot}
            archived={archived}
            onClose={closeThread}
          />
        ) : undefined
      }
    >
      <BackendPending ticket="unscheduled APIs">
        Reactions, saved messages, quote-to-decision, pins and presence are not built — none has an
        endpoint. Live updates arrive over the socket where this deployment runs one; otherwise new
        messages appear when the channel is reloaded.
      </BackendPending>

      {conversation.isError ? (
        <InlineAlert tone="danger" title="Could not load this channel" live>
          {describeError(conversation.error)}
        </InlineAlert>
      ) : null}

      {messages.isPending ? (
        <LoadingRegion label="Loading the conversation.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {messages.isError ? (
        <InlineAlert tone="danger" title="Could not load the messages" live>
          {describeError(messages.error)}
        </InlineAlert>
      ) : null}

      {messages.hasNextPage ? (
        <InlineAlert tone="warning" title="This is not the whole transcript">
          {rows.length} messages loaded — there are more. &ldquo;Load more&rdquo; below the
          transcript continues it.
        </InlineAlert>
      ) : null}

      {!messages.isPending && !messages.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="Nothing said yet">
          The first message starts the channel&rsquo;s record. Everything said here stays with the
          project.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <ol
          className="tm-list tm-stack"
          aria-label="Messages, oldest first"
          aria-live="polite"
          aria-relevant="additions"
        >
          {rows.map((message) => (
            <li key={message.id} className="tm-panel tm-stack tm-stack--tight">
              <MessageHeader message={message} />
              <MessageBody message={message} />

              <div className="tm-row tm-row--wrap">
                <Button
                  tone="outline"
                  size="compact"
                  onClick={(event) => openThread(message.id, event.currentTarget)}
                >
                  Reply in thread
                </Button>
                {message.deletedAt === null ? (
                  <>
                    <Button
                      tone="outline"
                      size="compact"
                      onClick={() =>
                        setConvertTargetId((current) =>
                          current === message.id ? undefined : message.id,
                        )
                      }
                    >
                      Create work from this
                    </Button>
                    <Button
                      tone="outline"
                      size="compact"
                      onClick={() =>
                        setRemoveTargetId((current) =>
                          current === message.id ? undefined : message.id,
                        )
                      }
                    >
                      Remove
                    </Button>
                  </>
                ) : null}
                {message.editedAt !== null ? (
                  <Button
                    tone="outline"
                    size="compact"
                    onClick={() =>
                      setHistoryMessageId((current) =>
                        current === message.id ? undefined : message.id,
                      )
                    }
                  >
                    Edit history
                  </Button>
                ) : null}
              </div>

              {removeTargetId === message.id ? (
                <InlineAlert tone="warning" title="Remove this message?" live>
                  <p className="tm-prose">
                    The body is withheld from everyone and a tombstone stays in the transcript. The
                    record of who removed it, and when, is kept. This is moderation, not deletion.
                  </p>
                  <div className="tm-row">
                    <Button
                      tone="destructive"
                      size="accessible"
                      loading={moderate.isPending}
                      loadingLabel="Removing"
                      onClick={() => moderate.mutate(message.id)}
                    >
                      Remove it
                    </Button>
                    <Button
                      tone="outline"
                      size="accessible"
                      onClick={() => setRemoveTargetId(undefined)}
                    >
                      Leave it
                    </Button>
                  </div>
                  {moderate.isError ? (
                    <p className="tm-prose">{describeError(moderate.error)}</p>
                  ) : null}
                </InlineAlert>
              ) : null}

              {historyMessageId === message.id ? (
                <RevisionHistory
                  api={api}
                  organizationSlug={organizationSlug}
                  conversationId={conversationId}
                  messageId={message.id}
                />
              ) : null}

              {convertTargetId === message.id ? (
                <ConvertDialog
                  api={api}
                  organizationSlug={organizationSlug}
                  conversationId={conversationId}
                  message={message}
                  projectName={project.data?.name}
                  onDone={() => {
                    void queries.invalidateQueries({
                      queryKey: workItemKeys.all(organizationSlug),
                    });
                  }}
                  onClose={() => setConvertTargetId(undefined)}
                />
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {messages.hasNextPage ? (
        <div className="tm-row">
          <Button
            tone="outline"
            size="accessible"
            loading={messages.isFetchingNextPage}
            loadingLabel="Loading more"
            onClick={() => void messages.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}

      {/*
       * Only for a channel that actually loaded. A member outside the room gets the load
       * error and nothing else — a composer under a denial would be a control that cannot
       * work, and AUTH-04's e2e journey asserts its absence.
       */}
      {conversation.data !== undefined ? (
        <Composer
          api={api}
          organizationSlug={organizationSlug}
          conversationId={conversationId}
          archived={archived}
          label="Message the channel"
        />
      ) : null}
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

/** The first eight characters of an author id — see the screen comment on the directory gap. */
function shortAuthor(userId: string): string {
  return userId.slice(0, 8);
}

function MessageHeader({ message }: { message: MessageSummary }) {
  return (
    <div className="tm-row tm-row--wrap">
      <Badge mono>{shortAuthor(message.authorUserId)}</Badge>
      <span className="tm-field__hint">
        <time dateTime={message.createdAt}>{formatWhen(message.createdAt)}</time>
        {message.editedAt !== null && message.deletedAt === null ? <> · edited</> : null}
      </span>
    </div>
  );
}

function formatWhen(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    parsed,
  );
}

function MessageBody({ message }: { message: MessageSummary }) {
  if (message.deletedAt !== null) {
    return (
      <p className="tm-prose">
        <em>
          Removed by a moderator{' '}
          <time dateTime={message.deletedAt}>{formatWhen(message.deletedAt)}</time>. The record of
          the removal is kept.
        </em>
      </p>
    );
  }
  if (message.bodyRich !== null) {
    return <RichTextBody document={message.bodyRich} />;
  }
  // A plain body renders as text with its line breaks honoured — the one formatting a plain
  // message can carry.
  return <p className="tm-prose tm-break">{message.body}</p>;
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

const TOOLBAR: readonly { label: string; edit: ToolbarEdit }[] = [
  { label: 'Bold', edit: { kind: 'wrap', before: '**', after: '**' } },
  { label: 'Italic', edit: { kind: 'wrap', before: '_', after: '_' } },
  { label: 'Strikethrough', edit: { kind: 'wrap', before: '~~', after: '~~' } },
  { label: 'Code', edit: { kind: 'wrap', before: '`', after: '`' } },
  { label: 'Link', edit: { kind: 'wrap', before: '[', after: '](https://)' } },
  { label: 'Quote', edit: { kind: 'prefix', marker: '> ' } },
  { label: 'Bulleted list', edit: { kind: 'prefix', marker: '- ' } },
  { label: 'Numbered list', edit: { kind: 'prefix', marker: '1. ' } },
  { label: 'Code block', edit: { kind: 'fence' } },
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
  parentMessageId,
}: {
  api: ApiClient;
  organizationSlug: string;
  conversationId: string;
  archived: boolean;
  label: string;
  parentMessageId?: string;
}) {
  const queries = useQueryClient();
  const [draft, setDraft] = useState('');
  const [attemptId, setAttemptId] = useState<string | undefined>(undefined);
  const [inadmissible, setInadmissible] = useState<string | undefined>(undefined);
  const controlRef = useRef<HTMLTextAreaElement | null>(null);

  const composed = useMemo(
    () => (draft.trim() === '' ? undefined : composeMessage(draft)),
    [draft],
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
      void queries.invalidateQueries({ queryKey: ['messages', organizationSlug, conversationId] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
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
            : 'This message cannot be formatted as written.',
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

  if (archived) {
    return (
      <p className="tm-prose">
        This channel is archived. What was said stays readable; nothing new can be said here.
      </p>
    );
  }

  return (
    <form className="tm-panel tm-stack" onSubmit={submit}>
      <div className="tm-row tm-row--wrap" role="group" aria-label="Formatting">
        {TOOLBAR.map((tool) => (
          <Button
            key={tool.label}
            type="button"
            tone="outline"
            size="compact"
            onClick={() => applyEdit(tool.edit)}
          >
            {tool.label}
          </Button>
        ))}
      </div>

      <div className="tm-field">
        <label className="tm-field__label" htmlFor={controlId}>
          {label}
        </label>
        <textarea
          id={controlId}
          ref={controlRef}
          className="tm-field__control"
          rows={3}
          maxLength={16000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <span className="tm-field__hint">
          Formatting is written as notation — **bold**, _italic_, `code`, a &ldquo;- &rdquo; list, a
          &ldquo;&gt; &rdquo; quote — and converted before sending. The notation itself is never
          sent; the preview shows exactly what is.
        </span>
      </div>

      {composed?.kind === 'rich' ? (
        <section className="tm-panel tm-panel--quiet tm-stack tm-stack--tight" aria-label="Preview">
          <h3 className="tm-eyebrow">Preview — what will be sent</h3>
          <RichTextBody document={composed.document} />
        </section>
      ) : null}

      {inadmissible !== undefined ? (
        <InlineAlert tone="danger" title="This formatting cannot be sent" live>
          {inadmissible}
        </InlineAlert>
      ) : null}

      {send.isError ? (
        <InlineAlert tone="danger" title="Not sent" live>
          {describeError(send.error)}{' '}
          {send.error instanceof NetworkError
            ? 'Your text is still here — sending again cannot post it twice.'
            : ''}
        </InlineAlert>
      ) : null}

      <div className="tm-row tm-row--end">
        <Button
          type="submit"
          tone="ink"
          size="accessible"
          loading={send.isPending}
          loadingLabel="Sending"
          disabled={composed === undefined}
        >
          Send
        </Button>
      </div>
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
  onClose,
}: {
  api: ApiClient;
  organizationSlug: string;
  conversationId: string;
  root: MessageSummary;
  archived: boolean;
  onClose: () => void;
}) {
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

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // WCAG 2.2 2.4.3: move focus into the pane when it opens, rather than leaving the keyboard
    // user on the trigger with the pane rendered after <main> and reachable only by tabbing the
    // whole transcript. Focusing the heading also announces the pane to a screen reader.
    headingRef.current?.focus();
  }, []);

  return (
    <div className="tm-stack">
      <div className="tm-row">
        <h2 className="tm-eyebrow" tabIndex={-1} ref={headingRef}>
          Thread
        </h2>
        <span className="tm-push-end">
          <Button tone="outline" size="compact" onClick={onClose}>
            Close thread
          </Button>
        </span>
      </div>

      <div className="tm-panel tm-panel--quiet tm-stack tm-stack--tight">
        <MessageHeader message={root} />
        <MessageBody message={root} />
      </div>

      {replies.isPending ? (
        <LoadingRegion label="Loading the replies.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {replies.isError ? (
        <InlineAlert tone="danger" title="Could not load the replies" live>
          {describeError(replies.error)}
        </InlineAlert>
      ) : null}

      {replies.data && replyRows.length === 0 ? <p className="tm-prose">No replies yet.</p> : null}

      {replyRows.length > 0 ? (
        <ol
          className="tm-list tm-stack"
          aria-label="Replies, oldest first"
          aria-live="polite"
          aria-relevant="additions"
        >
          {replyRows.map((reply) => (
            <li key={reply.id} className="tm-panel tm-stack tm-stack--tight">
              <MessageHeader message={reply} />
              <MessageBody message={reply} />
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
            loadingLabel="Loading more"
            onClick={() => void replies.fetchNextPage()}
          >
            Load more replies
          </Button>
        </div>
      ) : null}

      <Composer
        api={api}
        organizationSlug={organizationSlug}
        conversationId={conversationId}
        archived={archived}
        label="Reply in this thread"
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
  const revisions = useQuery({
    queryKey: ['revisions', organizationSlug, conversationId, messageId],
    queryFn: () => listRevisions(api, organizationSlug, conversationId, messageId),
  });

  if (revisions.isPending) {
    return (
      <LoadingRegion label="Loading the edit history.">
        <Skeleton height="var(--row)" />
      </LoadingRegion>
    );
  }
  if (revisions.isError) {
    return (
      <InlineAlert tone="danger" title="Could not load the edit history" live>
        {describeError(revisions.error)}
      </InlineAlert>
    );
  }

  return (
    <section className="tm-panel tm-panel--quiet tm-stack" aria-label="Edit history">
      <h3 className="tm-eyebrow">Before it was edited</h3>
      {revisions.data.length === 0 ? (
        <p className="tm-prose">No earlier versions.</p>
      ) : (
        <ol className="tm-list tm-stack tm-stack--tight">
          {revisions.data.map((revision) => (
            <li key={revision.revisionNo} className="tm-stack tm-stack--tight">
              <span className="tm-field__hint">
                Version {revision.revisionNo}, replaced{' '}
                <time dateTime={revision.replacedAt}>{formatWhen(revision.replacedAt)}</time>
              </span>
              {revision.body === null && revision.bodyRich === null ? (
                <p className="tm-prose">
                  <em>Withheld — this message was removed by a moderator.</em>
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
 * **TM-09 Convert message dialog.** `22-SCREEN-BY-SCREEN` §4: "Type, title, project, owner,
 * due date, audience. Source preview and access warning. Defaults: internal audience; no
 * owner/date invented. Duplicate conversion shows existing link."
 *
 * The project is shown, not chosen — the API files the work on the conversation's project by
 * design, and a dialog that offered a choice it cannot honour would be a lie with a dropdown.
 * The owner is neither shown nor invented: there is no people directory to choose from, so
 * the item is created unowned, exactly as §4's "no owner/date invented" asks. The audience
 * defaults to internal and widening it warns before submit, because conversion is the moment
 * a sentence written for the room can become a sentence a client reads.
 */
function ConvertDialog({
  api,
  organizationSlug,
  conversationId,
  message,
  projectName,
  onDone,
  onClose,
}: {
  api: ApiClient;
  organizationSlug: string;
  conversationId: string;
  message: MessageSummary;
  projectName: string | undefined;
  onDone: () => void;
  onClose: () => void;
}) {
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

  if (result !== undefined) {
    return (
      <InlineAlert
        tone={result.created ? 'neutral' : 'warning'}
        title={result.created ? 'Work item created' : 'Already converted'}
        live
      >
        <p className="tm-prose">
          {result.created
            ? 'The message is now linked to the work item, and the link cannot be rewritten.'
            : 'This message was converted before. A message becomes work exactly once; here is the existing item.'}
        </p>
        <p className="tm-prose">
          <Link href={`/${organizationSlug}/work/${result.workItem.id}`}>
            {result.workItem.title}
          </Link>
        </p>
        <div className="tm-row">
          <Button tone="outline" size="accessible" onClick={onClose}>
            Close
          </Button>
        </div>
      </InlineAlert>
    );
  }

  return (
    <form
      className="tm-panel tm-panel--quiet tm-stack"
      onSubmit={submit}
      aria-label="Create work from this message"
    >
      <h3 className="tm-eyebrow">Create work from this message</h3>

      <div className="tm-stack tm-stack--tight">
        <span className="tm-field__hint">The source, as the work item will link to it:</span>
        <blockquote className="tm-prose tm-break">{message.body}</blockquote>
      </div>

      <p className="tm-prose">
        Filed on <strong>{projectName ?? 'this channel’s project'}</strong> — the channel’s project,
        not a choice. No owner is set; there is no people directory to choose one from, and a due
        date is only set if you set one.
      </p>

      <div className="tm-field">
        <label className="tm-field__label" htmlFor="tm-convert-title">
          Title
        </label>
        <input
          id="tm-convert-title"
          className="tm-field__control"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={300}
        />
        <span className="tm-field__hint">
          Defaults to the message&rsquo;s first line. If the audience is widened later, this title
          is what a client reads.
        </span>
      </div>

      <div className="tm-field">
        <label className="tm-field__label" htmlFor="tm-convert-type">
          Type
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
          Due (optional)
        </label>
        <input
          id="tm-convert-due"
          className="tm-field__control"
          value={dueAt}
          onChange={(event) => setDueAt(event.target.value)}
          placeholder="2026-09-30T17:00:00Z"
        />
        <span className="tm-field__hint">An ISO 8601 instant, or leave it empty.</span>
      </div>

      <fieldset className="tm-fieldset">
        <legend className="tm-field__label">Audience</legend>
        <div className="tm-row tm-row--wrap">
          {(['internal', 'client_visible', 'client_action_required'] as const).map((option) => (
            <label key={option} className="tm-choice tm-choice--inline">
              <input
                className="tm-choice__input"
                type="radio"
                name="tm-convert-audience"
                value={option}
                checked={audience === option}
                onChange={() => setAudience(option)}
              />
              <span className="tm-choice__name">{audienceLabel(option)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {audience !== 'internal' ? (
        <InlineAlert tone="client" title="This work item will be visible to the client" live>
          The message stays internal — a client can never read the channel — but the work item, its
          title and its state become part of the client portal the moment it is created. Check the
          title says what you mean a client to read.
        </InlineAlert>
      ) : null}

      {convert.isError ? (
        <InlineAlert tone="danger" title="Could not create the work item" live>
          {describeError(convert.error)}
          {convert.error instanceof ApiRequestError && convert.error.status === 409
            ? ' A removed message cannot become work: its content is withheld.'
            : ''}
        </InlineAlert>
      ) : null}

      <div className="tm-row">
        <Button
          type="submit"
          tone="ink"
          size="accessible"
          loading={convert.isPending}
          loadingLabel="Creating"
        >
          Create work item
        </Button>
        <Button tone="outline" size="accessible" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
