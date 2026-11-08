'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, InlineAlert, Skeleton } from '@tmanage/ui';
import { browseOneDriveFolders, type OneDriveFolderBrowseView } from '../../lib/api/onedrive';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/storage.css';

/** One step of the path from the drive's top to the folder shown; the top has no id. */
export interface FolderStep {
  readonly id: string | undefined;
  readonly name: string;
}

/** The path after opening `folder` from the last step. Pure. */
export function trailAfterOpen(trail: readonly FolderStep[], folder: FolderStep): FolderStep[] {
  return [...trail, folder];
}

/** The path after going back to step `index` (a crumb). Pure. */
export function trailBackTo(trail: readonly FolderStep[], index: number): FolderStep[] {
  return trail.slice(0, Math.max(1, index + 1));
}

export interface OneDriveFolderDialogProps {
  organizationSlug: string;
  client: ApiClient;
  /** Shown for the drive's top (the connected drive's name, or "My files"). */
  rootLabel: string;
  /** The folder chosen; the caller saves it as the root and closes the dialog. */
  onChoose: (folder: { readonly driveId: string; readonly itemId: string }) => void;
  onClose: () => void;
  busy?: boolean;
}

/**
 * R36 F2. **Change folder** for OneDrive. The API lists the connected drive's sub-folders with the
 * connection's own Graph token, so this works for personal and work accounts alike without the
 * second Microsoft consent File Picker v8 needed. The look is the project-files dialog's
 * (`tm-drive-files`): the path as chips, the folders as a list, Cancel and Use this folder.
 */
export function OneDriveFolderDialog({
  organizationSlug,
  client,
  rootLabel,
  onChoose,
  onClose,
  busy = false,
}: OneDriveFolderDialogProps) {
  const tr = useTOr();
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const [trail, setTrail] = useState<FolderStep[]>([{ id: undefined, name: rootLabel }]);
  const here = trail[trail.length - 1];

  const listing = useInfiniteQuery<OneDriveFolderBrowseView>({
    queryKey: ['onedrive-folders', organizationSlug, here?.id ?? null],
    queryFn: ({ pageParam }) =>
      browseOneDriveFolders(client, organizationSlug, {
        ...(here?.id ? { folderId: here.id } : {}),
        ...(typeof pageParam === 'string' ? { pageToken: pageParam } : {}),
      }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextPageToken ?? undefined,
  });

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const pages = listing.data?.pages ?? [];
  const first = pages[0];
  const folders = pages.flatMap((page) => page.folders);

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
          {tr('AdminStorageScreen.pickFolderTitle', 'Choose where TManage keeps files')}
        </h2>
        <p className="tm-drive-files__lede">
          {tr(
            'OneDriveStorage.folderDialogLede',
            'Open a folder, then choose it. TManage keeps its TManage folder inside it.',
          )}
        </p>

        <ul
          className="tm-drive-files__folders"
          aria-label={tr('OneDriveStorage.folderPathLabel', 'Folder path')}
        >
          {trail.map((step, index) => (
            <li key={step.id ?? 'top'}>
              <button
                type="button"
                className="tm-chip tm-chip--compact"
                aria-current={index === trail.length - 1 ? 'true' : undefined}
                onClick={() => setTrail((current) => trailBackTo(current, index))}
              >
                <bdi>{step.name}</bdi>
              </button>
            </li>
          ))}
        </ul>

        <div className="tm-drive-files__body" aria-busy={listing.isPending ? 'true' : undefined}>
          {listing.isPending ? (
            <>
              <span className="tm-visually-hidden">
                {tr('OneDriveStorage.foldersLoading', 'Loading folders')}
              </span>
              <Skeleton height="20px" />
              <Skeleton height="20px" />
              <Skeleton height="20px" />
            </>
          ) : listing.isError ? (
            <InlineAlert
              tone="danger"
              title={tr('OneDriveStorage.errorTitle', 'OneDrive is not reachable')}
              live
            >
              {tr('OneDriveStorage.foldersFailed', 'The folders could not be loaded. Try again.')}
            </InlineAlert>
          ) : folders.length === 0 ? (
            <p className="tm-drive-files__empty">
              {tr('OneDriveStorage.foldersEmpty', 'No folders in here.')}
            </p>
          ) : (
            <ul
              className="tm-drive-files__list"
              aria-label={tr('OneDriveStorage.foldersLabel', 'Folders in OneDrive')}
            >
              {folders.map((folder) => (
                <li key={folder.id}>
                  <Button
                    tone="text"
                    onClick={() =>
                      setTrail((current) =>
                        trailAfterOpen(current, { id: folder.id, name: folder.name }),
                      )
                    }
                  >
                    <bdi>{folder.name}</bdi>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {listing.hasNextPage ? (
            <Button
              tone="text"
              loading={listing.isFetchingNextPage}
              loadingLabel={tr('OneDriveStorage.foldersLoading', 'Loading folders')}
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
          <Button
            tone="ink"
            loading={busy}
            disabled={!first}
            onClick={() => {
              if (first) onChoose({ driveId: first.driveId, itemId: first.folder.id });
            }}
          >
            {tr('OneDriveStorage.useThisFolder', 'Use this folder')}
          </Button>
        </div>
      </section>
    </div>
  );
}
