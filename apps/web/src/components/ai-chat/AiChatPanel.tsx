'use client';

import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, MOTION_DELAY_TOOLTIP_MS, Tooltip } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { browserApiClient } from '../../lib/api/browser-client';
import { NetworkError } from '../../lib/api/errors';
import {
  aiUnavailableReason,
  deleteAiConversation,
  getAiConversation,
  listAiConversations,
  sendChatTurn,
  undoChatTask,
  type ChatConfirmedRoute,
  type ChatTurnRequest,
} from '../../lib/api/ai-chat';
import { ApiRequestError } from '../../lib/api/errors';
import { creditsTone, fetchAiCredits, requestAiPack } from '../../lib/api/ai-credits';
import { useFormCheck } from '../../lib/forms/form-check';
import { MicButton, MicNotice } from '../voice/VoiceControls';
import { useDictation, type DictationStatus } from '../voice/useDictation';
import { AiChatTurn, type TurnActions } from './AiChatTurn';
import { AnswerReaderProvider, useAnswerReader } from './AiVoice';
import { chatReducer, EMPTY_CHAT, type ChatEntry } from './ai-chat-model';
import { BackIcon, CloseIcon, CommentIcon, PlusIcon } from './icons';
import { OwnAiPointer } from './OwnAiPointer';
import { useAiText, type AiTextKey } from './use-ai-text';
import './ai-chat.css';

export const AI_CREDITS_KEY = (slug: string) => ['ai-credits', slug] as const;
export const AI_CONVERSATIONS_KEY = (slug: string) => ['ai-conversations', slug] as const;

const EXAMPLES: readonly AiTextKey[] = [
  'AiChat.example.late',
  'AiChat.example.move',
  'AiChat.example.summary',
  'AiChat.example.log',
];

export interface AiChatPanelProps {
  readonly organizationSlug: string;
  /** `docked`: the side panel beside the app (phone: full width); `page`: the /copilot page. */
  readonly variant?: 'docked' | 'page';
  readonly onClose?: () => void;
  readonly initialQuestion?: string;
  readonly client?: ApiClient;
}

let turnCounter = 0;
const nextId = () => {
  turnCounter += 1;
  return `turn-${turnCounter}`;
};

/**
 * The TManage AI chat panel — Figma G2 (desktop 764:43272, empty 764:44007; phone 765:43701;
 * states 765:44100…765:44698; fixes 789:50184), with the estimate (G4 766:44449), the preview
 * cards (G5/G6 v2, see `AiChangeCard`) and the stop states (G7 v2 789:51792).
 *
 * One turn = one `POST …/copilot/chat`; the server decides tier, price, gates and the card, the
 * panel draws what it is sent. Answers land in a polite live region (`role="log"`); failures are
 * `role="alert"`; the composer keeps focus between turns; motion stops under reduced motion.
 */
