'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, Skeleton } from '@tmanage/ui';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { portalFileViewerHref } from '../screens/PortalReviewLink';
import type { ApiClient } from '../../lib/api/client';
import {
  listCloudFolderChildren,
  listCloudFolders,
  openCloudFolderFile,
  removeCloudFolder,
  type CloudFolder,
  type CloudFolderChild,
  type CloudFolderDoor,
} from '../../lib/api/cloud-folders';
import { formatBytes } from '../../lib/api/uploads';
import { useT } from '../../lib/i18n/use-t';

export const cloudFoldersKey = (organizationSlug: string, workItemId: string, door: string) =>
  ['cloud-folders', organizationSlug, workItemId, door] as const;

export interface CloudFolderListProps {
  organizationSlug: string;
  client: ApiClient;
  workItemId: string;
  /** `member` on the work item (rows look like its files), `portal` for a client. */
  door: CloudFolderDoor;
  /** Members who may update the work item see Remove. */
  canRemove?: boolean;
}

/**
 * FIX6 C3. The live drive folders on one work item. Each folder opens in place to its children,
 * read live through the server; a subfolder opens inside it, and a file opens as its checked
 * TManage copy in the normal viewer, which the server makes only once it has checked the file sits
 * inside the attached folder (and reuses while the file is unchanged).
 * Renders nothing while
 * the work item has no folder. No token, link or drive id ever reaches the browser beyond the
 * provider's item ids.
 */
