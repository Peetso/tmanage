'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import type { ReviewAudience, ReviewMentionCandidate } from '../../lib/api/review';
import { useT } from '../../lib/i18n/use-t';
import { MentionPicker, mentionOptionId } from './MentionPicker';
import { ViewerIcon } from './viewer-icons';

export interface ComposerSubmit {
  readonly body: string;
  readonly mentions: readonly string[];
  readonly audience: ReviewAudience;
}

export interface ThreadComposerProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly projectId: string;
  /** The label read by a screen reader and shown above the text box. */
  readonly label: string;
  readonly submitLabel: string;
  readonly pendingLabel: string;
  /** The thread's audience (a reply), or the starting choice (a new thread). */
  readonly audience: ReviewAudience;
  /** A new staff thread may choose Team only / Visible to client; replies never can. */
  readonly canChooseAudience: boolean;
  /** The text to start from (an edit). */
  readonly initialBody?: string;
  readonly pending: boolean;
  readonly error?: ReactNode;
  /** Put the caret in the text box as soon as the composer opens (popover, edit). */
  readonly focusOnOpen?: boolean;
  readonly onSubmit: (input: ComposerSubmit) => void;
  readonly onCancel?: () => void;
}

/** The "@query" being typed just before the caret, if any. */
export function mentionQueryAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]{0,30})$/u.exec(before);
  if (!match) return null;
  const query = match[1] ?? '';
  return { start: caret - query.length - 1, query };
}

/** The ids of the picked people whose "@Name" is still in the text. */
export function mentionsStillIn(body: string, picked: ReadonlyMap<string, string>): string[] {
  const ids: string[] = [];
  for (const [name, userId] of picked) {
    if (body.includes(`@${name}`) && !ids.includes(userId)) ids.push(userId);
  }
  return ids;
}

/**
 * The comment box used for a new pin / box (V-10), a reply (V-14) and an edit: a several-line text
 * box (2 px focus border), the @ button and inline @mention picker (V-15), the audience switch on
 * new staff threads ("Team only" with a lock, "Visible to client" with an eye) and Cancel / Post.
 *
 * Mentions are typed as "@Name" in the text and sent as user ids beside it. Picking a client person
 * on a new thread switches it to "Visible to client" (the API refuses a client mention on a team
 * thread). Ctrl / ⌘ + Enter posts; Escape closes the picker, then cancels.
 */
