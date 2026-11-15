'use client';

import { useId, useState } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { deleteDeliverable, restoreDeliverable } from '../../lib/api/deliverables';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useTOr } from '../../lib/i18n/use-t-or';
import { undoQueue, useUndo } from '../../lib/undo/use-undo';
import type { UndoQueue } from '../../lib/undo/undo-queue';
import { WorkDialogFrame } from '../work/DueDatePicker';
import { HelpTip } from '../help/HelpTip';

export interface DeleteDeliverableProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly deliverable: { readonly id: string; readonly title: string };
  /** Deleted on the server: the caller leaves the page and refreshes its lists. */
  readonly onDeleted: () => void;
  /** Undo brought it back. */
  readonly onRestored: () => void;
  readonly queue?: UndoQueue;
}

/**
 * **Delete a deliverable (FIX6 item 8, live UX test 69836a13 O-P1-9).** The files pattern: a
 * confirmation that says what happens, the delete sent at once, and a "Deliverable deleted · Undo"
 * toast whose Undo restores it. The API allows the owner or a project manager and never a
 * deliverable the client approved; the caller hides the button for an approved one.
 */
export function DeleteDeliverable({
  api,
  organizationSlug,
  deliverable,
  onDeleted,
  onRestored,
  queue = undoQueue,
}: DeleteDeliverableProps) {
  const tOr = useTOr();
  const titleId = useId();
  const describe = useDescribeApiError();
  const undo = useUndo(queue);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteDeliverable(api, organizationSlug, deliverable.id);
    } catch (failure) {
      setDeleting(false);
      setError(describe(failure));
      return;
    }
    setDeleting(false);
    setOpen(false);
    undo.schedule({
      key: `deliverable:${deliverable.id}`,
      message: tOr('DeliverableDelete.toast', 'Deliverable deleted'),
      // Already sent: the hold only keeps the Undo on screen.
      commit: async () => undefined,
      onUndo: () => {
        void restoreDeliverable(api, organizationSlug, deliverable.id).then(onRestored, onRestored);
      },
    });
    onDeleted();
  }

  return (
    <>
      <HelpTip
        tip={tOr(
          'DeliverableDelete.tip',
          'Delete this deliverable if it was made by mistake. It leaves the client portal too. You can undo it.',
        )}
      >
        <button
          type="button"
          className="tm-button tm-button--outline tm-button--compact"
          onClick={() => setOpen(true)}
        >
          {tOr('DeliverableDelete.action', 'Delete')}
        </button>
      </HelpTip>
      {open ? (
        <WorkDialogFrame
          labelledBy={titleId}
          onClose={() => {
            if (!deleting) setOpen(false);
          }}
        >
          <h2 id={titleId} className="tm-wk-dialog__title">
            {tOr('DeliverableDelete.title', 'Delete “{name}”?')
              .split('{name}')
              .join(deliverable.title)}
          </h2>
          <p className="tm-wk-dialog__lede">
            {tOr(
              'DeliverableDelete.body',
              'It leaves the deliverables list, and your client no longer sees it in the portal. Its files stay in Files. You can undo this for a few seconds.',
            )}
          </p>
          {error ? (
            <InlineAlert tone="danger" title={tOr('DeliverableDelete.failed', 'Not deleted')} live>
              {error}
            </InlineAlert>
          ) : null}
          <div className="tm-wk-dialog__actions">
            <Button tone="outline" size="accessible" onClick={() => setOpen(false)}>
              {tOr('DeliverableDelete.cancel', 'Cancel')}
            </Button>
            <Button
              tone="destructive"
              size="accessible"
              loading={deleting}
              loadingLabel={tOr('DeliverableDelete.deleting', 'Deleting…')}
              onClick={() => void confirm()}
            >
              {tOr('DeliverableDelete.confirm', 'Delete deliverable')}
            </Button>
          </div>
        </WorkDialogFrame>
      ) : null}
    </>
  );
}
