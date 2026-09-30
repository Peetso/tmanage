'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createFileFolder,
  deleteFileFolder,
  listFileFolders,
  type FileFolder,
} from '../../lib/api/file-folders';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface FileFoldersViewProps {
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  projectName: string;
  client?: ApiClient;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

/**
 * **x332 — file folders.** (Files module.)
 *
 * The organisational grouping the audit found missing: the Files module stored assets but gave no
 * way to group them. This view owns a project's folder tree — list the folders, create a new one, and
 * delete an empty one; moving a file into a folder (the move control on a file row) is done through
 * the `moveFileToFolder` client call on the files surface. Create and delete are gated on the server
 * by `file.upload` and listing by `file.download`, the same doors the upload and download surfaces
 * use, so a member without the capability sees the API's refusal rather than a blank page. Deleting a
 * non-empty folder is refused (409); the tree only ever removes empty containers.
 */
export function FileFoldersView({
  organizationSlug,
  organizationName,
  projectId,
  projectName,
  client,
}: FileFoldersViewProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const queryKey = ['file-folders', organizationSlug, projectId] as const;

  const [name, setName] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const folders = useQuery({
    queryKey,
    queryFn: () => listFileFolders(api, organizationSlug, projectId),
  });

  const create = useMutation({
    mutationFn: () => createFileFolder(api, organizationSlug, projectId, { name: name.trim() }),
    onSuccess: async () => {
      setName('');
      setFailure(undefined);
      await queries.invalidateQueries({ queryKey });
    },
    onError: (error) => setFailure(describe(error)),
  });

  const remove = useMutation({
    mutationFn: (folder: FileFolder) =>
      deleteFileFolder(api, organizationSlug, projectId, folder.id),
    onSuccess: async () => {
      setFailure(undefined);
      await queries.invalidateQueries({ queryKey });
    },
    onError: (error) => setFailure(describe(error)),
  });

  const rows = folders.data ?? [];
  const canCreate = name.trim() !== '' && !create.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Folders"
      description={`Group ${projectName}'s files into named folders. Moving no bytes — a folder is an overlay.`}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-file-folder-new-heading">
        <h2 id="tm-file-folder-new-heading" className="tm-eyebrow">
          New folder
        </h2>
        <form
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <Field
            label="Name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint="A short handle, such as Contracts or Final deliverables."
            required
          />

          {failure ? (
            <InlineAlert tone="danger" title="Could not update the folder" live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={create.isPending}
              loadingLabel="Saving"
              disabled={!canCreate}
            >
              Create folder
            </Button>
          </div>
        </form>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-file-folder-list-heading">
        <h2 id="tm-file-folder-list-heading" className="tm-eyebrow">
          Folders
        </h2>
        {folders.isPending ? (
          <LoadingRegion label="Loading this project’s folders.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {folders.isError ? (
          <InlineAlert tone="danger" title="Could not load the folders" live>
            {describe(folders.error)}
          </InlineAlert>
        ) : null}

        {folders.data ? (
          rows.length === 0 ? (
            <p className="tm-prose">No folders yet.</p>
          ) : (
            <ul className="tm-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {rows.map((folder) => (
                <li key={folder.id} className="tm-row tm-row--between">
                  <span className="tm-badge">{folder.name}</span>
                  <Button
                    type="button"
                    tone="text"
                    size="accessible"
                    loading={remove.isPending}
                    loadingLabel="Removing"
                    onClick={() => remove.mutate(folder)}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </AppShell>
  );
}