export function CloudFolderList({
  organizationSlug,
  client,
  workItemId,
  door,
  canRemove = false,
}: CloudFolderListProps) {
  const t = useT();
  const queries = useQueryClient();
  const key = cloudFoldersKey(organizationSlug, workItemId, door);
  const folders = useQuery({
    queryKey: key,
    queryFn: () => listCloudFolders(client, organizationSlug, workItemId, door),
  });
  const remove = useMutation({
    mutationFn: (folderId: string) =>
      removeCloudFolder(client, organizationSlug, workItemId, folderId),
    onSettled: () => void queries.invalidateQueries({ queryKey: key }),
  });
  const [open, setOpen] = useState<string | null>(null);
  const rows = folders.data ?? [];
  if (rows.length === 0) return null;
  const portal = door === 'portal';

  return (
    <ul className={portal ? 'tm-pt-files' : 'tm-wk-files'} aria-label={t('CloudFolders.title')}>
      {rows.map((folder) => (
        <li key={folder.id} className={portal ? 'tm-pt-item' : 'tm-wk-file'}>
          <div className={portal ? 'tm-pt-item__main' : 'tm-wk-file__row'}>
            {portal ? null : <span className="tm-wk-badge">{t('CloudFolders.folderBadge')}</span>}
            <span className={portal ? 'tm-pt-item__title' : 'tm-wk-file__text'}>
              <bdi className={portal ? undefined : 'tm-wk-file__name'}>{folder.name}</bdi>
              <span className={portal ? 'tm-pt-mono' : 'tm-wk-file__meta'}>
                {' '}
                <bdi>{folder.provider === 'onedrive' ? 'OneDrive' : 'Google Drive'}</bdi>
              </span>
            </span>
            <button
              type="button"
              className={portal ? 'tm-pt-btn' : 'tm-wk-text-button'}
              aria-expanded={open === folder.id}
              onClick={() => setOpen(open === folder.id ? null : folder.id)}
            >
              {open === folder.id ? t('CloudFolders.hide') : t('CloudFolders.open')}
            </button>
            {canRemove && !portal ? (
              <button
                type="button"
                className="tm-wk-text-button"
                disabled={remove.isPending}
                onClick={() => remove.mutate(folder.id)}
                aria-label={`${t('CloudFolders.remove')} ${folder.name}`}
              >
                {t('CloudFolders.remove')}
              </button>
            ) : null}
          </div>
          {open === folder.id ? (
            <FolderChildren
              organizationSlug={organizationSlug}
              client={client}
              workItemId={workItemId}
              door={door}
              folder={folder}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function FolderChildren({
  organizationSlug,
  client,
  workItemId,
  door,
  folder,
}: {
  organizationSlug: string;
  client: ApiClient;
  workItemId: string;
  door: CloudFolderDoor;
  folder: CloudFolder;
}) {
  const t = useT();
  // The subfolders walked into, innermost last; empty = the attached folder itself.
  const [path, setPath] = useState<readonly CloudFolderChild[]>([]);
  const [pageToken, setPageToken] = useState<string | undefined>(undefined);
  const parent = path[path.length - 1];
  const page = useQuery({
    queryKey: [
      'cloud-folder-children',
      organizationSlug,
      workItemId,
      folder.id,
      parent?.id,
      pageToken,
    ],
    queryFn: () =>
      listCloudFolderChildren(client, organizationSlug, workItemId, folder.id, door, {
        ...(parent ? { parentId: parent.id } : {}),
        ...(pageToken ? { pageToken } : {}),
      }),
  });
  // C3b. A file opens as its checked TManage copy in the normal viewer (the server makes the copy,
  // or reuses it while the drive file is unchanged); the drive's bytes never reach the browser.
  const router = useRouter();
  const describe = useDescribeApiError();
  const openFile = useMutation({
    mutationFn: (childId: string) =>
      openCloudFolderFile(client, organizationSlug, workItemId, folder.id, childId, door),
    onSuccess: ({ fileId }) =>
      router.push(
        door === 'portal'
          ? portalFileViewerHref(organizationSlug, fileId)
          : `/${organizationSlug}/files/${encodeURIComponent(fileId)}`,
      ),
  });
  const portal = door === 'portal';
  const name = parent?.name ?? folder.name;
  const go = (next: readonly CloudFolderChild[]) => {
    setPath(next);
    setPageToken(undefined);
  };

  if (page.isPending) return <Skeleton height="var(--row)" />;
  if (page.isError) {
    return (
      <p className={portal ? 'tm-pt-quiet' : 'tm-field__hint'} role="status">
        {t('CloudFolders.loadError')}
      </p>
    );
  }
  const files = page.data.files;
  return (
    <div className={portal ? undefined : 'tm-wk-history'}>
      {path.length > 0 ? (
        <button
          type="button"
          className={portal ? 'tm-pt-btn' : 'tm-wk-text-button'}
          onClick={() => go(path.slice(0, -1))}
        >
          {t('CloudFolders.back')}
        </button>
      ) : null}
      {files.length === 0 ? (
        <p className={portal ? 'tm-pt-quiet' : 'tm-field__hint'}>{t('CloudFolders.empty')}</p>
      ) : (
        <ul
          className={portal ? 'tm-pt-files' : 'tm-wk-files'}
          aria-label={t('CloudFolders.listLabel').replace('{name}', name)}
        >
          {files.map((child) => (
            <li key={child.id} className={portal ? 'tm-pt-item' : 'tm-wk-file'}>
              <div className={portal ? 'tm-pt-item__main' : 'tm-wk-file__row'}>
                {portal ? <span className="tm-pt-file__icon" aria-hidden="true" /> : null}
                <span className={portal ? 'tm-pt-item__title' : 'tm-wk-file__text'}>
                  <bdi className={portal ? undefined : 'tm-wk-file__name'}>{child.name}</bdi>
                  {child.size !== null ? (
                    <span className={portal ? 'tm-pt-mono' : 'tm-wk-file__meta'} dir="ltr">
                      {' '}
                      {formatBytes(child.size)}
                    </span>
                  ) : null}
                </span>
                {child.isFolder ? (
                  <button
                    type="button"
                    className={portal ? 'tm-pt-btn' : 'tm-wk-text-button'}
                    onClick={() => go([...path, child])}
                  >
                    {t('CloudFolders.open')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={portal ? 'tm-pt-btn' : 'tm-wk-text-button'}
                    disabled={openFile.isPending}
                    onClick={() => openFile.mutate(child.id)}
                    aria-label={`${t('CloudFolders.openFile')} ${child.name}`}
                  >
                    {openFile.isPending && openFile.variables === child.id
                      ? t('CloudFolders.preparing')
                      : t('CloudFolders.openFile')}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {openFile.isError ? (
        <InlineAlert tone="danger" title={t('CloudFolders.openProblem')} live>
          {describe(openFile.error)}
        </InlineAlert>
      ) : null}
      {page.data.nextPageToken ? (
        <button
          type="button"
          className={portal ? 'tm-pt-btn' : 'tm-wk-text-button'}
          onClick={() => setPageToken(page.data.nextPageToken ?? undefined)}
        >
          {t('CloudFolders.more')}
        </button>
      ) : null}
    </div>
  );
}
