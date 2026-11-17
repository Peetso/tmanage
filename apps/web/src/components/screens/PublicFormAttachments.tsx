'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  AttachmentError,
  attachmentProblem,
  openPublicFormDraft,
  uploadPublicFormFile,
  type AttachmentProblem,
  type PublicAttachmentRule,
} from '../../lib/api/public-forms';
import { useTOr } from '../../lib/i18n/use-t-or';

/**
 * 52-20a — the attachment part of a public form (`/f/<slug>`), shown only when the form's owner
 * allows files (the definition's `attachments` rule). Files upload one at a time as soon as they
 * are chosen; the form waits until every one has finished. Removing an attached file starts a new
 * draft for the ones kept, so the submission carries exactly the files the visitor sees.
 */

type ItemState = 'queued' | 'uploading' | 'done' | 'failed';

interface Item {
  readonly id: number;
  readonly file: File;
  readonly state: ItemState;
  readonly problem?: AttachmentProblem;
}

export interface PublicFormAttachmentsState {
  readonly items: readonly Item[];
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
      setItems((current) => {
        let held = current.filter((item) => item.state !== 'failed').length;
        const added = files.map((file): Item => {
          const id = nextId.current++;
          const problem = held >= rule.maxFiles ? 'limit' : attachmentProblem(file, rule);
          if (problem !== null) return { id, file, state: 'failed', problem };
          held += 1;
          return { id, file, state: 'queued' };
        });
        return [...current, ...added];
      });
    },
    [rule],
  );

  const remove = useCallback((id: number) => {
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
    busy: items.some((item) => item.state === 'queued' || item.state === 'uploading'),
    add,
    remove,
    token: () =>
      items.some((item) => item.state === 'done') ? (tokenRef.current ?? undefined) : undefined,
    reset: () => {
      tokenRef.current = null;
      setItems([]);
    },
  };
}

const PROBLEM_TEXT: Readonly<Record<AttachmentProblem, readonly [string, string]>> = {
  too_big: ['PublicForm.attachTooBig', 'This file is over 25 MB. Choose a smaller one.'],
  wrong_type: [
    'PublicForm.attachWrongType',
    'This kind of file can’t be attached. Choose an image or a PDF.',
  ],
  limit: ['PublicForm.attachLimit', 'You can attach up to 5 files.'],
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

  return (
    <fieldset className="wf-attach">
      <legend className="wf-attach__title">
        {t('PublicForm.attachTitle', 'Files (optional)')}
      </legend>
      <p className="wf-attach__help" id="wf-attach-help">
        {t(
          'PublicForm.attachHelp',
          'You can attach images (JPG, PNG, WebP, HEIC) and PDF, up to 25 MB each, 5 files.',
        )}
      </p>
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
      <Button
        type="button"
        tone="outline"
        size="accessible"
        aria-describedby="wf-attach-help"
        disabled={full}
        onClick={() => input.current?.click()}
      >
        {t('PublicForm.attachButton', 'Attach files')}
      </Button>
      {state.items.length > 0 ? (
        <ul className="wf-attach__list" aria-live="polite">
          {state.items.map((item) => (
            <li key={item.id} className="wf-attach__item" data-state={item.state}>
              <span className="wf-attach__name">
                <bdi>{item.file.name}</bdi>
              </span>
              <span className="wf-attach__status">
                {item.state === 'failed'
                  ? t(...PROBLEM_TEXT[item.problem ?? 'failed'])
                  : item.state === 'done'
                    ? t('PublicForm.attachDone', 'Attached')
                    : t('PublicForm.attachUploading', 'Uploading…')}
              </span>
              {item.state === 'uploading' ? null : (
                <Button
                  type="button"
                  tone="text"
                  size="accessible"
                  aria-label={`${t('PublicForm.attachRemove', 'Remove')} ${item.file.name}`}
                  onClick={() => state.remove(item.id)}
                >
                  {t('PublicForm.attachRemove', 'Remove')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="wf-attach__help">
        {state.busy
          ? t(
              'PublicForm.attachWait',
              'Your files are still uploading. You can send the form when they finish.',
            )
          : t(
              'PublicForm.attachScanNote',
              'Files are checked for viruses before the team opens them.',
            )}
      </p>
    </fieldset>
  );
}