export function AiChatPanel({
  organizationSlug,
  variant = 'docked',
  onClose,
  initialQuestion,
  client,
}: AiChatPanelProps) {
  const api = useMemo(() => client ?? browserApiClient(), [client]);
  const text = useAiText();
  const { t } = text;
  const queries = useQueryClient();
  const headingId = useId();
  const composerId = useId();
  const [state, dispatch] = useReducer(chatReducer, EMPTY_CHAT);
  const [draft, setDraft] = useState('');
  const [helpMode, setHelpMode] = useState(false);
  const [mode, setMode] = useState<'chat' | 'history'>('chat');
  const [packRequested, setPackRequested] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const logEnd = useRef<HTMLDivElement>(null);
  const check = useFormCheck();
  // Voice mode (62-16): dictation only fills the box; the member checks the words and sends.
  const dictation = useDictation({ value: draft, onChange: setDraft });
  const reader = useAnswerReader();
  const [spoken, setSpoken] = useState(false);
  const listening = dictation.status === 'listening' || dictation.status === 'processing';
  useEffect(() => {
    if (dictation.status === 'listening') setSpoken(true);
  }, [dictation.status]);

  const credits = useQuery({
    queryKey: AI_CREDITS_KEY(organizationSlug),
    queryFn: () => fetchAiCredits(api, organizationSlug),
    retry: false,
  });
  const conversations = useQuery({
    queryKey: AI_CONVERSATIONS_KEY(organizationSlug),
    queryFn: () => listAiConversations(api, organizationSlug),
    enabled: mode === 'history',
    retry: false,
  });

  const send = useCallback(
    async (request: ChatTurnRequest, echo: string | null, existingId?: string) => {
      const id = existingId ?? nextId();
      if (existingId === undefined) dispatch({ type: 'sent', id, request, echo });
      try {
        const view = await sendChatTurn(api, organizationSlug, request);
        dispatch({ type: 'answered', id, view });
        void queries.invalidateQueries({ queryKey: AI_CREDITS_KEY(organizationSlug) });
      } catch (error) {
        const unavailable = aiUnavailableReason(error);
        dispatch({
          type: 'failed',
          id,
          reason:
            unavailable !== null
              ? { unavailable }
              : error instanceof NetworkError
                ? 'offline'
                : 'error',
        });
      }
    },
    [api, organizationSlug, queries],
  );

  const ask = useCallback(
    (message: string, help: boolean) => {
      const trimmed = message.trim();
      if (trimmed === '' || state.busy) return;
      setDraft('');
      setHelpMode(false);
      void send(
        { message: trimmed, conversationId: state.conversationId, ...(help ? { help: true } : {}) },
        trimmed,
      );
    },
    [send, state.busy, state.conversationId],
  );

  // A question handed over from Search (`?q=`) is asked once, on open.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !initialQuestion) return;
    asked.current = true;
    ask(initialQuestion, false);
  }, [ask, initialQuestion]);

  // The docked panel takes focus on open (its heading), so a keyboard user lands inside it.
  useEffect(() => {
    if (variant === 'docked') heading.current?.focus();
  }, [variant]);

  // The newest turn is scrolled into view; focus stays where the member is.
  const entryCount = state.entries.length;
  useEffect(() => {
    if (entryCount > 0) logEnd.current?.scrollIntoView?.({ block: 'end' });
  }, [entryCount, state.busy]);

  const pack = useMutation({
    mutationFn: () => requestAiPack(api, organizationSlug),
    onSettled: () => {
      setPackRequested(true);
      void queries.invalidateQueries({ queryKey: AI_CREDITS_KEY(organizationSlug) });
    },
  });

  const entryById = (id: string) => state.entries.find((entry) => entry.id === id);

  const actions: TurnActions = {
    api,
    organizationSlug,
    credits: credits.data ?? null,
    busy: state.busy,
    packRequested: packRequested || credits.data?.openRequest?.status === 'open',
    onContinue: (entryId, route: ChatConfirmedRoute, readScan) => {
      const entry = entryById(entryId);
      if (!entry || entry.kind !== 'reply') return;
      dispatch({ type: 'estimate-settled', id: entryId });
      const file = entry.view.file;
      void send(
        {
          message: entry.request.message,
          confirmed: route,
          conversationId: state.conversationId,
          ...(file ? { file: { fileId: file.fileId, readScan } } : {}),
        },
        null,
      );
    },
    onSettle: (entryId) => dispatch({ type: 'estimate-settled', id: entryId }),
    onRetry: (entryId) => {
      const entry = entryById(entryId);
      if (!entry) return;
      if (entry.kind === 'failed') {
        const newId = nextId();
        dispatch({ type: 'retry', id: entryId, newId });
        void send(entry.request, null, newId);
      } else if (entry.kind === 'reply') {
        void send(entry.request, null);
      }
    },
    onCard: (entryId, phase) => dispatch({ type: 'card', id: entryId, phase }),
    onAtOnce: (entryId, phase) => dispatch({ type: 'at-once', id: entryId, phase }),
    onEdit: (message) => {
      setDraft(message);
      composer.current?.focus();
    },
    onUndoAtOnce: (entryId, taskId) => {
      dispatch({ type: 'at-once', id: entryId, phase: { kind: 'undoing' } });
      undoChatTask(api, organizationSlug, taskId).then(
        (undo) => dispatch({ type: 'at-once', id: entryId, phase: { kind: 'undone', undo } }),
        (error: unknown) =>
          dispatch({
            type: 'at-once',
            id: entryId,
            phase:
              error instanceof ApiRequestError && error.status === 409
                ? { kind: 'undo_refused' }
                : { kind: 'done' },
          }),
      );
    },
    onRequestPack: () => pack.mutate(),
  };

  async function openConversation(id: string) {
    try {
      const detail = await getAiConversation(api, organizationSlug, id);
      dispatch({ type: 'loaded', conversationId: id, messages: detail.messages });
      setMode('chat');
      composer.current?.focus();
    } catch {
      void conversations.refetch();
    }
  }

  async function removeConversation(id: string) {
    try {
      await deleteAiConversation(api, organizationSlug, id);
    } finally {
      if (state.conversationId === id) dispatch({ type: 'reset' });
      void conversations.refetch();
    }
  }

  function newChat() {
    reader.stop();
    dispatch({ type: 'reset' });
    setMode('chat');
    setDraft('');
    composer.current?.focus();
  }

  function submitDraft() {
    // Words still arriving are never sent: the member stops, checks them, then sends.
    if (listening) return;
    setSpoken(false);
    ask(draft, helpMode);
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitDraft();
    }
  }

  function onPanelKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && variant === 'docked' && onClose) {
      event.stopPropagation();
      onClose();
    }
  }

  const meter = credits.data;
  const total = meter ? meter.allowanceCredits + meter.packCreditsThisMonth : 0;
  const used = meter ? Math.min(meter.usedCredits, total) : 0;

  return (
    <AnswerReaderProvider value={reader}>
      {/* The panel listens for Escape on its own subtree so a docked panel closes like a dialog. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <aside
        className="tm-aic"
        data-variant={variant}
        aria-labelledby={headingId}
        onKeyDown={onPanelKey}
      >
        <header className="tm-aic__header">
          <div className="tm-aic__title-row">
            {mode === 'history' ? (
              <button
                type="button"
                className="tm-aic__icon tm-aic__back"
                aria-label={t('AiChat.backToChat')}
                onClick={() => setMode('chat')}
              >
                <BackIcon />
              </button>
            ) : null}
            <h2 id={headingId} ref={heading} tabIndex={-1} className="tm-aic__title">
              {mode === 'history' ? t('AiChat.history') : t('AiChat.title')}
            </h2>
            {mode === 'chat' ? <Badge>{t('AiChat.testing')}</Badge> : null}
            <span className="tm-aic__spacer" />
            {mode === 'chat' ? (
              // Figma 789:50401: the icon stays; its name shows on a delayed hover and on focus.
              <Tooltip
                content={t('AiChat.history')}
                delayMs={MOTION_DELAY_TOOLTIP_MS}
                placement="bottom"
              >
                <button
                  type="button"
                  className="tm-aic__icon"
                  aria-label={t('AiChat.history')}
                  onClick={() => setMode('history')}
                >
                  <CommentIcon />
                </button>
              </Tooltip>
            ) : null}
            <Tooltip
              content={t('AiChat.newChat')}
              delayMs={MOTION_DELAY_TOOLTIP_MS}
              placement="bottom"
            >
              <button
                type="button"
                className="tm-aic__icon"
                aria-label={t('AiChat.newChat')}
                onClick={newChat}
              >
                <PlusIcon />
              </button>
            </Tooltip>
            {onClose ? (
              <button
                type="button"
                className="tm-aic__icon"
                aria-label={t('AiChat.close')}
                onClick={onClose}
              >
                <CloseIcon />
              </button>
            ) : null}
          </div>
          {meter ? (
            <div className="tm-aic__meter">
              <div
                className="tm-aic-meter"
                role="meter"
                aria-label={t('AiChat.meterLabel')}
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={used}
                aria-valuetext={t('AiChat.meter', {
                  used: text.number(used),
                  total: text.number(total),
                  date: text.day(meter.resetsOn),
                })}
                data-tone={creditsTone(used, total)}
              >
                <span style={{ inlineSize: `${total > 0 ? (used / total) * 100 : 100}%` }} />
              </div>
              <p className="tm-aic__meter-text" aria-hidden="true">
                {t('AiChat.meter', {
                  used: text.number(used),
                  total: text.number(total),
                  date: text.day(meter.resetsOn),
                })}
              </p>
            </div>
          ) : null}
        </header>

        {mode === 'history' ? (
          <HistoryList
            loading={conversations.isPending}
            failed={conversations.isError}
            items={conversations.data?.items ?? []}
            retentionDays={conversations.data?.retentionDays ?? null}
            onOpen={(id) => void openConversation(id)}
            onDelete={(id) => void removeConversation(id)}
            onRetry={() => void conversations.refetch()}
          />
        ) : (
          <div className="tm-aic__body">
            {state.entries.length === 0 ? (
              <EmptyState
                organizationSlug={organizationSlug}
                onExample={(key) => ask(t(key), false)}
                onHelp={() => {
                  setHelpMode(true);
                  composer.current?.focus();
                }}
              />
            ) : null}
            <div
              className="tm-aic__log"
              role="log"
              aria-live="polite"
              aria-relevant="additions text"
            >
              {state.entries.map((entry: ChatEntry) => (
                <AiChatTurn key={entry.id} entry={entry} actions={actions} />
              ))}
              <div ref={logEnd} />
            </div>
          </div>
        )}

        {mode === 'chat' ? (
          <form noValidate className="tm-aic__composer" {...check.handlers(submitDraft)}>
            {helpMode ? (
              <p className="tm-aic-note">
                {t('AiChat.helpMode')}{' '}
                <button type="button" className="tm-aic-link" onClick={() => setHelpMode(false)}>
                  {t('AiChat.helpModeOff')}
                </button>
              </p>
            ) : null}
            <div className="tm-aic__box">
              <label htmlFor={composerId} className="tm-visually-hidden">
                {t('AiChat.messageLabel')}
              </label>
              <textarea
                id={composerId}
                ref={composer}
                name="message"
                rows={1}
                maxLength={4000}
                className="tm-aic__input"
                dir="auto"
                placeholder={helpMode ? t('AiChat.helpPlaceholder') : t('AiChat.placeholder')}
                value={draft}
                onChange={(event) => {
                  setDraft(event.currentTarget.value);
                  if (event.currentTarget.value === '') setSpoken(false);
                }}
                onKeyDown={onComposerKey}
              />
              <MicButton dictation={dictation} compact />
              <Button
                type="submit"
                size="compact"
                className="tm-aic-touch"
                disabled={draft.trim() === '' || state.busy || listening}
              >
                {t('AiChat.send')}
              </Button>
            </div>
            <VoiceHint
              supported={dictation.supported}
              status={dictation.status}
              checking={spoken && draft.trim() !== ''}
              empty={draft.trim() === ''}
              reading={reader.readingId !== null}
              onCancel={() => {
                dictation.cancel();
                setSpoken(false);
                composer.current?.focus();
              }}
            />
            {dictation.status === 'blocked' ||
            dictation.status === 'failed' ||
            dictation.status === 'no-microphone' ? (
              <MicNotice dictation={dictation} />
            ) : null}
          </form>
        ) : null}
      </aside>
    </AnswerReaderProvider>
  );
}

/**
 * The line under the box in voice mode (Figma G3 766:43968): how to talk, "Listening…" with
 * Cancel, "check the words, then send", or that this browser has no voice. While an answer is
 * read aloud, and once the box holds typed words, it is the trust line.
 */
function VoiceHint({
  supported,
  status,
  checking,
  empty,
  reading,
  onCancel,
}: {
  readonly supported: boolean;
  readonly status: DictationStatus;
  readonly checking: boolean;
  readonly empty: boolean;
  readonly reading: boolean;
  readonly onCancel: () => void;
}) {
  const { t } = useAiText();
  if (status === 'listening' || status === 'processing') {
    return (
      <div className="tm-aic-voice">
        <p className="tm-aic__trust" role="status">
          {t(status === 'listening' ? 'AiChat.voice.listening' : 'AiChat.voice.processing')}
        </p>
        {status === 'listening' ? (
          <Button
            type="button"
            tone="text"
            size="compact"
            className="tm-aic-touch"
            onClick={onCancel}
          >
            {t('AiChat.voice.cancel')}
          </Button>
        ) : null}
      </div>
    );
  }
  if (!reading && checking) {
    return (
      <p className="tm-aic__trust" role="status">
        {t('AiChat.voice.check')}
      </p>
    );
  }
  if (!reading && empty) {
    return (
      <p className="tm-aic__trust">
        {t(supported ? 'AiChat.voice.idle' : 'AiChat.voice.unavailable')}
      </p>
    );
  }
  return <p className="tm-aic__trust">{t('AiChat.trust')}</p>;
}

function EmptyState({
  organizationSlug,
  onExample,
  onHelp,
}: {
  readonly organizationSlug: string;
  readonly onExample: (key: AiTextKey) => void;
  readonly onHelp: () => void;
}) {
  const { t } = useAiText();
  return (
    <div className="tm-aic-empty">
      <h3 className="tm-aic-empty__title">{t('AiChat.emptyTitle')}</h3>
      <p className="tm-aic-empty__body">{t('AiChat.emptyBody')}</p>
      <p className="tm-aic-empty__try">{t('AiChat.tryOne')}</p>
      <ul className="tm-aic-empty__examples">
        {EXAMPLES.map((key) => (
          <li key={key}>
            <button type="button" className="tm-aic-example" onClick={() => onExample(key)}>
              <span>{t(key)}</span>
              <span className="tm-aic-example__arrow" aria-hidden="true">
                →
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="tm-aic-help">
        <CommentIcon />
        <div className="tm-aic-help__text">
          <p className="tm-aic-help__title">{t('AiChat.helpTitle')}</p>
          <p className="tm-aic-note">{t('AiChat.helpBody')}</p>
        </div>
        <Button tone="outline" size="compact" className="tm-aic-touch" onClick={onHelp}>
          {t('AiChat.askHow')}
        </Button>
      </div>
      {/* AI-TWO-WAYS: with TManage AI open, the top-bar button no longer offers the member's own
          AI, so the other direction is named here. */}
      <OwnAiPointer organizationSlug={organizationSlug} />
    </div>
  );
}

function HistoryList({
  loading,
  failed,
  items,
  retentionDays,
  onOpen,
  onDelete,
  onRetry,
}: {
  readonly loading: boolean;
  readonly failed: boolean;
  readonly items: readonly { id: string; title: string; lastMessageAt: string }[];
  readonly retentionDays: number | null;
  readonly onOpen: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onRetry: () => void;
}) {
  const text = useAiText();
  const { t } = text;
  if (loading) {
    return (
      <div className="tm-aic__body">
        <p className="tm-aic-reading" role="status">
          {t('AiChat.historyLoading')}
        </p>
      </div>
    );
  }
  if (failed) {
    return (
      <div className="tm-aic__body">
        <InlineAlert tone="danger" live>
          {t('AiChat.historyFailed')}
        </InlineAlert>
        <div className="tm-aic-actions">
          <Button tone="outline" size="compact" className="tm-aic-touch" onClick={onRetry}>
            {t('AiChat.tryAgain')}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="tm-aic__body">
      {retentionDays !== null ? (
        <p className="tm-aic-note">
          {t('AiChat.historyNote', { days: text.number(retentionDays) })}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="tm-aic-empty__body">{t('AiChat.historyEmpty')}</p>
      ) : (
        <ul className="tm-aic-history">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="tm-aic-history__open"
                onClick={() => onOpen(item.id)}
              >
                <span className="tm-aic-history__title" dir="auto">
                  {item.title}
                </span>
                <span className="tm-aic-note">{text.day(item.lastMessageAt)}</span>
              </button>
              <Button
                tone="text"
                size="compact"
                className="tm-aic-touch"
                aria-label={t('AiChat.deleteConversation', { title: item.title })}
                onClick={() => onDelete(item.id)}
              >
                {t('AiChat.delete')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
