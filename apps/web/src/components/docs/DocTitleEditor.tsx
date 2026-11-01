'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, Toast, ToastRegion } from '@tmanage/ui';
import { getDocument, renameDocument, type DocumentView } from '../../lib/api/documents';
import { listMembers } from '../../lib/api/members';
import { ApiRequestError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { rtlLine } from './doc-markdown';
import './doc-title-editor.css';

/** What the editor's top bar shows while a rename is in flight. */
export type RenameStatus = 'idle' | 'saving' | 'saved' | 'conflict';

export interface DocTitleEditorProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly document: DocumentView;
  /** The top bar's save state: "Saving…", "Saved · just now" or "Not saved". */
  readonly onStatus: (status: RenameStatus) => void;
}

interface Conflict {
  /** The document as the other writer left it. */
  readonly latest: DocumentView;
  readonly renamedBy: string | null;
}

/**
 * **F2 — rename a doc in the editor** (Figma section 390:20145).
 *
 * 1. The title is a button: on hover a "Click to rename" tip and the sunken surface (390:20147).
 * 2. A click turns it into the title field with the focus border and the hint "Press Enter to save
 *    or Esc to cancel" (390:20262). Esc returns to state 1 with the old name.
 * 3. Enter sends `PATCH …/documents/:id` (B4) and the bar shows the spinner and "Saving…".
 * 4. Saved: the bar says "Saved · just now", the docs column shows the new name and a success toast
 *    offers Undo (390:20491).
 * 5. A 409 because somebody else renamed it: the warning names them and their title, with
 *    "Keep my name" and "Use “…”", and the bar says "Not saved" (390:20610). A 409 caused only by
 *    a body save (the title is still the one this person started from) is retried on the fresh
 *    version without asking — there is nothing to choose between.
 */
