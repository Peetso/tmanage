'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, Skeleton } from '@tmanage/ui';
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
import type { ConvertMessageResult, MessageSummary } from '../../lib/api/conversations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { audienceLabel } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';

export interface ProjectChannelScreenProps {
  organizationSlug: string;
  organizationName: string;
  conversationId: string;
  client?: ApiClient;
}

type WorkAudience = 'internal' | 'client_visible' | 'client_action_required';

/**
 * **TM-06 Project channel**, with **TM-08's thread pane** as the detail lens and **TM-09's
 * convert dialog** inline under its message. WEB-003's first half.
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
}: ProjectChannelScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const [threadRootId, setThreadRootId] = useState<string | undefined>(undefined);
  const [convertTargetId, setConvertTargetId] = useState<string | undefined>(undefined);
  const [historyMessageId, setHistoryMessageId] = useState<string | undefined>(undefined);
  const [removeTargetId, setRemoveTargetId] = useState<string | undefined>(undefined);

  const conversation = useQuery({
    queryKey: ['conversation', organizationSlug, conversationId],
    queryFn: () => getConversation(api, organizationSlug, conversationId),
  });

  const project = useQuery({
    queryKey: ['project', organizationSlug, conversation.data?.projectId],
    queryFn: () => getProject(api, organizationSlug, conversation.data?.projectId ?? ''),
    enabled: conversation.data !== undefined,
  });

  const messages = useQuery({
    queryKey: ['messages', organizationSlug, conversationId, 'channel'],
    queryFn: () => listMessages(api, organizationSlug, conversationId, { limit: MAX_MESSAGE_PAGE }),
  });

  const moderate = useMutation({
    mutationFn: (messageId: string) =>
      moderateMessage(api, organizationSlug, conversationId, messageId),
    onSuccess: () => {
      setRemoveTargetId(undefined);
      void queries.invalidateQueries({ queryKey: ['messages', organizationSlug, conversationId] });
    },
  });

  const rows = messages.data ?? [];
  const threadRoot = rows.find((message) => message.id === threadRootId);
  const archived = conversation.data?.archivedAt != null;

  return (
    <AppShell
      organizationName={organizationName}
      activeNavigationId="chat"
      title={conversation.data === undefined ? 'Channel' : `#${conversation.data.name}`}
      description={
        <>
          <Link href={`/${organizationSlug}/chat`}>Back to all channels</Link>
          {project.data ? <> · {project.data.name}</> : null}
          {archived ? <> · Archived</> : null}
        </>
      }
      lens={
        threadRoot ? (
          <ThreadPane
            api={api}
            organizationSlug={organizationSlug}
            conversationId={conversationId}
            root={threadRoot}
            archived={archived}
            onClose={() => setThreadRootId(undefined)}
          />
        ) : undefined
      }
    >
      <BackendPending ticket="WEB-003 second half · unscheduled APIs">
        Reactions, saved messages, quote-to-decision, pins, presence and live updates are not built
        — none has an endpoint. New messages appear when the channel is reloaded. The rich-text
        composer is also second-half work: rich messages sent by the API render here, but this
        composer sends plain text.
      </BackendPending>

      {conversation.isError ? (
        <InlineAlert tone="danger" title="Could not load this channel" live>
          {describeError(conversation.error)}
        </InlineAlert>
      ) : null}

      {messages.isPending ? (
        <div aria-busy="true" aria-live="polite">
          <span className="tm-visually-hidden">Loading the conversation.</span>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </div>
      ) : null}

      {messages.isError ? (
        <InlineAlert tone="danger" title="Could not load the messages" live>
          {describeError(messages.error)}
        </InlineAlert>
      ) : null}

      {rows.length >= MAX_MESSAGE_PAGE ? (
        <InlineAlert tone="warning" title="This is not the whole transcript">
          The API returns at most {MAX_MESSAGE_PAGE} messages in one page and it returned a full
          one. Paging back through history is the second half of this screen.
        </InlineAlert>
      ) : null}

      {!messages.isPending && !messages.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="Nothing said yet">
          The first message starts the channel&rsquo;s record. Everything said here stays with the
          project.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <ol className="tm-list tm-stack" aria-label="Messages, oldest first">
          {rows.map((message) => (
            <li key={message.id} className="tm-panel tm-stack tm-stack--tight">
              <MessageHeader message={message} />
              <MessageBody message={message} />

              <div className="tm-row tm-row--wrap">
                <Button tone="outline" size="compact" onClick={() => setThreadRootId(message.id)}>
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
                      queryKey: ['work-items', organizationSlug],
                    });
                  }}
                  onClose={() => setConvertTargetId(undefined)}
                />
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      <Composer
        api={api}
        organizationSlug={organizationSlug}
        conversationId={conversationId}
        archived={archived}
        label="Message the channel"
      />
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
 * The composer, used by the channel and by the thread pane. One component so the dedupe
 * behaviour — mint the id when a send starts, keep it until that send succeeds — cannot
 * drift between the two.
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

  const send = useMutation({
    mutationFn: (input: { body: string; clientGeneratedId: string }) =>
      postMessage(api, organizationSlug, conversationId, {
        body: input.body,
        clientGeneratedId: input.clientGeneratedId,
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
    const body = draft.trim();
    if (body === '' || send.isPending) return;
    // Reuse the attempt id when this is a retry of a failed send; mint one otherwise.
    const clientGeneratedId = attemptId ?? newCorrelationId();
    setAttemptId(clientGeneratedId);
    send.mutate({ body, clientGeneratedId });
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
      <div className="tm-field">
        <label className="tm-field__label" htmlFor={controlId}>
          {label}
        </label>
        <textarea
          id={controlId}
          className="tm-field__control"
          rows={3}
          maxLength={16000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </div>

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
          disabled={draft.trim() === ''}
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
  const replies = useQuery({
    queryKey: ['messages', organizationSlug, conversationId, 'thread', root.id],
    queryFn: () =>
      listMessages(api, organizationSlug, conversationId, {
        parentMessageId: root.id,
        limit: MAX_MESSAGE_PAGE,
      }),
  });

  return (
    <div className="tm-stack">
      <div className="tm-row">
        <h2 className="tm-eyebrow">Thread</h2>
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
        <div aria-busy="true" aria-live="polite">
          <span className="tm-visually-hidden">Loading the replies.</span>
          <Skeleton height="var(--row)" />
        </div>
      ) : null}

      {replies.isError ? (
        <InlineAlert tone="danger" title="Could not load the replies" live>
          {describeError(replies.error)}
        </InlineAlert>
      ) : null}

      {replies.data && replies.data.length === 0 ? (
        <p className="tm-prose">No replies yet.</p>
      ) : null}

      {replies.data && replies.data.length > 0 ? (
        <ol className="tm-list tm-stack" aria-label="Replies, oldest first">
          {replies.data.map((reply) => (
            <li key={reply.id} className="tm-panel tm-stack tm-stack--tight">
              <MessageHeader message={reply} />
              <MessageBody message={reply} />
            </li>
          ))}
        </ol>
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
      <div aria-busy="true" aria-live="polite">
        <span className="tm-visually-hidden">Loading the edit history.</span>
        <Skeleton height="var(--row)" />
      </div>
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
