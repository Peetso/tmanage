'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  attachWorkItemFile,
  detachWorkItemFile,
  listWorkItemFiles,
  type ItemFile,
} from '../../lib/api/work-items';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface WorkItemFilesScreenProps {
  organizationSlug: string;
  organizationName: string;
  workItemId: string;
  client?: ApiClient;
}

/**
 * **Work item file attachments (x205).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Work. The join the audit found missing: Work is built,
 * Files are built, and nothing linked them. This screen lists the files attached to one work item,
 * attaches an already-uploaded file by its id, and detaches one.
 *
 * ## What it does, and what it cannot
 *
 * - **No bytes move here.** A file is uploaded through the existing file flow; this only records
 *   that an already-uploaded file of the same project is attached to this work item. The picker
 *   takes the file's id.
 * - **A link is attached and detached, never edited.** Correcting an attachment is detach-and-
 *   reattach; the API ships no editor, so this screen offers none.
 */
export function WorkItemFilesScreen({
  organizationSlug,
  organizationName,
  workItemId,
  client,
}: WorkItemFilesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['work-item-files', organizationSlug, workItemId];

  const files = useQuery({
    queryKey,
    queryFn: () => listWorkItemFiles(api, organizationSlug, workItemId),
  });

  const [fileAssetId, setFileAssetId] = useState('');

  const attach = useMutation({
    mutationFn: () =>
      attachWorkItemFile(api, organizationSlug, workItemId, { fileAssetId: fileAssetId.trim() }),
    onSuccess: async () => {
      setFileAssetId('');
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const detach = useMutation({
    mutationFn: (linkId: string) => detachWorkItemFile(api, organizationSlug, workItemId, linkId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const rows = files.data ?? [];
  const canAttach = fileAssetId.trim() !== '' && !attach.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Attached files"
      description="Files attached to this work item. Attach an already-uploaded file of this project by its id, or detach one."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-attach-new-heading">
        <h2 id="tm-attach-new-heading" className="tm-eyebrow">
          Attach a file
        </h2>
        <form
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canAttach) attach.mutate();
          }}
        >
          <Field
            label="File ID"
            name="fileAssetId"
            value={fileAssetId}
            onChange={(event) => setFileAssetId(event.target.value)}
            hint="The id of an already-uploaded file. It must belong to this work item's project."
            required
          />

          {attach.isError ? (
            <InlineAlert tone="danger" title="Could not attach the file" live>
              {describeError(attach.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={attach.isPending}
              loadingLabel="Attaching"
              disabled={!canAttach}
            >
              Attach file
            </Button>
          </div>
        </form>
      </section>

      <section
        className="tm-panel tm-panel--quiet tm-stack"
        aria-labelledby="tm-attach-list-heading"
      >
        <h2 id="tm-attach-list-heading" className="tm-eyebrow">
          Attachments
        </h2>

        {files.isError ? (
          <InlineAlert tone="danger" title="Could not load the attachments" live>
            {describeError(files.error)}
          </InlineAlert>
        ) : null}

        {detach.isError ? (
          <InlineAlert tone="danger" title="Could not detach the file" live>
            {describeError(detach.error)}
          </InlineAlert>
        ) : null}

        {files.isPending ? (
          <LoadingRegion label="Loading the attachments.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!files.isPending && !files.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No files attached yet">
            Attach a file above by its id. Each attachment links an already-uploaded file to this
            work item.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
            // (WCAG 2.2 2.1.1), matching the other screens' tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Attached files"
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                Files attached to this work item, {rows.length} shown, oldest first.
              </caption>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Attached</th>
                  <th scope="col">
                    <span className="tm-visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((file: ItemFile) => (
                  <tr key={file.id}>
                    <th scope="row" className="tm-table__title">
                      {file.fileName}
                    </th>
                    <td>{file.createdAt}</td>
                    <td>
                      <Button
                        type="button"
                        tone="destructive"
                        size="compact"
                        loading={detach.isPending && detach.variables === file.id}
                        loadingLabel="Detaching"
                        onClick={() => detach.mutate(file.id)}
                      >
                        Detach
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
