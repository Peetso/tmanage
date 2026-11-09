'use client';

import { useId, useState, type ReactNode } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { deleteFile, restoreFile } from '../../lib/api/file-delete';
import { useT } from '../../lib/i18n/use-t';
import { undoQueue, useUndo } from '../../lib/undo/use-undo';
import type { UndoQueue } from '../../lib/undo/undo-queue';
import { WorkDialogFrame } from '../work/DueDatePicker';

export interface DeleteFileDialogProps {
  readonly name: string;
  readonly deleting?: boolean;
  /** The reason the last attempt failed, already worded for a person. */
  readonly error?: string | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

/**
 * **Delete a file (FIX5 item 5, live bug B-N5).** The confirmation before a file is deleted: what
 * goes (the file, from Files and every message and work item it is attached to) and what stays
 * (the messages and docs themselves). Uses the work dialog's frame and buttons, like
 * "Delete work item".
 */
export function DeleteFileDialog({
  name,
  deleting = false,
  error = null,
  onConfirm,
  onClose,
}: DeleteFileDialogProps) {
  const t = useT();
  const titleId = useId();
  return (
    <WorkDialogFrame labelledBy={titleId} onClose={onClose}>
      <h2 id={titleId} className="tm-wk-dialog__title">
        {t('FileDelete.title').split('{name}').join(name)}
      </h2>
      <p className="tm-wk-dialog__lede">{t('FileDelete.body')}</p>
      {error ? (
        <InlineAlert tone="danger" title={t('FileDelete.failed')} live>
          {error}
        </InlineAlert>
      ) : null}
      <div className="tm-wk-dialog__actions">
        <Button tone="outline" size="accessible" onClick={onClose}>
          {t('FileDelete.cancel')}
        </Button>
        <Button
          tone="ink"
          size="accessible"
          loading={deleting}
          loadingLabel={t('FileDelete.deleting')}
          onClick={onConfirm}
        >
          {t('FileDelete.confirm')}
        </Button>
      </div>
    </WorkDialogFrame>
  );
}

export interface DeletableFileRef {
  readonly id: string;
  readonly name: string;
}

export interface UseDeleteFileOptions {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  /** The file is deleted on the server (the list refreshes, the viewer leaves). */
  readonly onDeleted?: (fileId: string) => void;
  /** Undo brought it back. */
  readonly onRestored?: (fileId: string) => void;
  readonly queue?: UndoQueue;
}

export interface UseDeleteFile {
  /** Open the confirmation for this file. */
  readonly ask: (file: DeletableFileRef) => void;
  /** The confirmation dialog while one is open; render it anywhere. */
  readonly dialog: ReactNode;
}

/**
 * Confirm → `DELETE …/files/:id` at once → an "File deleted · Undo" toast whose Undo calls
 * `POST …/files/:id/restore`. The delete is sent straight away (not held like a work item's)
 * because the API has a member-level restore for files: the file leaves everyone's Files and
 * chat at once, and Undo is a real restore.
 */
export function useDeleteFile({
  api,
  organizationSlug,
  onDeleted,
  onRestored,
  queue = undoQueue,
}: UseDeleteFileOptions): UseDeleteFile {
  const t = useT();
  const describeError = useDescribeApiError();
  const undo = useUndo(queue);
  const [target, setTarget] = useState<DeletableFileRef | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    if (!target || deleting) return;
    const file = target;
    setDeleting(true);
    setError(null);
    try {
      await deleteFile(api, organizationSlug, file.id);
    } catch (failure) {
      setDeleting(false);
      setError(describeError(failure));
      return;
    }
    setDeleting(false);
    setTarget(null);
    undo.schedule({
      key: `file:${file.id}`,
      message: t('Undo.fileDeleted'),
      // Already sent: the hold only keeps the Undo on screen.
      commit: async () => undefined,
      onUndo: () => {
        void restoreFile(api, organizationSlug, file.id).then(
          () => onRestored?.(file.id),
          () => onRestored?.(file.id),
        );
      },
    });
    onDeleted?.(file.id);
  }

  const dialog = target ? (
    <DeleteFileDialog
      name={target.name}
      deleting={deleting}
      error={error}
      onConfirm={() => void confirm()}
      onClose={() => {
        if (!deleting) setTarget(null);
      }}
    />
  ) : null;

  return {
    ask: (file) => {
      setError(null);
      setTarget(file);
    },
    dialog,
  };
}
