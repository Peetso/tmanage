'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, Skeleton } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { apiBaseUrl } from '../../../lib/api/browser-client';
import { NetworkError } from '../../../lib/api/errors';
import { addAttachmentVersion, getAttachmentHistory } from '../../../lib/api/attachment-versions';
import type { AttachmentVersion } from '../../../lib/api/attachment-versions';
import { addDeliverableVersion } from '../../../lib/api/deliverables';
import type { DeliverableDetailView, DeliverableVersionView } from '../../../lib/api/deliverables';
import { listFigmaLinks } from '../../../lib/api/figma';
import {
  getStorageStatus,
  importDriveFileToWorkItem,
  listDriveAttachments,
} from '../../../lib/api/google-drive';
import {
  getOneDriveStatus,
  importOneDriveFileToWorkItem,
  listOneDriveAttachments,
} from '../../../lib/api/onedrive';
import {
  attachmentProblem,
  uploadProjectFileFor,
  uploadWorkItemAttachment,
} from '../../../lib/api/uploads';
import {
  detachWorkItemFile,
  type ItemFile,
  type WorkItemSummary,
} from '../../../lib/api/work-items';
import { cloudImportMessageKey } from '../../../lib/cloud-import-copy';
import type { PickedDriveItem } from '../../../lib/google-picker';
import type { PickedOneDriveItem } from '../../../lib/onedrive-picker';
import { memberDisplayName } from '../../../lib/members-presentation';
import type { UploadRow } from '../../../lib/upload-queue';
import type { useMembers } from '../../../lib/use-members';
import { NotScannedDownload } from '../../screens/NotScannedDownload';
import { NoStorageAttach, useAttachStorageState } from '../../storage/NoStorageAttach';
import { oneDriveStatusKey } from '../../storage/OneDriveAttachPicker';
import { UploadProgressItem, useUploadQueue } from '../../storage/UploadProgress';
import { AttachFigmaDialog, figmaLinksKey } from '../../viewer/FigmaLinks';
import { dayOf, formatShortDay, useA6T } from '../DueDatePicker';
import { describeWorkError } from './describe-work-error';
import { WorkAttachMenu } from './WorkAttachMenu';
import { WorkFileChip } from './WorkFileChip';
import './work-files.css';

export interface WorkFilesProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly item: WorkItemSummary;
  readonly files: readonly ItemFile[];
  readonly loading: boolean;
  readonly failed: boolean;
  readonly backingOf: (file: ItemFile) => DeliverableDetailView | undefined;
  readonly latestOf: (detail: DeliverableDetailView) => DeliverableVersionView | undefined;
  readonly members: ReturnType<typeof useMembers>;
  readonly locale: string;
}

/** Which chain "Upload new version" adds to: a deliverable's, or a plain attachment's (C7). */
type VersionTarget =
  | { readonly kind: 'deliverable'; readonly id: string }
  | { readonly kind: 'plain'; readonly id: string };

function attachmentHistoryKey(organizationSlug: string, fileAssetId: string) {
  return ['attachment-history', organizationSlug, fileAssetId] as const;
}

/**
 * The body of the work page's Files section (Figma `WV2-02`: one row of file chips and a flush
 * "Attach"; `WV2-09`: "Attach" alone). Every feature of the older file rows stays, moved into the
 * chip's ⌄ panel: Review, Download (or the scan notice), Upload new version, and the version
 * history with Restore (deliverable files, Q7) or Download of an older copy (plain files, C7).
 * Figma links, Google Drive and OneDrive files are chips in the same row; "Attach" holds a file
 * from this device, a Figma link and both drives. A file dropped on the section is attached.
 */
