'use client';

import { useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Avatar,
  Button,
  InlineAlert,
  LoadingRegion,
  Skeleton,
  StateCapsule,
  Switch,
} from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import {
  MAX_REQUEST_MESSAGE_FILES,
  MAX_REQUEST_MESSAGE_LENGTH,
  listPortalRequestMessages,
  listRequestMessages,
  postPortalRequestMessage,
  postRequestMessage,
  type RequestMessageClientView,
  type RequestMessageView,
} from '../../lib/api/request-messages';
import {
  ATTACHMENT_ACCEPT,
  attachmentProblem,
  uploadPortalRequestFile,
} from '../../lib/api/uploads';
import { initialsOf } from '../chat/channel-browser';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import '../../styles/screens/chat.css';
import './request-thread.css';

/** This slice's keys arrive through the i18n fragment; the cast lets them compile before merge. */
type ThreadKey = `RequestMessages.${string}`;

/** U+200F: an Arabic line that carries a Latin name starts right-to-left. */
const RLM = '‏';

export interface RequestMessageThreadProps {
  /** `team` reads the internal record and may post internal notes; `client` reads the projection. */
  side: 'team' | 'client';
  organizationSlug: string;
  clientRequestId: string;
  client: ApiClient;
  /** The studio's name, shown on studio messages. */
  studioName: string;
  /** The client organization's name, shown on client messages. */
  clientName: string;
  className?: string;
  /** The host screen's eyebrow class, so the heading matches the cards around it. */
  headingClassName?: string;
  /** Client card (A8): the project eyebrow above the title. */
  projectName?: string | undefined;
  /** Client card (A8): the request title the conversation is about. */
  requestTitle?: string;
  /** Client card (A8): the studio is waiting on the client (the request is `clarifying`). */
  waitingOnYou?: boolean;
  /** Client card (A8): the request's project — needed to upload an attachment. */
  projectId?: string;
  /** Upload one picked file and answer its file id. Defaults to the portal upload session. */
  uploadFile?: (file: File) => Promise<string>;
}

interface ThreadFile {
  readonly id: string;
  readonly name: string;
}

/** One row as the thread draws it, whichever side it came from. */
interface ThreadRow {
  readonly id: string;
  readonly author: string;
  readonly from: 'studio' | 'client';
  readonly internal: boolean;
  readonly body: string;
  readonly createdAt: string;
  readonly files: readonly ThreadFile[];
}

export function requestMessageKey(
  side: 'team' | 'client',
  organizationSlug: string,
  clientRequestId: string,
): readonly unknown[] {
  return ['request-messages', side, organizationSlug, clientRequestId];
}

/**
 * The conversation on a client request — CL-10's "Conversation with the studio" card, and the
 * same thread on the studio's triage screen. Messages oldest first, each with its author and
 * time; a composer where Enter sends and Shift+Enter breaks the line (COL-13). On the team side
 * an internal-note toggle sends `clientVisible: false`, and such a message carries a lock tag so
 * nobody mistakes it for something the client read. The client side never receives those rows.
 *
 * The client side is the A8 reply card (`fq9-portal-client-reply`): project eyebrow, "Waiting on
 * you" when the studio asked something, the request title, the messages, then "Your reply" with
 * "Attach file" (a portal upload on this request, named on the message by id) and "Send reply".
 *
 * Layout is logical (inline-start/end), so the thread mirrors under `dir="rtl"`.
 */
