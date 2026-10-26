'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, Checkbox, InlineAlert, Skeleton } from '@tmanage/ui';
import { getProjectDriveFiles, type ProjectDriveFilesView } from '../../lib/api/google-drive';
import type { ApiClient } from '../../lib/api/client';
import type { PickedDriveItem } from '../../lib/google-picker';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/storage.css';

export interface DriveProjectFilesDialogProps {
  organizationSlug: string;
  client: ApiClient;
  projectId: string;
  /** The files the person chose; the dialog closes itself through `onClose` afterwards. */
  onPick: (items: readonly PickedDriveItem[]) => void;
  onClose: () => void;
  /**
   * 0236. Another provider's listing of the same shape (OneDrive); Google Drive by default. The
   * dialog's text then comes from `lede` and `listLabel`.
   */
  loadPage?: (input: {
    readonly folderId?: string;
    readonly pageToken?: string;
  }) => Promise<ProjectDriveFilesView>;
  provider?: string;
  lede?: string;
  listLabel?: string;
}

/**
 * "Attach from Google Drive" for a project-scoped member (NV10). The company's Drive token never
 * reaches this browser: the API lists the project's own TManage folders (the project folder and
 * its work-item folders) and this dialog lets the person tick files there. The attach route still
 * checks where each file lives (V2, M04).
 */
export function DriveProjectFilesDialog({
  organizationSlug,
  client,
  projectId,
  onPick,
  onClose,
  loadPage,
  provider = 'google_drive',
  lede,
  listLabel,
}: DriveProjectFilesDialogProps) {
  const tr = useTOr();
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const [folderId, setFolderId] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<ReadonlyMap<string, string>>(new Map());

  const listing = useInfiniteQuery<ProjectDriveFilesView>({
    queryKey: ['drive-project-files', provider, organizationSlug, projectId, folderId ?? null],
    queryFn: ({ pageParam }) => {
      const input = {
        ...(folderId ? { folderId } : {}),
        ...(typeof pageParam === 'string' ? { pageToken: pageParam } : {}),
      };
      return loadPage
        ? loadPage(input)
        : getProjectDriveFiles(client, organizationSlug, projectId, input);
    },
    initialPageParam: null,
    getNextPageParam: (last) => last.nextPageToken ?? undefined,
  });

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  useEffect(() => {
    // Capture phase, so the New work sheet behind this dialog does not close on the same Escape.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  function toggle(id: string, name: string, on: boolean) {
    setSelected((current) => {
      const next = new Map(current);
      if (on) next.set(id, name);
      else next.delete(id);
      return next;
    });
  }

  function confirm() {
    onPick([...selected].map(([id, name]) => ({ id, name })));
    onClose();
  }

  const pages = listing.data?.pages ?? [];
  const folders = pages[0]?.folders ?? [];
  const current = pages[0]?.folderId ?? null;
  const files = pages.flatMap((page) => page.files).filter((file) => !file.isFolder);
  const projectLabel = tr('DriveAttach.folderProject', 'Project files');

  return (
    <div className="tm-drive-files-scrim">
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="tm-drive-files"
      >
        <h2 id={titleId} className="tm-drive-files__title">
          {tr('DriveAttach.dialogTitle', 'Attach from project files')}
        </h2>
        <p className="tm-drive-files__lede">
          {lede ??
            tr('DriveAttach.dialogLede', 'Files TManage keeps in Google Drive for this project.')}
        </p>

        {folders.length > 1 ? (
          <ul
            className="tm-drive-files__folders"
            aria-label={tr('DriveAttach.foldersLabel', 'Folders')}
          >
            {folders.map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  className="tm-chip tm-chip--compact"
                  aria-current={folder.id === current ? 'true' : undefined}
                  onClick={() => setFolderId(folder.kind === 'project' ? undefined : folder.id)}
                >
                  <bdi>{folder.kind === 'project' ? projectLabel : folder.name}</bdi>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="tm-drive-files__body" aria-busy={listing.isPending ? 'true' : undefined}>
          {listing.isPending ? (
            <>
              <span className="tm-visually-hidden">
                {tr('DriveAttach.loading', 'Loading files')}
              </span>
              <Skeleton height="20px" />
              <Skeleton height="20px" />
              <Skeleton height="20px" />
            </>
          ) : listing.isError ? (
            <InlineAlert
              tone="danger"
              title={tr('DriveAttach.failedTitle', 'Google Drive did not open')}
              live
            >
              {tr('DriveAttach.loadFailed', 'The files could not be loaded. Try again.')}
            </InlineAlert>
          ) : files.length === 0 ? (
            <p className="tm-drive-files__empty">{tr('DriveAttach.empty', 'No files here yet.')}</p>
          ) : (
            <ul
              className="tm-drive-files__list"
              aria-label={listLabel ?? tr('DriveAttach.listLabel', 'Files from Google Drive')}
            >
              {files.map((file) => (
                <li key={file.id}>
                  <Checkbox
                    label={<bdi>{file.name}</bdi>}
                    checked={selected.has(file.id)}
                    onChange={(event) => toggle(file.id, file.name, event.currentTarget.checked)}
                  />
                </li>
              ))}
            </ul>
          )}
          {listing.hasNextPage ? (
            <Button
              tone="text"
              loading={listing.isFetchingNextPage}
              loadingLabel={tr('DriveAttach.loading', 'Loading files')}
              onClick={() => void listing.fetchNextPage()}
            >
              {tr('DriveAttach.loadMore', 'Show more')}
            </Button>
          ) : null}
        </div>

        <div className="tm-drive-files__actions">
          <Button tone="outline" onClick={onClose}>
            {tr('DriveAttach.cancel', 'Cancel')}
          </Button>
          <Button tone="ink" disabled={selected.size === 0} onClick={confirm}>
            {tr('DriveAttach.attachSelected', 'Attach selected')}
          </Button>
        </div>
      </section>
    </div>
  );
}