export function ThreadComposer({
  api,
  organizationSlug,
  projectId,
  label,
  submitLabel,
  pendingLabel,
  audience: initialAudience,
  canChooseAudience,
  initialBody = '',
  pending,
  error,
  focusOnOpen = false,
  onSubmit,
  onCancel,
}: ThreadComposerProps) {
  const t = useT();
  const id = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [body, setBody] = useState(initialBody);
  const [audience, setAudience] = useState<ReviewAudience>(initialAudience);
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map());
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [results, setResults] = useState<readonly ReviewMentionCandidate[]>([]);
  const [active, setActive] = useState(0);
  const listId = `${id}-mentions`;
  const textId = `${id}-text`;
  const hintId = `${id}-hint`;

  const canPost = body.trim() !== '' && !pending;

  // A composer opened by a click on the artwork (or Edit): the caret goes straight to its box.
  useEffect(() => {
    if (focusOnOpen) textRef.current?.focus();
  }, [focusOnOpen]);

  function refreshMention(text: string, caret: number) {
    const found = mentionQueryAt(text, caret);
    setMention(found);
    if (!found) setActive(0);
  }

  function pick(candidate: ReviewMentionCandidate) {
    if (!mention) return;
    const insert = `@${candidate.displayName} `;
    const end = mention.start + 1 + mention.query.length;
    const next = body.slice(0, mention.start) + insert + body.slice(end);
    setBody(next);
    setPicked((current) => new Map(current).set(candidate.displayName, candidate.userId));
    if (candidate.kind === 'client' && canChooseAudience) setAudience('client_visible');
    setMention(null);
    setActive(0);
    const caret = mention.start + insert.length;
    window.requestAnimationFrame(() => {
      textRef.current?.focus();
      textRef.current?.setSelectionRange(caret, caret);
    });
  }

  function submit() {
    if (!canPost) return;
    onSubmit({ body: body.trim(), mentions: mentionsStillIn(body, picked), audience });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention && results.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((index) => (index + 1) % results.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((index) => (index - 1 + results.length) % results.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const candidate = results[active];
        if (candidate) {
          event.preventDefault();
          pick(candidate);
          return;
        }
      }
    }
    if (event.key === 'Escape') {
      if (mention) {
        event.preventDefault();
        setMention(null);
        return;
      }
      if (onCancel) {
        event.preventDefault();
        onCancel();
      }
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  }

  const pickerOpen = mention !== null;
  // A reply on a team thread may only name the team; anything else may name the client too.
  const listAudience: ReviewAudience =
    canChooseAudience || audience === 'client_visible' ? 'client_visible' : 'internal';

  return (
    <form
      className="tm-viewer-composer"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="tm-visually-hidden" htmlFor={textId}>
        {label}
      </label>
      <div className="tm-viewer-composer__box">
        <textarea
          ref={textRef}
          id={textId}
          className="tm-viewer-composer__text"
          rows={3}
          value={body}
          placeholder={label}
          aria-describedby={hintId}
          role={pickerOpen ? 'combobox' : undefined}
          aria-expanded={pickerOpen ? true : undefined}
          aria-controls={pickerOpen ? listId : undefined}
          aria-autocomplete={pickerOpen ? 'list' : undefined}
          aria-activedescendant={
            pickerOpen && results.length > 0 ? mentionOptionId(listId, active) : undefined
          }
          onChange={(event) => {
            setBody(event.target.value);
            refreshMention(event.target.value, event.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onClick={(event) =>
            refreshMention(event.currentTarget.value, event.currentTarget.selectionStart)
          }
          onBlur={() => setMention(null)}
        />
        {pickerOpen ? (
          <MentionPicker
            api={api}
            organizationSlug={organizationSlug}
            projectId={projectId}
            query={mention.query}
            audience={listAudience}
            mentionSwitchesAudience={canChooseAudience && audience === 'internal'}
            activeIndex={active}
            listId={listId}
            onResults={setResults}
            onPick={pick}
          />
        ) : null}
      </div>

      <div className="tm-viewer-composer__row">
        <button
          type="button"
          className="tm-viewer-round tm-viewer-round--small"
          aria-label={t('Viewer.composer.mention')}
          onClick={() => {
            const text = textRef.current;
            if (!text) return;
            const caret = text.selectionStart ?? body.length;
            const needsSpace = caret > 0 && !/\s/u.test(body[caret - 1] ?? '');
            const insert = `${needsSpace ? ' ' : ''}@`;
            const next = body.slice(0, caret) + insert + body.slice(caret);
            setBody(next);
            const at = caret + insert.length;
            window.requestAnimationFrame(() => {
              text.focus();
              text.setSelectionRange(at, at);
              refreshMention(next, at);
            });
          }}
        >
          <ViewerIcon name="at" />
        </button>

        {canChooseAudience ? (
          <div
            className="tm-viewer-audience"
            role="radiogroup"
            aria-label={t('Viewer.audience.label')}
          >
            <button
              type="button"
              role="radio"
              aria-checked={audience === 'internal'}
              className="tm-viewer-audience__option"
              data-value="internal"
              onClick={() => setAudience('internal')}
            >
              <ViewerIcon name="lock" />
              {t('Viewer.audience.internal')}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={audience === 'client_visible'}
              className="tm-viewer-audience__option"
              data-value="client_visible"
              onClick={() => setAudience('client_visible')}
            >
              <ViewerIcon name="eye" />
              {t('Viewer.audience.client')}
            </button>
          </div>
        ) : null}
      </div>

      <p
        id={hintId}
        className="tm-viewer-composer__hint"
        data-audience={audience}
        aria-live="polite"
      >
        {canChooseAudience
          ? audience === 'internal'
            ? t('Viewer.audience.internalHint')
            : t('Viewer.audience.clientHint')
          : audience === 'client_visible'
            ? t('Viewer.audience.replyClientHint')
            : t('Viewer.audience.replyInternalHint')}
      </p>

      {error}

      <div className="tm-viewer-composer__actions">
        {onCancel ? (
          <Button type="button" tone="text" size="compact" onClick={onCancel}>
            {t('Viewer.composer.cancel')}
          </Button>
        ) : null}
        <Button
          type="submit"
          tone="ink"
          size="compact"
          loading={pending}
          loadingLabel={pendingLabel}
          disabled={body.trim() === ''}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
