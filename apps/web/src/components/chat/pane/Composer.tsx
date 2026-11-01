'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { InadmissibleRichTextError, sanitizeRichText } from '@tmanage/domain';
import { InlineAlert } from '@tmanage/ui';
import {
  MentionButton,
  MentionPicker,
  useMentionComposer,
  type MentionGroup,
} from '../MentionPicker';
import { RichTextBody } from '../../RichTextBody';
import { PhoneIcon } from '../../icons/phone';
import { newCorrelationId } from '../../../lib/api/client';
import type { ApiClient } from '../../../lib/api/client';
import { clearDraft, getDraft, postMessage, saveDraft } from '../../../lib/api/conversations';
import type { MessageSummary, PostMessageInput, ReplyMeta } from '../../../lib/api/conversations';
import { ApiRequestError, NetworkError } from '../../../lib/api/errors';
import { composeMessage } from '../../../lib/rich-composer';
import type { MessageKey } from '../../../lib/i18n/t';
import { useT } from '../../../lib/i18n/use-t';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { useDictation } from '../../voice/useDictation';
import { MicButton, MicNotice } from '../../voice/VoiceControls';
import { EmojiPicker } from './EmojiPicker';
import { ReplyQuote } from './ReplyQuote';
import './pane.css';

type Translate = ReturnType<typeof useT>;

function describeError(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('ProjectChannelScreen.apiError');
  return t('ProjectChannelScreen.genericError');
}

/** R7 slice 4: the message a reply quotes, with its author's display name. */
export interface ComposerReplyTarget {
  readonly message: MessageSummary;
  readonly authorName: string;
}

/** The quote facts a reply carries (the API caps the excerpt at 280 characters). */
export function replyMetaFor(target: MessageSummary): ReplyMeta {
  const excerpt = (target.body ?? '').replace(/\s+/gu, ' ').trim().slice(0, 280);
  return { replyToMessageId: target.id, authorUserId: target.authorUserId, excerpt };
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
export function Composer({
  api,
  organizationSlug,
  conversationId,
  archived,
  label,
  placeholder,
  parentMessageId,
  mentions,
  replyTo,
  onCancelReply,
  extras = false,
  voice,
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
  /** R7 slice 4: the message being quoted; the next send carries `meta` with the reply. */
  replyTo?: ComposerReplyTarget;
  onCancelReply?: () => void;
  /** R7 slice 4: emoji and location buttons on the channel composer. */
  extras?: boolean;
  /** R7 slice 4: slice 5's voice-note recorder, beside Send. */
  voice?: ReactNode;
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
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [locationError, setLocationError] = useState(false);
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
  // 2026-10-31 live-test fix: a send clears the stored draft itself, at once. The emptied box then
  // must not fire a second, debounced DELETE for the same draft — two DELETEs back to back is what
  // the live test saw answered 503 by the host under load.
  const clearedOnSendRef = useRef(false);

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
    if (draft !== '') clearedOnSendRef.current = false;
    else if (clearedOnSendRef.current) {
      clearedOnSendRef.current = false;
      return;
    }
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
        ...(replyTo === undefined || input.kind !== undefined
          ? {}
          : { meta: { ...replyMetaFor(replyTo.message) } }),
      }),
    onSuccess: () => {
      onCancelReply?.();
      if (persistDraft) clearedOnSendRef.current = true;
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

  function insertEmoji(emoji: string) {
    const control = controlRef.current;
    const start = control?.selectionStart ?? draft.length;
    const end = control?.selectionEnd ?? draft.length;
    setDraft(`${draft.slice(0, start)}${emoji}${draft.slice(end)}`.slice(0, 16000));
    setEmojiOpen(false);
    control?.focus();
  }

  /** R7 slice 4: the browser's position, posted as `kind='location'` (coordinates + OSM link). */
  function shareLocation() {
    setLocationError(false);
    if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
      setLocationError(true);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = Number(position.coords.latitude.toFixed(6));
        const lng = Number(position.coords.longitude.toFixed(6));
        const label = tOr('ChatMessages.myLocation', 'My location');
        send.mutate({
          kind: 'location',
          body: `${label}: ${lat}, ${lng}`,
          meta: { lat, lng, label },
          clientGeneratedId: newCorrelationId(),
        });
      },
      () => setLocationError(true),
      { enableHighAccuracy: false, timeout: 10_000 },
    );
  }

  const extraButtons = extras ? (
    <span className="tm-pane-composer-extras">
      <button
        type="button"
        className="tm-chat-side__round"
        aria-label={tOr('ChatMessages.emoji', 'Emoji')}
        title={tOr('ChatMessages.emoji', 'Emoji')}
        aria-expanded={emojiOpen}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setEmojiOpen((open) => !open)}
      >
        <span aria-hidden="true">☺</span>
      </button>
      <button
        type="button"
        className="tm-chat-side__round"
        aria-label={tOr('ChatMessages.shareLocation', 'Share location')}
        title={tOr('ChatMessages.shareLocation', 'Share location')}
        onClick={shareLocation}
      >
        <span aria-hidden="true">📍</span>
      </button>
      {emojiOpen ? (
        <EmojiPicker mode="insert" onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />
      ) : null}
    </span>
  ) : null;

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
      {replyTo !== undefined ? (
        <div className="tm-pane-reply-bar">
          <ReplyQuote
            authorName={replyTo.authorName}
            excerpt={replyMetaFor(replyTo.message).excerpt}
          />
          <button
            type="button"
            className="tm-chat-side__round"
            aria-label={tOr('ChatMessages.cancelReply', 'Cancel reply')}
            onClick={() => {
              onCancelReply?.();
              controlRef.current?.focus();
            }}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ) : null}
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
          query={mention.query}
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

      {locationError ? (
        <InlineAlert
          tone="warning"
          title={tOr('ChatMessages.locationUnavailable', 'Location is not available')}
          live
        >
          {tOr(
            'ChatMessages.locationHelp',
            'Allow location access in the browser, then try again.',
          )}
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
          {extraButtons}
          <span className="tm-chat-composer__spacer" aria-hidden="true" />
          {voice}
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
            <PhoneIcon name="send" className="tm-phone-chat__send-icon" />
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
