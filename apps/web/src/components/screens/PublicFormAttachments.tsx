'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  AttachmentError,
  attachmentProblem,
  openPublicFormDraft,
  uploadPublicFormFile,
  type AttachmentProblem,
  type PublicAttachmentRule,
} from '../../lib/api/public-forms';
import { formatBytes } from '../../lib/api/uploads';
import { useTOr } from '../../lib/i18n/use-t-or';
import { withIsolates } from '../../lib/i18n/with-isolates';
import { CloseIcon } from '../ai-panel/icons';
import { FormatIcon } from '../viewer/format-icons';

/**
 * 52-20a — the attachment part of a public form (`/f/<slug>`), shown only when the form's owner
 * allows files (the definition's `attachments` rule). Files upload one at a time as soon as they
 * are chosen; the form waits until every one has finished. Removing an attached file starts a new
 * draft for the ones kept, so the submission carries exactly the files the visitor sees.
 *
 * Figma: "Intake form attachments (2026-11-17)" 673:37507 — V1 two files (673:37951), refused
 * file (673:38026), limit reached (673:38104); AR 673:38266 / 673:38341 / 673:38419.
 */

type ItemState = 'queued' | 'uploading' | 'done' | 'failed';

interface Item {
  readonly id: number;
  readonly file: File;
  readonly state: ItemState;
  readonly problem?: AttachmentProblem;
}

/** A file the browser turned away before sending it: it is named once, never listed. */
interface Refusal {
  readonly name: string;
  readonly problem: AttachmentProblem;
}

export interface PublicFormAttachmentsState {
  readonly items: readonly Item[];
  /** The last file the browser refused, until the visitor adds or removes another. */
  readonly refused: Refusal | null;
  /** True while any file is still on its way: the form must not be sent yet. */
  readonly busy: boolean;
  add(files: readonly File[]): void;
  remove(id: number): void;
  /** The draft token to send with the form, when at least one file is attached. */
  token(): string | undefined;
  reset(): void;
}

export function usePublicFormAttachments(
  api: ApiClient,
  slug: string,
  rule: PublicAttachmentRule | null,
): PublicFormAttachmentsState {
  const [items, setItems] = useState<readonly Item[]>([]);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const tokenRef = useRef<string | null>(null);
  const nextId = useRef(1);

  const set = (id: number, change: Partial<Item>) =>
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...change } : item)));

  // One upload at a time, in the order chosen.
  useEffect(() => {
    if (items.some((item) => item.state === 'uploading')) return;
    const next = items.find((item) => item.state === 'queued');
    if (!next) return;
    set(next.id, { state: 'uploading' });
    void (async () => {
      try {
        tokenRef.current ??= await openPublicFormDraft(api, slug);
        await uploadPublicFormFile(api, slug, tokenRef.current, next.file);
        set(next.id, { state: 'done' });
      } catch (error) {
        const problem = error instanceof AttachmentError ? error.problem : 'failed';
        set(next.id, { state: 'failed', problem });
      }
    })();
  }, [api, slug, items]);

  const add = useCallback(
    (files: readonly File[]) => {
      if (rule === null) return;
      let held = items.filter((item) => item.state !== 'failed').length;
      let firstRefusal: Refusal | null = null;
      const added: Item[] = [];
      for (const file of files) {
        const problem = held >= rule.maxFiles ? 'limit' : attachmentProblem(file, rule);
        if (problem !== null) {
          firstRefusal ??= { name: file.name, problem };
          continue;
        }
        held += 1;
        added.push({ id: nextId.current++, file, state: 'queued' });
      }
      setRefused(firstRefusal);
      if (added.length > 0) setItems((current) => [...current, ...added]);
    },
    [rule, items],
  );

  const remove = useCallback((id: number) => {
    setRefused(null);
    setItems((current) => {
      const removed = current.find((item) => item.id === id);
      const kept = current.filter((item) => item.id !== id);
      if (removed?.state !== 'done') return kept;
      // The removed file is already bound to this draft: start a new one for the files kept.
      tokenRef.current = null;
      return kept.map((item) => (item.state === 'done' ? { ...item, state: 'queued' } : item));
    });
  }, []);

  return {
    items,
    refused,
    busy: items.some((item) => item.state === 'queued' || item.state === 'uploading'),
    add,
    remove,
    token: () =>
      items.some((item) => item.state === 'done') ? (tokenRef.current ?? undefined) : undefined,
    reset: () => {
      tokenRef.current = null;
      setRefused(null);
      setItems([]);
    },
  };
}

