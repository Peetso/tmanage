'use client';

import { useRef, useState, type FormEvent } from 'react';
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
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useUndo } from '../../lib/undo/use-undo';
import { undoKey } from '../../lib/undo/undo-queue';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface FileFoldersViewProps {
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  projectName: string;
  client?: ApiClient;
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
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
  const tOr = useTOr();
  const undo = useUndo();
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

  // 55-23: a folder whose delete is held behind an Undo toast is already gone from the list.
  const rows = (folders.data ?? []).filter(
    (folder) => !undo.isPending(undoKey('file-folder', folder.id)),
  );
  const canCreate = name.trim() !== '' && !create.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={t('FileFoldersView.title')}
      description={`${t('FileFoldersView.descPrefix')} ${projectName}${t('FileFoldersView.descSuffix')}`}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-file-folder-new-heading">
        <h2 id="tm-file-folder-new-heading" className="tm-eyebrow">
          {t('FileFoldersView.newFolder')}
        </h2>
        <form
          ref={firstStep}
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <Field
            label={t('FileFoldersView.name')}
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint={t('FileFoldersView.nameHint')}
            required
          />

          {failure ? (
            <InlineAlert tone="danger" title={t('FileFoldersView.saveError')} live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={create.isPending}
              loadingLabel={t('FileFoldersView.saving')}
              disabled={!canCreate}
            >
              {t('FileFoldersView.createFolder')}
            </Button>
          </div>
        </form>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-file-folder-list-heading">
        <h2 id="tm-file-folder-list-heading" className="tm-eyebrow">
          {t('FileFoldersView.foldersHeading')}
        </h2>
        {folders.isPending ? (
          <LoadingRegion label={t('FileFoldersView.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {folders.isError ? (
          <InlineAlert tone="danger" title={t('FileFoldersView.loadError')} live>
            {describe(folders.error)}
          </InlineAlert>
        ) : null}

        {folders.data ? (
          rows.length === 0 ? (
            <TeachingEmptyState
              title={t('teachEmpty.fileFoldersTitle')}
              explanation={t('teachEmpty.fileFoldersBody')}
              action={
                canUse('file.upload') ? (
                  <Button
                    tone="lime"
                    size="accessible"
                    onClick={() => focusFirstField(firstStep.current)}
                  >
                    {t('teachEmpty.fileFoldersAction')}
                  </Button>
                ) : undefined
              }
              helpSlug="upload-and-share-files"
              helpLabel={t('EmptyStates.howFilesWork')}
            />
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
                    loadingLabel={t('FileFoldersView.removing')}
                    onClick={() =>
                      undo.schedule({
                        key: undoKey('file-folder', folder.id),
                        message: tOr('Undo.folderDeleted', 'Folder deleted'),
                        commit: () => remove.mutateAsync(folder),
                      })
                    }
                  >
                    {t('FileFoldersView.delete')}
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