export function RequestMessageThread({
  side,
  organizationSlug,
  clientRequestId,
  client,
  studioName,
  clientName,
  className,
  headingClassName = 'tm-chat-eyebrow',
  projectName,
  requestTitle,
  waitingOnYou = false,
  projectId,
  uploadFile,
}: RequestMessageThreadProps) {
  const t = useT();
  const tm = (key: ThreadKey) => t(key as MessageKey);
  const locale = useActiveLocale();
  const formats = useDisplayFormatters();
  const queries = useQueryClient();
  const key = requestMessageKey(side, organizationSlug, clientRequestId);

  const [draft, setDraft] = useState('');
  const [internal, setInternal] = useState(false);
  const [attached, setAttached] = useState<readonly ThreadFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachError, setAttachError] = useState<string | undefined>(undefined);
  const picker = useRef<HTMLInputElement>(null);

  const upload =
    uploadFile ??
    (projectId
      ? (file: File) =>
          uploadPortalRequestFile(client, organizationSlug, {
            projectId,
            requestId: clientRequestId,
            file,
          })
      : undefined);

  const messages = useQuery({
    queryKey: key,
    queryFn: async (): Promise<readonly ThreadRow[]> =>
      side === 'team'
        ? (await listRequestMessages(client, organizationSlug, clientRequestId)).map((message) =>
            fromTeam(message, studioName, clientName),
          )
        : (await listPortalRequestMessages(client, organizationSlug, clientRequestId)).map(
            (message) => fromClient(message, studioName, clientName, tm('RequestMessages.you')),
          ),
  });

  const send = useMutation({
    mutationFn: async (input: {
      readonly body: string;
      readonly fileIds: readonly string[];
    }): Promise<ThreadRow> =>
      side === 'team'
        ? fromTeam(
            await postRequestMessage(client, organizationSlug, clientRequestId, {
              body: input.body,
              clientVisible: !internal,
            }),
            studioName,
            clientName,
          )
        : fromClient(
            await postPortalRequestMessage(client, organizationSlug, clientRequestId, input),
            studioName,
            clientName,
            tm('RequestMessages.you'),
          ),
    onSuccess: (row) => {
      queries.setQueryData<readonly ThreadRow[]>(key, (current) => [...(current ?? []), row]);
      setDraft('');
      setAttached([]);
    },
  });

  const body = draft.trim();
  const canSend = body !== '' && !send.isPending && !uploading;

  function sendNow() {
    if (canSend) send.mutate({ body, fileIds: attached.map((file) => file.id) });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    sendNow();
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
      sendNow();
    }
  }

  async function onPick(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!upload || picked.length === 0) return;
    setAttachError(undefined);
    const room = MAX_REQUEST_MESSAGE_FILES - attached.length;
    const problem = picked.map(attachmentProblem).find((reason) => reason !== null);
    if (problem) {
      setAttachError(problem);
      return;
    }
    setUploading(true);
    try {
      const added: ThreadFile[] = [];
      for (const file of picked.slice(0, room)) {
        added.push({ id: await upload(file), name: file.name });
      }
      setAttached((current) => [...current, ...added]);
    } catch (error) {
      setAttachError(describe(error, tm));
    } finally {
      setUploading(false);
    }
  }

  const notFound = messages.error instanceof ApiRequestError && messages.error.status === 404;
  const headingId = `tm-request-thread-${side}`;
  const composerId = `tm-request-reply-${side}`;
  const rows = messages.data ?? [];
  const isClient = side === 'client';
  const rtlPrefix = locale.startsWith('ar') ? RLM : '';

  const states = (
    <>
      {messages.isPending ? (
        <LoadingRegion label={tm('RequestMessages.loading')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {notFound ? (
        <p className="tm-prose" data-state="not-found">
          {tm('RequestMessages.notFound')}
        </p>
      ) : null}

      {messages.isError && !notFound ? (
        <InlineAlert tone="danger" title={tm('RequestMessages.loadFailed')} live>
          {describe(messages.error, tm)}
        </InlineAlert>
      ) : null}

      {messages.isSuccess && rows.length === 0 ? (
        <p className="tm-prose">
          {isClient ? tm('RequestMessages.emptyClient') : tm('RequestMessages.emptyTeam')}
        </p>
      ) : null}
    </>
  );

  const sendError = send.isError ? (
    <InlineAlert tone="danger" title={tm('RequestMessages.notSent')} live>
      {describe(send.error, tm)}
    </InlineAlert>
  ) : null;

  if (isClient) {
    return (
      <section
        className={['tm-rq-card', className].filter(Boolean).join(' ')}
        aria-labelledby={headingId}
      >
        <h2 id={headingId} className="tm-visually-hidden">
          {tm('RequestMessages.headingClient')}
        </h2>
        {projectName || waitingOnYou ? (
          <div className="tm-rq-card__top">
            <span className="tm-rq-card__project">{projectName}</span>
            {waitingOnYou ? (
              <StateCapsule state="client" className="tm-rq-card__pill">
                {tm('RequestMessages.waitingOnYou')}
              </StateCapsule>
            ) : null}
          </div>
        ) : null}
        {requestTitle ? <h3 className="tm-rq-card__title">{requestTitle}</h3> : null}

        {states}

        {rows.length > 0 ? (
          <ol
            className="tm-rq-thread"
            aria-label={tm('RequestMessages.listLabel')}
            aria-live="polite"
            aria-relevant="additions"
          >
            {rows.map((row) => (
              <li key={row.id} className="tm-rq-msg" data-from={row.from}>
                <Avatar
                  name={row.author}
                  audience={row.from === 'client' ? 'client' : 'internal'}
                  decorative
                />
                <div className="tm-rq-msg__main">
                  <div className="tm-rq-msg__head">
                    <span className="tm-rq-msg__author">
                      {rtlPrefix}
                      {row.author}
                      {row.from === 'studio' && row.author !== studioName ? ` · ${studioName}` : ''}
                    </span>
                    <time className="tm-rq-msg__time" dateTime={row.createdAt}>
                      {formats.dateTime(row.createdAt, {
                        weekday: 'short',
                        hour: 'numeric',
                        minute: '2-digit',
                        hourCycle: 'h23',
                      })}
                    </time>
                  </div>
                  <p className="tm-rq-msg__body tm-break">{row.body}</p>
                  <FileList files={row.files} label={tm('RequestMessages.attachedFiles')} />
                </div>
              </li>
            ))}
          </ol>
        ) : null}

        {notFound ? null : (
          <form noValidate className="tm-rq-reply" onSubmit={submit}>
            <label className="tm-rq-reply__label" htmlFor={composerId}>
              {tm('RequestMessages.yourReply')}
            </label>
            <textarea
              id={composerId}
              className="tm-rq-reply__input"
              rows={1}
              maxLength={MAX_REQUEST_MESSAGE_LENGTH}
              value={draft}
              placeholder={tm('RequestMessages.placeholderClient')}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
            />

            {attached.length > 0 ? (
              <ul className="tm-rq-files" aria-label={tm('RequestMessages.attachedFiles')}>
                {attached.map((file) => (
                  <li key={file.id} className="tm-rq-file">
                    <span className="tm-break">{file.name}</span>
                    <button
                      type="button"
                      className="tm-rq-file__remove"
                      aria-label={`${tm('RequestMessages.removeFilePrefix')}${file.name}`}
                      onClick={() =>
                        setAttached((current) => current.filter((entry) => entry.id !== file.id))
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {attachError ? (
              <InlineAlert tone="danger" title={tm('RequestMessages.attachFailed')} live>
                {attachError}
              </InlineAlert>
            ) : null}
            {sendError}

            <div className="tm-rq-reply__actions">
              {upload ? (
                <>
                  <input
                    ref={picker}
                    type="file"
                    multiple
                    hidden
                    accept={ATTACHMENT_ACCEPT}
                    data-testid="request-reply-file"
                    onChange={(event) => void onPick(event)}
                  />
                  <Button
                    type="button"
                    tone="outline"
                    loading={uploading}
                    loadingLabel={tm('RequestMessages.uploading')}
                    disabled={attached.length >= MAX_REQUEST_MESSAGE_FILES}
                    onClick={() => picker.current?.click()}
                  >
                    {tm('RequestMessages.attachFile')}
                  </Button>
                </>
              ) : null}
              <Button
                type="submit"
                tone="ink"
                disabled={!canSend}
                loading={send.isPending}
                loadingLabel={tm('RequestMessages.sending')}
              >
                {tm('RequestMessages.sendReply')}
              </Button>
            </div>
          </form>
        )}
      </section>
    );
  }

  return (
    <section className={className} aria-labelledby={headingId}>
      <h2 id={headingId} className={headingClassName}>
        {tm('RequestMessages.headingTeam')}
      </h2>

      {states}

      {rows.length > 0 ? (
        <ol
          className="tm-chat-transcript"
          aria-label={tm('RequestMessages.listLabel')}
          aria-live="polite"
          aria-relevant="additions"
        >
          {rows.map((row) => (
            <li key={row.id} className="tm-chat-message" data-from={row.from}>
              <span className="tm-chat-orb" aria-hidden="true">
                {initialsOf(row.author)}
              </span>
              <div className="tm-chat-message__main">
                <div className="tm-chat-message__head">
                  <span className="tm-chat-message__author">{row.author}</span>
                  <span className="tm-chat-mono">
                    {row.from === 'studio' ? studioName : clientName} ·{' '}
                    <time dateTime={row.createdAt}>
                      {formats.dateTime(row.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
                    </time>
                  </span>
                  {row.internal ? (
                    <span className="tm-chat-tag">
                      <LockMark />
                      {tm('RequestMessages.internalNote')}
                    </span>
                  ) : null}
                </div>
                <p className="tm-chat-message__body tm-break">{row.body}</p>
                <FileList files={row.files} label={tm('RequestMessages.attachedFiles')} />
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {notFound ? null : (
        <form noValidate className="tm-chat-composer" onSubmit={submit}>
          <label className="tm-visually-hidden" htmlFor={composerId}>
            {tm('RequestMessages.composerLabel')}
          </label>
          <textarea
            id={composerId}
            className="tm-chat-composer__input"
            rows={2}
            maxLength={MAX_REQUEST_MESSAGE_LENGTH}
            value={draft}
            placeholder={tm('RequestMessages.placeholderTeam')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />

          {sendError}

          <div className="tm-chat-composer__bar">
            <Switch
              label={tm('RequestMessages.internalToggle')}
              checked={internal}
              onChange={(event) => setInternal(event.target.checked)}
            />
            <span className="tm-chat-mono">
              {internal ? (
                <>
                  <LockMark />
                  {tm('RequestMessages.teamOnly')}
                </>
              ) : (
                <>{tm('RequestMessages.clientVisible')}</>
              )}
            </span>
            <button
              type="submit"
              className="tm-chat-send"
              disabled={!canSend}
              aria-busy={send.isPending}
            >
              <span className="tm-chat-send__orb" aria-hidden="true">
                ↑
              </span>
              {send.isPending ? tm('RequestMessages.sending') : tm('RequestMessages.send')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** The files a message carries, as name chips (both sides). */
function FileList({ files, label }: { files: readonly ThreadFile[]; label: string }) {
  if (files.length === 0) return null;
  return (
    <ul className="tm-rq-files" aria-label={label}>
      {files.map((file) => (
        <li key={file.id} className="tm-rq-file">
          <span className="tm-break">{file.name}</span>
        </li>
      ))}
    </ul>
  );
}

/** A small padlock, drawn inline so it takes the text colour and needs no icon font. */
function LockMark() {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      style={{ marginInlineEnd: 4, verticalAlign: '-1px' }}
    >
      <rect x="1.5" y="4.5" width="7" height="5" rx="1" fill="currentColor" />
      <path d="M3 4.5V3a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function fromTeam(message: RequestMessageView, studioName: string, clientName: string): ThreadRow {
  const from = message.authorKind === 'internal' ? 'studio' : 'client';
  return {
    id: message.id,
    author: message.authorName ?? (from === 'studio' ? studioName : clientName),
    from,
    internal: !message.clientVisible,
    body: message.body,
    createdAt: message.createdAt,
    files: message.files ?? [],
  };
}

function fromClient(
  message: RequestMessageClientView,
  studioName: string,
  clientName: string,
  you: string,
): ThreadRow {
  return {
    id: message.id,
    author:
      message.authorName ??
      (message.mine ? you : message.from === 'studio' ? studioName : clientName),
    from: message.from,
    internal: false,
    body: message.body,
    createdAt: message.createdAt,
    files: message.files ?? [],
  };
}

function describe(error: unknown, tm: (key: ThreadKey) => string): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return tm('RequestMessages.noAnswer');
  if (error instanceof Error && error.message !== '') return error.message;
  return tm('RequestMessages.genericError');
}