const PROBLEM_TEXT: Readonly<Record<AttachmentProblem, readonly [string, string]>> = {
  too_big: ['PublicForm.attachTooBig', 'This file is over {size} — choose a smaller one.'],
  wrong_type: [
    'PublicForm.attachWrongType',
    'This file type isn’t accepted here — add an image or a PDF.',
  ],
  limit: ['PublicForm.attachLimit', 'You can add up to {count} files.'],
  unavailable: [
    'PublicForm.attachUnavailable',
    'Files can’t be attached right now. You can still send the form.',
  ],
  failed: ['PublicForm.attachFailed', 'This file didn’t upload. Remove it and try again.'],
};

export function PublicFormAttachments({
  rule,
  state,
}: {
  readonly rule: PublicAttachmentRule;
  readonly state: PublicFormAttachmentsState;
}) {
  const t = useTOr();
  const input = useRef<HTMLInputElement>(null);
  const full = state.items.filter((item) => item.state !== 'failed').length >= rule.maxFiles;
  const limits = { size: formatBytes(rule.maxBytes), count: String(rule.maxFiles) };
  const problem = (kind: AttachmentProblem) => withIsolates(t(...PROBLEM_TEXT[kind]), limits);

  const addButton = (
    <Button
      type="button"
      tone="outline"
      size="accessible"
      aria-describedby="wf-attach-hint"
      disabled={full}
      onClick={() => input.current?.click()}
    >
      {t('PublicForm.attachButton', 'Add files')}
    </Button>
  );

  return (
    <fieldset className="wf-attach">
      <legend className="wf-attach__title">
        {t('PublicForm.attachTitle', 'Attach files (optional)')}
      </legend>
      <input
        ref={input}
        className="wf-attach__input"
        type="file"
        multiple
        accept={rule.mimeTypes.join(',')}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          state.add(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      {state.items.length > 0 ? (
        <ul className="wf-attach__list" aria-live="polite">
          {state.items.map((item) => (
            <li key={item.id} className="wf-attach__item" data-state={item.state}>
              <span className="wf-attach__icon">
                <FormatIcon name="file" />
              </span>
              <span className="wf-attach__text">
                <span className="wf-attach__name">
                  <bdi>{item.file.name}</bdi>
                </span>
                <span className="wf-attach__status">
                  {item.state === 'failed' ? (
                    problem(item.problem ?? 'failed')
                  ) : (
                    <>
                      <bdi dir="ltr">{formatBytes(item.file.size)}</bdi>
                      {item.state === 'done'
                        ? null
                        : ` · ${t('PublicForm.attachUploading', 'Uploading…')}`}
                    </>
                  )}
                </span>
              </span>
              {item.state === 'uploading' ? null : (
                <button
                  type="button"
                  className="wf-attach__remove"
                  aria-label={`${t('PublicForm.attachRemove', 'Remove')} ${item.file.name}`}
                  onClick={() => state.remove(item.id)}
                >
                  <CloseIcon />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="wf-attach__notice" aria-live="polite">
        {state.refused === null ? null : (
          <InlineAlert tone="warning">
            {withIsolates(t('PublicForm.attachNotAdded', '“{name}” wasn’t added.'), {
              name: state.refused.name,
            })}{' '}
            {problem(state.refused.problem)}
          </InlineAlert>
        )}
      </div>
      {full ? (
        <>
          <p className="wf-attach__help" id="wf-attach-hint">
            {withIsolates(
              t(
                'PublicForm.attachFull',
                'You’ve added {count} files, the most for one request. Remove one to add another.',
              ),
              limits,
            )}
          </p>
          <div className="wf-attach__full">{addButton}</div>
        </>
      ) : (
        <div className="wf-attach__drop">
          {addButton}
          <p className="wf-attach__hint" id="wf-attach-hint">
            {withIsolates(
              t('PublicForm.attachHint', 'Images or PDF · up to {count} files · {size} each'),
              limits,
            )}
          </p>
        </div>
      )}
      {state.busy ? (
        <p className="wf-attach__help">
          {t(
            'PublicForm.attachWait',
            'Your files are still uploading. You can send the form when they finish.',
          )}
        </p>
      ) : null}
    </fieldset>
  );
}