export function WorkFiles({
  api,
  organizationSlug,
  item,
  files,
  loading,
  failed,
  backingOf,
  latestOf,
  members,
  locale,
}: WorkFilesProps) {
  const ta = useA6T();
  const queries = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const versionPicker = useRef<HTMLInputElement>(null);
  const [versionTarget, setVersionTarget] = useState<VersionTarget | null>(null);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [figmaOpen, setFigmaOpen] = useState(false);
  const describe = (error: unknown) => describeWorkError(error, ta);
  const base = apiBaseUrl();
  const href = (fileAssetId: string) =>
    `${base}/v1/organizations/${encodeURIComponent(organizationSlug)}/files/${encodeURIComponent(fileAssetId)}/content`;

  // C7. The version history of each plain (not deliverable-backed) attachment.
  const plainFiles = files.filter((file) => backingOf(file) === undefined).slice(0, 20);
  const plainHistories = useQueries({
    queries: plainFiles.map((file) => ({
      queryKey: attachmentHistoryKey(organizationSlug, file.fileAssetId),
      queryFn: () => getAttachmentHistory(api, organizationSlug, file.fileAssetId),
    })),
  });
  const plainHistoryOf = (file: ItemFile): readonly AttachmentVersion[] => {
    const index = plainFiles.findIndex((entry) => entry.id === file.id);
    return index < 0 ? [] : (plainHistories[index]?.data?.versions ?? []);
  };

  const addPlainVersion = useMutation({
    mutationFn: (input: { rootFileAssetId: string; fileAssetId: string }) =>
      addAttachmentVersion(api, organizationSlug, input.rootFileAssetId, {
        fileAssetId: input.fileAssetId,
      }),
    onSuccess: (_history, input) => {
      setProblem(undefined);
      void queries.invalidateQueries({
        queryKey: attachmentHistoryKey(organizationSlug, input.rootFileAssetId),
      });
    },
    onError: (error) => setProblem(describe(error)),
  });

  // V-53. The Figma links attached to this work: chips that open the Figma viewer.
  const figmaTarget = { type: 'work_item', id: item.id } as const;
  const figmaKey = figmaLinksKey(organizationSlug, item.projectId, figmaTarget);
  const figmaLinks = useQuery({
    queryKey: figmaKey,
    queryFn: () => listFigmaLinks(api, organizationSlug, item.projectId, figmaTarget),
    retry: false,
  });
  const figmaRows = figmaLinks.data?.links ?? [];

  // B (wave 17). Files attached from Google Drive sit in the same row as the TManage ones; the
  // storage status decides whether the Drive picker is offered.
  const storage = useQuery({
    queryKey: ['storage-status', organizationSlug],
    queryFn: () => getStorageStatus(api, organizationSlug),
    staleTime: 60_000,
  });
  // 419:23811 / 419:23844: with neither Google Drive nor OneDrive chosen, no file can be stored;
  // files attached before stay listed, and a Figma link can still be attached.
  const attachState = useAttachStorageState(organizationSlug, api);
  const noStorage = attachState === 'connect' || attachState === 'ask';
  const driveFiles = useQuery({
    queryKey: ['drive-attachments', organizationSlug, item.id],
    queryFn: () => listDriveAttachments(api, organizationSlug, item.id),
    enabled: storage.data?.configured === true,
  });
  const driveRows = driveFiles.data ?? [];

  // 0236. The same for OneDrive.
  const oneDrive = useQuery({
    queryKey: oneDriveStatusKey(organizationSlug),
    queryFn: () => getOneDriveStatus(api, organizationSlug),
    staleTime: 60_000,
  });
  const oneDriveFiles = useQuery({
    queryKey: ['onedrive-attachments', organizationSlug, item.id],
    queryFn: () => listOneDriveAttachments(api, organizationSlug, item.id),
    enabled: oneDrive.data?.configured === true,
  });
  const oneDriveRows = oneDriveFiles.data ?? [];

  // FIX6 C1. A picked drive file becomes a checked TManage copy in this work's files (the server
  // fetches it), so the client can open it in the portal without connecting anything.
  const filesKey = ['work-item-files', organizationSlug, item.id] as const;
  const cloudProblem = (error: unknown) => {
    const key = cloudImportMessageKey(error);
    return key ? ta(key) : describe(error);
  };
  const attachFromOneDrive = useMutation({
    mutationFn: async (picked: readonly PickedOneDriveItem[]) => {
      for (const file of picked) {
        await importOneDriveFileToWorkItem(api, organizationSlug, item.id, file);
      }
    },
    onSuccess: () => setProblem(undefined),
    onError: (error) => setProblem(cloudProblem(error)),
    onSettled: () => void queries.invalidateQueries({ queryKey: filesKey }),
  });
  const attachFromDrive = useMutation({
    mutationFn: async (picked: readonly PickedDriveItem[]) => {
      for (const file of picked) {
        await importDriveFileToWorkItem(api, organizationSlug, item.id, file.id);
      }
    },
    onSuccess: () => setProblem(undefined),
    onError: (error) => setProblem(cloudProblem(error)),
    onSettled: () => void queries.invalidateQueries({ queryKey: filesKey }),
  });

  // 409:6602. Each new file is a progress row (bar, Cancel, Retry) until it is attached; a dropped
  // connection reads "Upload stopped at N %", any other refusal in the API's words.
  const uploads = useUploadQueue((error) =>
    error instanceof NetworkError ? null : describe(error),
  );
  // UX-1 (live UX test 69836a13, O-P1-2): several files at once. A file the checks refuse before
  // sending (empty, too large, a blocked type) is named with its reason instead of being dropped.
  const attachFiles = (picked: readonly File[]) => {
    const refused = picked.flatMap((file) => {
      const reason = attachmentProblem(file);
      return reason === null ? [] : [reason];
    });
    setProblem(refused.length > 0 ? refused.join(' ') : undefined);
    for (const file of picked) {
      if (attachmentProblem(file) === null) void attachFile(file);
    }
  };
  const attachFile = async (file: File) => {
    // FIX6 item 2: the same road as chat and Files: uploaded to TManage, attached as a work file.
    await uploads.start(file, async (sent, deps) => {
      const attached = await uploadWorkItemAttachment(
        api,
        organizationSlug,
        { workItemId: item.id, projectId: item.projectId, file: sent },
        deps,
      );
      void queries.invalidateQueries({ queryKey: filesKey });
      return attached.id;
    });
  };
  // A finished row stands in for its attachment, so the chips do not show it twice.
  const justUploaded = new Set(
    uploads.rows.flatMap((row) => (row.state === 'done' && row.resultId ? [row.resultId] : [])),
  );
  const removeUpload = async (row: UploadRow) => {
    if (row.state === 'done' && row.resultId) {
      try {
        await detachWorkItemFile(api, organizationSlug, item.id, row.resultId);
      } catch (error) {
        setProblem(describe(error));
        return;
      }
      void queries.invalidateQueries({ queryKey: filesKey });
    }
    uploads.remove(row.id);
  };

  const addVersion = useMutation({
    mutationFn: async (input: {
      deliverableId: string;
      fileAssetId: string;
      note: string | null;
    }) =>
      addDeliverableVersion(api, organizationSlug, input.deliverableId, {
        fileAssetId: input.fileAssetId,
        note: input.note,
      }),
    onSuccess: (_version, input) => {
      setProblem(undefined);
      void queries.invalidateQueries({
        queryKey: ['deliverable', organizationSlug, input.deliverableId],
      });
    },
    onError: (error) => setProblem(describe(error)),
  });

  async function uploadVersion(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || versionTarget === null) return;
    const target = versionTarget;
    try {
      // FIX6 item 1: the file is used once its checks pass, and removed again if refused.
      await uploadProjectFileFor(
        api,
        organizationSlug,
        { projectId: item.projectId, file },
        async (fileAssetId) => {
          if (target.kind === 'deliverable') {
            await addVersion.mutateAsync({ deliverableId: target.id, fileAssetId, note: null });
          } else {
            await addPlainVersion.mutateAsync({ rootFileAssetId: target.id, fileAssetId });
          }
        },
      );
    } catch (error) {
      setProblem(describe(error));
    }
  }
  const pickVersion = (target: VersionTarget) => {
    setVersionTarget(target);
    versionPicker.current?.click();
  };

  const nameOf = (userId: string) => memberDisplayName(userId, members.members, members.isPending);
  const day = (instant: string) => formatShortDay(dayOf(instant), locale);
  const moreFor = (name: string) => ta('WorkFiles.moreFor', { name });

  return (
    // The page's Files section owns the heading; this is its body (no second "Files" landmark).
    <div
      className="tm-wk-filebox"
      onDragOver={(event) => {
        if (!noStorage && event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (noStorage || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        attachFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {noStorage ? (
        <NoStorageAttach organizationSlug={organizationSlug} client={api} state={attachState} />
      ) : null}
      {problem ? (
        <InlineAlert tone="danger" title={ta('WorkDetail.fileProblem')} live>
          {problem}
        </InlineAlert>
      ) : null}
      {loading ? <Skeleton height="var(--app-control)" /> : null}
      {failed ? <p className="tm-wk-section__empty">{ta('WorkDetail.filesError')}</p> : null}
      {figmaLinks.isError ? (
        <p className="tm-wk-section__empty">{ta('Figma.links.loadError')}</p>
      ) : null}

      {uploads.rows.length > 0 ? (
        <ul className="tm-wk-files">
          {uploads.rows.map((row) => (
            <UploadProgressItem
              key={row.id}
              row={row}
              onCancel={uploads.cancel}
              onRetry={uploads.retry}
              onRemove={(done) => void removeUpload(done)}
              removableWhenDone
            />
          ))}
        </ul>
      ) : null}

      <ul className="tm-wk-chips" aria-label={ta('WorkDetail.tabFiles')}>
        {files
          .filter((file) => !justUploaded.has(file.id))
          .map((file) => {
            const backing = backingOf(file);
            const latest = backing ? latestOf(backing) : undefined;
            const plain = backing ? [] : plainHistoryOf(file);
            const plainLatest = plain.length > 1 ? plain[0] : undefined;
            const servedAsset = latest?.fileAssetId ?? plainLatest?.fileAssetId ?? file.fileAssetId;
            const availability = plainLatest?.availability ?? file.availability;
            const history = backing
              ? [...backing.versions].sort((a, b) => (b.versionNo ?? 0) - (a.versionNo ?? 0))
              : [];
            const viewer = `/${organizationSlug}/files/${encodeURIComponent(servedAsset)}`;
            return (
              <WorkFileChip
                key={file.id}
                name={file.fileName}
                // V-54: the chip opens the viewer, as "Review" did.
                href={availability === 'unavailable' ? undefined : viewer}
                openLabel={`${file.fileName} · ${ta('WorkDetail.review')}`}
                moreLabel={moreFor(file.fileName)}
                scanning={availability === 'scanning'}
              >
                <p className="tm-wk-chip__meta">
                  {latest
                    ? ta('WorkDetail.versionUpdated', {
                        n: latest.versionNo ?? 1,
                        day: day(latest.createdAt),
                        name: nameOf(latest.createdByUserId),
                      })
                    : plainLatest
                      ? ta('WorkDetail.versionUpdated', {
                          n: plainLatest.versionNo,
                          day: day(plainLatest.createdAt),
                          name: nameOf(plainLatest.createdByUserId),
                        })
                      : ta('WorkDetail.versionOn', { n: 1, day: day(file.createdAt) })}
                </p>
                <div className="tm-wk-chip__actions">
                  {availability !== 'unavailable' ? (
                    <Link className="tm-wk-text-button" href={viewer}>
                      {ta('WorkDetail.review')}
                    </Link>
                  ) : null}
                  {availability === 'ready' ? (
                    <a
                      className="tm-wk-text-button"
                      href={href(servedAsset)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {ta('WorkDetail.download')}
                    </a>
                  ) : availability === 'scanning' ? (
                    <NotScannedDownload href={href(servedAsset)} fileName={file.fileName} />
                  ) : (
                    <span className="tm-wk-chip__meta" role="status">
                      {ta('WorkDetail.unavailable')}
                    </span>
                  )}
                  <button
                    type="button"
                    className="tm-wk-text-button"
                    disabled={backing ? addVersion.isPending : addPlainVersion.isPending}
                    onClick={() =>
                      pickVersion(
                        backing
                          ? { kind: 'deliverable', id: backing.id }
                          : { kind: 'plain', id: file.fileAssetId },
                      )
                    }
                  >
                    {ta('WorkDetail.uploadVersion')}
                  </button>
                </div>
                {backing && history.length > 0 ? (
                  <div className="tm-wk-history">
                    <p className="tm-wk-history__title">{ta('WorkDetail.versionHistory')}</p>
                    <ul>
                      {history.map((version, index) => (
                        <li key={version.id} data-current={index === 0}>
                          <span>
                            {index === 0
                              ? ta('WorkDetail.versionCurrent', { n: version.versionNo ?? 1 })
                              : ta('WorkDetail.versionBy', {
                                  n: version.versionNo ?? 1,
                                  name: nameOf(version.createdByUserId),
                                })}
                          </span>
                          {index === 0 ? (
                            <span>{day(version.createdAt)}</span>
                          ) : version.fileAssetId !== null ? (
                            <button
                              type="button"
                              className="tm-wk-text-button"
                              disabled={addVersion.isPending}
                              onClick={() =>
                                addVersion.mutate({
                                  deliverableId: backing.id,
                                  fileAssetId: version.fileAssetId as string,
                                  note: ta('WorkDetail.restoredNote', {
                                    n: version.versionNo ?? 1,
                                  }),
                                })
                              }
                            >
                              {ta('WorkDetail.restore')}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {!backing && plain.length > 1 ? (
                  <div className="tm-wk-history">
                    <p className="tm-wk-history__title">{ta('WorkDetail.versionHistory')}</p>
                    <ul>
                      {plain.map((version) => (
                        <li key={version.fileAssetId} data-current={version.current}>
                          <span>
                            {version.current
                              ? ta('WorkDetail.versionCurrent', { n: version.versionNo })
                              : ta('WorkDetail.versionBy', {
                                  n: version.versionNo,
                                  name: nameOf(version.createdByUserId),
                                })}
                          </span>
                          {version.current ? (
                            <span>{day(version.createdAt)}</span>
                          ) : version.availability === 'ready' ? (
                            <a
                              className="tm-wk-text-button"
                              href={href(version.fileAssetId)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {ta('WorkDetail.download')}
                            </a>
                          ) : version.availability === 'scanning' ? (
                            <NotScannedDownload
                              href={href(version.fileAssetId)}
                              fileName={version.fileName}
                            />
                          ) : (
                            <span role="status">{ta('WorkDetail.unavailable')}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </WorkFileChip>
            );
          })}
        {figmaRows.map((link) => {
          const name = link.fileName ?? ta('Figma.viewer.untitled');
          return (
            <WorkFileChip
              key={link.id}
              name={name}
              href={`/${organizationSlug}/figma/${encodeURIComponent(link.id)}`}
              openLabel={`${name} · ${ta('Figma.links.review')}`}
            />
          );
        })}
        {driveRows
          .filter((drive) => !justUploaded.has(drive.id))
          .map((drive) => (
            <WorkFileChip
              key={drive.id}
              name={drive.name}
              href={drive.webViewLink ?? undefined}
              external
            />
          ))}
        {oneDriveRows
          .filter((file) => !justUploaded.has(file.id))
          .map((file) => (
            <WorkFileChip key={file.id} name={file.name} href={file.webUrl ?? undefined} external />
          ))}
        <li className="tm-wk-chips__attach">
          <WorkAttachMenu
            api={api}
            organizationSlug={organizationSlug}
            projectId={item.projectId}
            storageReady={!noStorage}
            busy={attachFromDrive.isPending || attachFromOneDrive.isPending}
            onFile={() => picker.current?.click()}
            onFigma={() => setFigmaOpen(true)}
            onDrive={(picked) => attachFromDrive.mutate(picked)}
            onOneDrive={(picked) => attachFromOneDrive.mutate(picked)}
          />
        </li>
      </ul>

      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = '';
          attachFiles(picked);
        }}
      />
      <input
        ref={versionPicker}
        type="file"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => void uploadVersion(event)}
      />
      {figmaOpen ? (
        <AttachFigmaDialog
          api={api}
          organizationSlug={organizationSlug}
          projectId={item.projectId}
          target={figmaTarget}
          onClose={() => setFigmaOpen(false)}
          onAttached={() => {
            setFigmaOpen(false);
            void queries.invalidateQueries({ queryKey: figmaKey });
          }}
        />
      ) : null}
    </div>
  );
}