export function DocTitleEditor({ api, organizationSlug, document, onStatus }: DocTitleEditorProps) {
  const queryClient = useQueryClient();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(document.title);
  // The title as it was when editing began — the name a conflict is measured against.
  const [baseline, setBaseline] = useState(document.title);
  const [pending, setPending] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<{ readonly title: string; readonly previous: string } | null>(
    null,
  );

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Live test 2026-10-31: the "Doc renamed" toast stayed for over a minute. It leaves after six
  // seconds, long enough to reach Undo.
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  // Enter and Esc already decided; the blur that follows them must not decide again.
  const settledRef = useRef(false);

  const documentKey = ['document', organizationSlug, document.id];

  async function publish(next: DocumentView) {
    queryClient.setQueryData(documentKey, next);
    await queryClient.invalidateQueries({ queryKey: ['recent-documents', organizationSlug] });
  }

  async function nameOf(userId: string | undefined): Promise<string | null> {
    if (!userId) return null;
    try {
      const { members } = await listMembers(api, organizationSlug, { limit: 200 });
      return members.find((member) => member.userId === userId)?.displayName ?? null;
    } catch {
      return null;
    }
  }

  async function send(title: string, expectedUpdatedAt: string, from: string, retry = true) {
    setPending(title);
    setFailure(null);
    onStatus('saving');
    try {
      const saved = await renameDocument(api, organizationSlug, document.id, {
        title,
        expectedUpdatedAt,
      });
      await publish(saved);
      setConflict(null);
      setEditing(false);
      setPending(null);
      setToast(saved.title === from ? null : { title: saved.title, previous: from });
      onStatus('saved');
    } catch (error) {
      setPending(null);
      if (error instanceof ApiRequestError && error.status === 409) {
        const latest = await getDocument(api, organizationSlug, document.id).catch(() => null);
        if (latest && latest.title === from && retry) {
          // Only the body moved on (an autosave): rename on the fresh version.
          await send(title, latest.updatedAt, from, false);
          return;
        }
        if (latest) {
          await publish(latest);
          setConflict({ latest, renamedBy: await nameOf(latest.titleUpdatedByUserId) });
          setEditing(true);
          onStatus('conflict');
          return;
        }
      }
      setEditing(true);
      setFailure(error instanceof ApiRequestError ? error.message : null);
      onStatus('idle');
    }
  }

  function begin() {
    settledRef.current = false;
    setValue(document.title);
    setBaseline(document.title);
    setConflict(null);
    setFailure(null);
    setToast(null);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setConflict(null);
    setFailure(null);
    setValue(document.title);
    onStatus('idle');
  }

  function submit() {
    const title = value.trim();
    if (title === '' || title === document.title) {
      cancel();
      return;
    }
    void send(title, document.updatedAt, baseline);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      settledRef.current = true;
      submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      settledRef.current = true;
      cancel();
    }
  }

  /**
   * Live test 2026-10-31: clicking away from the title neither saved nor cancelled. Leaving the
   * field now saves a changed name (as Notion and Slack do) and quietly closes an unchanged one.
   * A conflict waits for its two buttons instead, and a save already in flight is not repeated.
   */
  function onBlur() {
    if (settledRef.current || conflict || pending !== null) return;
    settledRef.current = true;
    submit();
  }

  function keepMine() {
    if (!conflict) return;
    const title = value.trim() === '' ? baseline : value.trim();
    void send(title, conflict.latest.updatedAt, conflict.latest.title, false);
  }

  function chooseTheirs() {
    setConflict(null);
    setEditing(false);
    setValue(document.title);
    onStatus('idle');
  }

  function undo() {
    if (!toast) return;
    const previous = toast.previous;
    setToast(null);
    void send(previous, document.updatedAt, document.title);
  }

  const quote = (text: string) => (locale.startsWith('ar') ? `«${text}»` : `“${text}”`);
  const theirs = conflict ? quote(conflict.latest.title) : '';
  const conflictLine = conflict
    ? (conflict.renamedBy
        ? tOr(
            'DocumentEditorScreen.renameConflict',
            '{name} renamed this doc to {title} a moment ago. Which name do you want to keep?',
          ).replace('{name}', conflict.renamedBy)
        : tOr(
            'DocumentEditorScreen.renameConflictSomeone',
            'Someone renamed this doc to {title} a moment ago. Which name do you want to keep?',
          )
      ).replace('{title}', theirs)
    : '';

  return (
    <>
      {editing ? (
        <div className="tm-doctitle">
          <label className="tm-visually-hidden" htmlFor="tm-doc-title-input">
            {tOr('DocumentEditorScreen.renameLabel', 'Doc name')}
          </label>
          <input
            id="tm-doc-title-input"
            ref={inputRef}
            className="tm-doctitle__input"
            value={value}
            maxLength={300}
            aria-describedby={conflict ? 'tm-doc-title-conflict' : 'tm-doc-title-hint'}
            onChange={(event) => {
              settledRef.current = false;
              setValue(event.target.value);
            }}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
          />
          {conflict ? (
            <>
              <div id="tm-doc-title-conflict" className="tm-doctitle__alert">
                <InlineAlert tone="warning" live>
                  {rtlLine(conflictLine, locale)}
                </InlineAlert>
              </div>
              <div className="tm-doctitle__choices">
                <button
                  type="button"
                  className="tm-docpage__btn"
                  data-tone="ink"
                  disabled={pending !== null}
                  onClick={keepMine}
                >
                  {tOr('DocumentEditorScreen.renameKeepMine', 'Keep my name')}
                </button>
                <button
                  type="button"
                  className="tm-docpage__btn"
                  disabled={pending !== null}
                  onClick={chooseTheirs}
                >
                  {tOr('DocumentEditorScreen.renameUseTheirs', 'Use {title}').replace(
                    '{title}',
                    theirs,
                  )}
                </button>
              </div>
            </>
          ) : (
            <p id="tm-doc-title-hint" className="tm-doctitle__hint">
              {rtlLine(
                tOr('DocumentEditorScreen.renameHint', 'Press Enter to save or Esc to cancel'),
                locale,
              )}
            </p>
          )}
          {failure !== null ? (
            <InlineAlert
              tone="danger"
              title={tOr('DocumentEditorScreen.renameError', 'Could not rename')}
              live
            >
              {failure}
            </InlineAlert>
          ) : null}
        </div>
      ) : (
        <div className="tm-doctitle__view">
          {pending === null ? (
            <span id="tm-doc-title-tip" role="tooltip" className="tm-doctitle__tip">
              {tOr('DocumentEditorScreen.renameTip', 'Click to rename')}
            </span>
          ) : null}
          <h2 id="tm-doc-title" className="tm-docpage__title tm-doctitle__heading">
            {pending !== null ? (
              pending
            ) : (
              <button
                type="button"
                className="tm-doctitle__trigger"
                aria-describedby="tm-doc-title-tip"
                onClick={begin}
              >
                {document.title}
              </button>
            )}
          </h2>
        </div>
      )}

      <ToastRegion aria-label={tOr('Shell.notifications', 'Notifications')}>
        {toast ? (
          <Toast
            tone="success"
            onDismiss={() => setToast(null)}
            dismissLabel={tOr('DocumentEditorScreen.renameToastDismiss', 'Dismiss')}
          >
            <span className="tm-doctitle__toast">
              <span>
                {tOr('DocumentEditorScreen.renameToast', 'Doc renamed to {title}').replace(
                  '{title}',
                  quote(toast.title),
                )}
              </span>
              <Button type="button" tone="text" size="compact" onClick={undo}>
                {tOr('DocumentEditorScreen.renameUndo', 'Undo')}
              </Button>
            </span>
          </Toast>
        ) : null}
      </ToastRegion>
    </>
  );
}
