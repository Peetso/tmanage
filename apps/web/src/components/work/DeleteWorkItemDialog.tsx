'use client';

import { useId } from 'react';
import { Button } from '@tmanage/ui';
import { useA6T, WorkDialogFrame } from './DueDatePicker';

export interface DeleteWorkItemDialogProps {
  readonly title: string;
  /** How many files are attached — they move to Trash with the item. */
  readonly fileCount: number;
  /** Shown only for an item the client can see: who loses it from their portal. */
  readonly clientName?: string;
  readonly clientVisible: boolean;
  readonly deleting?: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

/**
 * **Delete work item (A6, Figma fq7-delete-confirm).**
 *
 * What goes with it (the checklist, comments and files, to Trash for 30 days), and — only when
 * the client can see the item — an amber line saying the client will no longer see it in the
 * portal. An internal item has no such line, because nothing changes for the client.
 */
export function DeleteWorkItemDialog({
  title,
  fileCount,
  clientName,
  clientVisible,
  deleting = false,
  onConfirm,
  onClose,
}: DeleteWorkItemDialogProps) {
  const t = useA6T();
  const titleId = useId();
  return (
    <WorkDialogFrame labelledBy={titleId} onClose={onClose}>
      <h2 id={titleId} className="tm-wk-dialog__title">
        {t('DeleteWorkItem.title', { title })}
      </h2>
      <p className="tm-wk-dialog__lede">
        {fileCount === 1
          ? t('DeleteWorkItem.bodyOne')
          : t('DeleteWorkItem.body', { count: fileCount })}
      </p>
      {clientVisible ? (
        <p className="tm-wk-note" data-tone="warning" role="note">
          <span className="tm-wk-note__mark" aria-hidden="true">
            !
          </span>
          {t('DeleteWorkItem.clientNote', { client: clientName ?? t('WorkA6.theClient') })}
        </p>
      ) : null}
      <div className="tm-wk-dialog__actions">
        <Button tone="outline" size="accessible" onClick={onClose}>
          {t('WorkA6.cancel')}
        </Button>
        <Button
          tone="ink"
          size="accessible"
          loading={deleting}
          loadingLabel={t('DeleteWorkItem.deleting')}
          onClick={onConfirm}
        >
          {t('DeleteWorkItem.confirm')}
        </Button>
      </div>
    </WorkDialogFrame>
  );
}
