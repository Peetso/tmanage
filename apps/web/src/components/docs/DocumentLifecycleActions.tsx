'use client';

import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { hasCapability, isInternalRole } from '@tmanage/domain';
import { Button, InlineAlert } from '@tmanage/ui';
import { WorkDialogFrame } from '../work/DueDatePicker';
import { useOrganizationSummary } from '../projects/NewProjectLink';
import { deleteDocument, setDocumentArchived } from '../../lib/api/documents';
import type { DocumentView } from '../../lib/api/documents';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useTOr } from '../../lib/i18n/use-t-or';

export interface DocumentLifecycleActionsProps {
  readonly organizationSlug: string;
  readonly client: ApiClient;
  readonly document: DocumentView;
}

/**
 * **Archive and delete a doc (FIX3 item 6, live check a6f66e47 D4).**
 *
 * Archive takes the doc out of the Docs lists (it waits under Docs → Archived and still opens from
 * a link); "Bring back" undoes it. Delete asks first, then removes the doc for everyone; TManage
 * support can restore it for 30 days. The same pattern as deleting a work item: a confirm dialog
 * that says what happens, then the page leaves the deleted thing.
 *
 * Delete shows only to a role whose ceiling holds `doc.delete`; archive to anyone who may write
 * docs. The API decides either way (`doc.write` / `doc.delete`, then the project relation check).
 */
export function DocumentLifecycleActions({
  organizationSlug,
  client,
  document,
}: DocumentLifecycleActionsProps) {
  const tOr = useTOr();
  const describeError = useDescribeApiError();
  const queries = useQueryClient();
  const role = useOrganizationSummary(organizationSlug, client)?.role;
  const internal = role !== undefined && isInternalRole(role);
  const canWrite = internal && hasCapability(role, 'doc.write');
  const canDelete = internal && hasCapability(role, 'doc.delete');
  const [confirming, setConfirming] = useState(false);
  const titleId = useId();
  const archived = document.archivedAt !== undefined;

  const refreshLists = () =>
    queries.invalidateQueries({ queryKey: ['recent-documents', organizationSlug] });

  const archive = useMutation({
    mutationFn: () => setDocumentArchived(client, organizationSlug, document.id, !archived),
    onSuccess: (next) => {
      queries.setQueryData(['document', organizationSlug, document.id], next);
      void refreshLists();
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteDocument(client, organizationSlug, document.id),
    onSuccess: () => {
      setConfirming(false);
      void refreshLists();
      // A full navigation, so no screen keeps the deleted doc in its cache.
      window.location.assign(`/${organizationSlug}/docs`);
    },
  });

  if (!canWrite && !canDelete) return null;

  return (
    <>
      {canWrite ? (
        <Button
          tone="outline"
          loading={archive.isPending}
          title={
            archived
              ? tOr('DocLifecycle.unarchiveHelp', 'Put this doc back in the Docs lists.')
              : tOr(
                  'DocLifecycle.archiveHelp',
                  'Take this doc out of the Docs lists. It waits under Archived and still opens from a link.',
                )
          }
          onClick={() => archive.mutate()}
        >
          {archived
            ? tOr('DocLifecycle.unarchive', 'Bring back')
            : tOr('DocLifecycle.archive', 'Archive')}
        </Button>
      ) : null}
      {canDelete ? (
        <Button tone="outline" onClick={() => setConfirming(true)}>
          {tOr('DocLifecycle.delete', 'Delete')}
        </Button>
      ) : null}
      {archive.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('DocLifecycle.archiveFailed', 'The doc was not archived')}
          live
        >
          {describeError(archive.error)}
        </InlineAlert>
      ) : null}
      {confirming ? (
        <WorkDialogFrame labelledBy={titleId} onClose={() => setConfirming(false)}>
          <h2 id={titleId} className="tm-wk-dialog__title">
            {tOr('DocLifecycle.deleteTitle', 'Delete “{title}”?').replace(
              '{title}',
              document.title,
            )}
          </h2>
          <p className="tm-wk-dialog__lede">
            {tOr(
              'DocLifecycle.deleteBody',
              'The doc, its versions and comments leave TManage for everyone. TManage support can restore it for 30 days. To only hide it, archive it instead.',
            )}
          </p>
          {remove.isError ? (
            <InlineAlert
              tone="danger"
              title={tOr('DocLifecycle.deleteFailed', 'The doc was not deleted')}
              live
            >
              {describeError(remove.error)}
            </InlineAlert>
          ) : null}
          <div className="tm-wk-dialog__actions">
            <Button tone="outline" size="accessible" onClick={() => setConfirming(false)}>
              {tOr('DocLifecycle.cancel', 'Cancel')}
            </Button>
            <Button
              tone="ink"
              size="accessible"
              loading={remove.isPending}
              loadingLabel={tOr('DocLifecycle.deleting', 'Deleting…')}
              onClick={() => remove.mutate()}
            >
              {tOr('DocLifecycle.deleteConfirm', 'Delete doc')}
            </Button>
          </div>
        </WorkDialogFrame>
      ) : null}
    </>
  );
}
