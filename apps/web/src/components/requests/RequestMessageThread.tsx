'use client';

import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, Switch } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import {
  MAX_REQUEST_MESSAGE_LENGTH,
  listPortalRequestMessages,
  listRequestMessages,
  postPortalRequestMessage,
  postRequestMessage,
  type RequestMessageClientView,
  type RequestMessageView,
} from '../../lib/api/request-messages';
import { initialsOf } from '../chat/channel-browser';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import '../../styles/screens/chat.css';

/** This slice's keys arrive through the i18n fragment; the cast lets them compile before merge. */
type ThreadKey = `RequestMessages.${string}`;

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
}

/** One row as the thread draws it, whichever side it came from. */
interface ThreadRow {
  readonly id: string;
  readonly author: string;
  readonly from: 'studio' | 'client';
  readonly internal: boolean;
  readonly body: string;
  readonly createdAt: string;
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
}: RequestMessageThreadProps) {
  const t = useT();
  const tm = (key: ThreadKey) => t(key as MessageKey);
  const formats = useDisplayFormatters();
  const queries = useQueryClient();
  const key = requestMessageKey(side, organizationSlug, clientRequestId);

  const [draft, setDraft] = useState('');
  const [internal, setInternal] = useState(false);

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
    mutationFn: async (body: string): Promise<ThreadRow> =>
      side === 'team'
        ? fromTeam(
            await postRequestMessage(client, organizationSlug, clientRequestId, {
              body,
              clientVisible: !internal,
            }),
            studioName,
            clientName,
          )
        : fromClient(
            await postPortalRequestMessage(client, organizationSlug, clientRequestId, { body }),
            studioName,
            clientName,
            tm('RequestMessages.you'),
          ),
    onSuccess: (row) => {
      queries.setQueryData<readonly ThreadRow[]>(key, (current) => [...(current ?? []), row]);
      setDraft('');
    },
  });

  const body = draft.trim();
  const canSend = body !== '' && !send.isPending;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSend) send.mutate(body);
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
      if (canSend) send.mutate(body);
    }
  }

  const notFound = messages.error instanceof ApiRequestError && messages.error.status === 404;
  const headingId = `tm-request-thread-${side}`;
  const composerId = `tm-request-reply-${side}`;
  const rows = messages.data ?? [];

  return (
    <section className={className} aria-labelledby={headingId}>
      <h2 id={headingId} className={headingClassName}>
        {side === 'team' ? tm('RequestMessages.headingTeam') : tm('RequestMessages.headingClient')}
      </h2>

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
          {side === 'team' ? tm('RequestMessages.emptyTeam') : tm('RequestMessages.emptyClient')}
        </p>
      ) : null}

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
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {notFound ? null : (
        <form className="tm-chat-composer" onSubmit={submit}>
          <label className="tm-visually-hidden" htmlFor={composerId}>
            {tm('RequestMessages.composerLabel')}
          </label>
          <textarea
            id={composerId}
            className="tm-chat-composer__input"
            rows={2}
            maxLength={MAX_REQUEST_MESSAGE_LENGTH}
            value={draft}
            placeholder={
              side === 'team'
                ? tm('RequestMessages.placeholderTeam')
                : tm('RequestMessages.placeholderClient')
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />

          {send.isError ? (
            <InlineAlert tone="danger" title={tm('RequestMessages.notSent')} live>
              {describe(send.error, tm)}
            </InlineAlert>
          ) : null}

          <div className="tm-chat-composer__bar">
            {side === 'team' ? (
              <Switch
                label={tm('RequestMessages.internalToggle')}
                checked={internal}
                onChange={(event) => setInternal(event.target.checked)}
              />
            ) : null}
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
    author: from === 'studio' ? studioName : clientName,
    from,
    internal: !message.clientVisible,
    body: message.body,
    createdAt: message.createdAt,
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
    author: message.mine ? you : message.from === 'studio' ? studioName : clientName,
    from: message.from,
    internal: false,
    body: message.body,
    createdAt: message.createdAt,
  };
}

function describe(error: unknown, tm: (key: ThreadKey) => string): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return tm('RequestMessages.noAnswer');
  return tm('RequestMessages.genericError');
}
