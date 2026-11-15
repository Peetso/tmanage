'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  addDeliverableVersion,
  getDeliverable,
  importCloudFileForDeliverable,
  shareWithClient,
  type CloudPick,
} from '../../lib/api/deliverables';
import { FigmaLinksPanel } from '../viewer/FigmaLinks';
import type {
  DeliverableApprovalState,
  DeliverableDetailView,
  DeliverableVersionView,
} from '../../lib/api/deliverables';
import {
  ATTACHMENT_ACCEPT,
  attachmentProblem,
  formatBytes,
  importCloudFileFor,
  uploadProjectFileFor,
} from '../../lib/api/uploads';
import { cloudImportMessageKey } from '../../lib/cloud-import-copy';
import { DriveAttachPicker } from '../storage/DriveAttachPicker';
import { OneDriveAttachPicker } from '../storage/OneDriveAttachPicker';
import type { ApiClient } from '../../lib/api/client';
import {
  STATE_KEY,
  deliverablesQueryKey,
  describeDeliverableError,
  stateCapsule,
  useDeliverablesT,
  type DeliverablesKey,
} from './DeliverablesScreen';
import { SendForApprovalDialog } from './SendForApprovalDialog';
import { ExternalApproversPanel } from './approvals/ExternalApproversPanel';
import { ApprovalRecordPanel } from './approvals/ApprovalRecordPanel';
import { approvedVersion, staffRecordHref } from '../../lib/approval-record-presentation';
import { useT } from '../../lib/i18n/use-t';
import { HelpTip } from '../help/HelpTip';
import { PreviewAsClientLink } from './PreviewAsClientLink';
import { DeleteDeliverable } from './DeleteDeliverable';
import { useRouter } from 'next/navigation';

export interface DeliverableDetailScreenProps {
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  deliverableId: string;
  client?: ApiClient;
}

const APPROVAL_KEY: Readonly<Record<DeliverableApprovalState, DeliverablesKey>> = {
  draft: 'Deliverables.approvalDraft',
  requested: 'Deliverables.approvalRequested',
  viewed: 'Deliverables.approvalViewed',
  approved: 'Deliverables.approvalApproved',
  changes_requested: 'Deliverables.approvalChangesRequested',
  expired: 'Deliverables.approvalExpired',
  cancelled: 'Deliverables.approvalCancelled',
  invalidated: 'Deliverables.approvalInvalidated',
};

const PENDING: ReadonlySet<DeliverableApprovalState> = new Set(['draft', 'requested', 'viewed']);

function approvalCapsule(state: DeliverableApprovalState): CapsuleState {
  if (state === 'approved') return 'done';
  if (state === 'changes_requested') return 'waiting';
  if (PENDING.has(state)) return 'client';
  return 'neutral';
}

/**
 * **Team deliverable — detail (BG2, Figma DEL-02).**
 *
 * The deliverable's versions, newest first, each with its note, file, approval state and the
 * client's feedback; "Upload new version" (the existing upload pipeline, purpose `deliverable`,
 * plus a note); and "Send for approval" on the newest version not already out with the client.
 *
 * UX-1 (live UX test 69836a13, O-P0-2): one primary action, **Share with client**, puts the newest
 * version in the portal (no approval, no e-mail); "Send for approval" is the secondary choice for
 * a version the client must sign off. Each version says whether the client can open it, read from
 * the same fact the portal reads, and "Preview as client" opens the portal as the client sees it.
 */
export function DeliverableDetailScreen({
  organizationSlug,
  organizationName,
  projectId,
  deliverableId,
  client,
}: DeliverableDetailScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useDeliverablesT();
  const tAll = useT();
  const queryKey = ['deliverable', organizationSlug, deliverableId] as const;

  const detail = useQuery({
    queryKey,
    queryFn: () => getDeliverable(api, organizationSlug, deliverableId),
  });

  const [file, setFile] = useState<File | null>(null);
  // UX-1: a new key empties the file picker after a version is saved (it kept the old name).
  const [pickerKey, setPickerKey] = useState(0);
  const [note, setNote] = useState('');
  const [sendingVersion, setSendingVersion] = useState<DeliverableVersionView | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({
      queryKey: deliverablesQueryKey(organizationSlug, projectId),
    });
  };

  const upload = useMutation({
    mutationFn: async () => {
      const versionNote = note.trim() === '' ? null : note.trim();
      const add = (fileAssetId: string | null) =>
        addDeliverableVersion(api, organizationSlug, deliverableId, {
          fileAssetId,
          note: versionNote,
        });
      // FIX6 item 1: the file is used once its checks pass, and removed again if refused.
      return file
        ? uploadProjectFileFor(api, organizationSlug, { projectId, file }, add)
        : add(null);
    },
    onSuccess: () => {
      setFile(null);
      setPickerKey((key) => key + 1);
      setNote('');
      refresh();
    },
  });

  // FIX6 C2. A version from a picked Drive/OneDrive file: the server copies and checks it, and the
  // version is added once the copy is usable (removed again if that is refused), like an upload.
  const fromCloud = useMutation({
    mutationFn: (pick: CloudPick) => {
      const versionNote = note.trim() === '' ? null : note.trim();
      return importCloudFileFor(
        api,
        organizationSlug,
        () => importCloudFileForDeliverable(api, organizationSlug, deliverableId, pick),
        (fileAssetId) =>
          addDeliverableVersion(api, organizationSlug, deliverableId, {
            fileAssetId,
            note: versionNote,
          }),
      );
    },
    onSuccess: () => {
      setNote('');
      refresh();
    },
  });
  const cloudProblem = (error: unknown) => {
    const key = cloudImportMessageKey(error);
    return key ? tAll(key) : describeDeliverableError(error, t);
  };
  const busy = upload.isPending || fromCloud.isPending;

  const share = useMutation({
    mutationFn: (version: DeliverableVersionView) =>
      shareWithClient(api, organizationSlug, deliverableId, version.id),
    onSuccess: refresh,
  });

  const fileProblem = file ? attachmentProblem(file) : null;
  const canUpload = (file !== null || note.trim() !== '') && fileProblem === null && !busy;
  const listHref = `/${organizationSlug}/projects/${encodeURIComponent(projectId)}/deliverables`;
  const router = useRouter();
  // FIX6 item 8: a deliverable the client approved is a record the agency keeps — no Delete.
  const approved = detail.data?.versions.some((v) => v.approval?.state === 'approved') ?? true;
  // 52-19: the approved version, whose sealed record the certificate shows.
  const certified = detail.data ? approvedVersion(detail.data.versions) : null;
  const recordHref = (approvalId: string) =>
    staffRecordHref(organizationSlug, projectId, deliverableId, approvalId);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={detail.data?.title ?? t('Deliverables.detailFallback')}
      description={detail.data?.description ?? t('Deliverables.detailDescription')}
      eyebrow={t('Deliverables.eyebrow')}
      topBar={
        <ProjectTabs
          organizationSlug={organizationSlug}
          projectId={projectId}
          end={
            <Link className="tm-button tm-button--outline tm-button--accessible" href={listHref}>
              {t('Deliverables.backToList')}
            </Link>
          }
        />
      }
      actions={
        <span className="tm-row tm-row--wrap">
          <PreviewAsClientLink organizationSlug={organizationSlug} projectId={projectId} />
          {certified ? (
            <Link
              className="tm-button tm-button--ink tm-button--accessible"
              href={recordHref(certified.approval.id)}
            >
              {tAll('ApprovalRecord.viewCertificate')}
            </Link>
          ) : null}
          {detail.data && !approved ? (
            <DeleteDeliverable
              api={api}
              organizationSlug={organizationSlug}
              deliverable={{ id: deliverableId, title: detail.data.title }}
              onDeleted={() => {
                refresh();
                router.push(listHref);
              }}
              onRestored={refresh}
            />
          ) : null}
        </span>
      }
      headerAside={
        detail.data ? (
          <StateCapsule state={stateCapsule(detail.data.state)}>
            {t(STATE_KEY[detail.data.state])}
          </StateCapsule>
        ) : undefined
      }
    >
      <div className="tm-prj tm-prj--sub">
        {detail.isError ? (
          <InlineAlert tone="danger" title={t('Deliverables.loadFailed')} live>
            {describeDeliverableError(detail.error, t)}
          </InlineAlert>
        ) : detail.isPending ? (
          <LoadingRegion label={t('Deliverables.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : (
          <div className="tm-prj__grid tm-prj__grid--aside">
            <div className="tm-prj__col">
              <section className="tm-card tm-prj-card" aria-labelledby="tm-deliverable-versions">
                <h2 id="tm-deliverable-versions" className="tm-prj-eyebrow">
                  {t('Deliverables.versionsHeading')}
                </h2>
                {share.isError ? (
                  <InlineAlert tone="danger" title={t('Deliverables.shareFailed')} live>
                    {describeDeliverableError(share.error, t)}
                  </InlineAlert>
                ) : null}
                <VersionList
                  detail={detail.data}
                  organizationSlug={organizationSlug}
                  onSend={setSendingVersion}
                  onShare={(version) => share.mutate(version)}
                  sharing={share.isPending}
                  recordHref={recordHref}
                />
              </section>
            </div>
            <div className="tm-prj__col tm-prj__col--aside">
              <ApprovalRecordPanel
                api={api}
                organizationSlug={organizationSlug}
                projectId={projectId}
                deliverableId={deliverableId}
                approvalId={certified?.approval.id ?? null}
                {...(latestVersion(detail.data)
                  ? { onSendForApproval: () => setSendingVersion(latestVersion(detail.data)) }
                  : {})}
              />
              <section className="tm-card tm-prj-card" aria-labelledby="tm-deliverable-upload">
                <h2 id="tm-deliverable-upload" className="tm-prj-eyebrow">
                  {t('Deliverables.uploadHeading')}
                </h2>
                <form
                  className="tm-stack"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (canUpload) upload.mutate();
                  }}
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    if (!event.dataTransfer.types.includes('Files')) return;
                    event.preventDefault();
                    if (!upload.isPending) setFile(event.dataTransfer.files[0] ?? null);
                  }}
                >
                  {/* UX-1 (O-P1-1): the styled picker the task uploader uses, not the browser's raw
                      "Choose File"; a file can also be dropped on this card. One file per version. */}
                  <div className="tm-field">
                    <span className="tm-field__label" id="tm-deliverable-file-label">
                      {t('Deliverables.fileLabel')}
                    </span>
                    <div className="tm-row tm-row--wrap">
                      <label className="tm-button tm-button--outline tm-button--compact tm-file-pick">
                        {file ? t('Deliverables.chooseOtherFile') : t('Deliverables.chooseFile')}
                        <input
                          key={pickerKey}
                          className="tm-visually-hidden"
                          type="file"
                          accept={ATTACHMENT_ACCEPT}
                          aria-labelledby="tm-deliverable-file-label"
                          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                        />
                      </label>
                      <span className="tm-field__hint" dir="auto">
                        {file
                          ? `${file.name} · ${formatBytes(file.size)}`
                          : t('Deliverables.dropHint')}
                      </span>
                    </div>
                    {fileProblem ? <p className="tm-field__error">{fileProblem}</p> : null}
                    <HelpTip tip={tAll('CloudImport.tip')}>
                      <span className="tm-row tm-row--wrap">
                        <DriveAttachPicker
                          organizationSlug={organizationSlug}
                          client={api}
                          picked={[]}
                          onPick={(picked) => {
                            const first = picked[0];
                            if (first)
                              fromCloud.mutate({ provider: 'google_drive', fileId: first.id });
                          }}
                          onRemove={() => undefined}
                          projectId={projectId}
                          disabled={busy}
                        />
                        <OneDriveAttachPicker
                          organizationSlug={organizationSlug}
                          client={api}
                          picked={[]}
                          onPick={(picked) => {
                            const first = picked[0];
                            if (first) {
                              fromCloud.mutate({
                                provider: 'onedrive',
                                driveId: first.driveId,
                                itemId: first.itemId,
                              });
                            }
                          }}
                          onRemove={() => undefined}
                          projectId={projectId}
                          disabled={busy}
                          showList={false}
                        />
                      </span>
                    </HelpTip>
                    {fromCloud.isPending ? (
                      <p className="tm-field__hint" role="status">
                        {t('Deliverables.addingFromDrive')}
                      </p>
                    ) : null}
                  </div>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-deliverable-note">
                      {t('Deliverables.noteLabel')}
                    </label>
                    <textarea
                      id="tm-deliverable-note"
                      className="tm-field__control"
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      maxLength={5000}
                      rows={3}
                    />
                    <p className="tm-field__hint">{t('Deliverables.noteHint')}</p>
                  </div>
                  {upload.isError ? (
                    <InlineAlert tone="danger" title={t('Deliverables.uploadFailed')} live>
                      {describeDeliverableError(upload.error, t)}
                    </InlineAlert>
                  ) : null}
                  {fromCloud.isError ? (
                    <InlineAlert tone="danger" title={t('Deliverables.uploadFailed')} live>
                      {cloudProblem(fromCloud.error)}
                    </InlineAlert>
                  ) : null}
                  <div className="tm-row">
                    <Button
                      type="submit"
                      tone="ink"
                      size="accessible"
                      disabled={!canUpload}
                      loading={upload.isPending}
                      loadingLabel={t('Deliverables.uploading')}
                    >
                      {t('Deliverables.uploadNewVersion')}
                    </Button>
                  </div>
                </form>
              </section>
              {latestVersion(detail.data) ? (
                <ExternalApproversPanel
                  api={api}
                  organizationSlug={organizationSlug}
                  deliverableId={deliverableId}
                  versionId={latestVersion(detail.data)!.id}
                  versionNo={latestVersion(detail.data)!.versionNo ?? null}
                />
              ) : null}
            </div>
          </div>
        )}
      </div>

      <FigmaLinksPanel
        organizationSlug={organizationSlug}
        projectId={projectId}
        target={{ type: 'deliverable', id: deliverableId }}
        canAttach
        client={api}
      />

      {sendingVersion && detail.data ? (
        <SendForApprovalDialog
          api={api}
          organizationSlug={organizationSlug}
          deliverableId={deliverableId}
          deliverableTitle={detail.data.title}
          version={sendingVersion}
          onClose={() => setSendingVersion(null)}
          onSent={() => {
            setSendingVersion(null);
            refresh();
          }}
        />
      ) : null}
    </AppShell>
  );
}

function VersionList({
  detail,
  organizationSlug,
  onSend,
  onShare,
  sharing,
  recordHref,
}: {
  detail: DeliverableDetailView;
  organizationSlug: string;
  onSend: (version: DeliverableVersionView) => void;
  onShare: (version: DeliverableVersionView) => void;
  sharing: boolean;
  /** 52-19: the printable approval record of an approved version. */
  recordHref: (approvalId: string) => string;
}) {
  const t = useDeliverablesT();
  const viewerT = useT();
  const versions = [...detail.versions].sort((a, b) => (b.versionNo ?? 0) - (a.versionNo ?? 0));
  if (versions.length === 0) return <p className="tm-prose">{t('Deliverables.noVersions')}</p>;
  const latestId = versions[0]?.id;

  return (
    <ol className="tm-list tm-stack">
      {versions.map((version) => {
        const approval = version.approval;
        const pending = approval !== null && PENDING.has(approval.state);
        const canSend =
          version.id === latestId &&
          (approval === null || (!pending && approval.state !== 'approved'));
        const shared = version.sharedWithClientAt !== null;
        const canShare = version.id === latestId && !shared;
        return (
          <li key={version.id} className="tm-stack tm-stack--tight">
            <div className="tm-row tm-row--wrap">
              <span className="tm-badge tm-badge--mono">v{version.versionNo ?? ''}</span>
              <span className="tm-meta-mono">{version.createdAt.slice(0, 10)}</span>
              {/* UX-1: whether the client can open this version, from the portal's own fact. */}
              <StateCapsule state={shared ? 'client' : 'neutral'} className="tm-push-end">
                {shared ? t('Deliverables.sharedWithClient') : t('Deliverables.teamOnly')}
              </StateCapsule>
              {approval ? (
                <StateCapsule state={approvalCapsule(approval.state)}>
                  {t(APPROVAL_KEY[approval.state])}
                </StateCapsule>
              ) : null}
            </div>
            {version.note ? <p className="tm-prose">{version.note}</p> : null}
            {version.fileAssetId ? null : (
              <p className="tm-field__hint">{t('Deliverables.noFile')}</p>
            )}
            {version.fileAssetId ? (
              <div className="tm-row tm-row--wrap">
                <Link
                  className="tm-button tm-button--outline tm-button--compact"
                  href={`/${organizationSlug}/files/${encodeURIComponent(version.fileAssetId)}?deliverableVersionId=${encodeURIComponent(version.id)}`}
                >
                  {viewerT('Viewer.openInViewer')}
                </Link>
              </div>
            ) : null}
            {approval?.feedback ? (
              <blockquote className="tm-prose">
                <span className="tm-field__label">{t('Deliverables.clientFeedback')}</span>{' '}
                {approval.feedback}
              </blockquote>
            ) : null}
            <div className="tm-row tm-row--wrap">
              {canShare ? (
                <HelpTip tip={t('Deliverables.shareTip')}>
                  <Button
                    tone="ink"
                    size="compact"
                    loading={sharing}
                    loadingLabel={t('Deliverables.sharing')}
                    onClick={() => onShare(version)}
                  >
                    {t('Deliverables.shareWithClient')}
                  </Button>
                </HelpTip>
              ) : null}
              {shared || pending ? (
                <Link
                  className="tm-button tm-button--outline tm-button--compact"
                  href={`/${organizationSlug}/portal/deliverables/${encodeURIComponent(version.id)}`}
                >
                  {t('Deliverables.portalLink')}
                </Link>
              ) : null}
              {approval?.state === 'approved' ? (
                <Link
                  className="tm-button tm-button--outline tm-button--compact"
                  href={recordHref(approval.id)}
                >
                  {viewerT('ApprovalRecord.viewCertificate')}
                </Link>
              ) : null}
              {canSend ? (
                <HelpTip tip={t('Deliverables.sendTip')}>
                  <Button
                    tone={canShare ? 'outline' : 'ink'}
                    size="compact"
                    onClick={() => onSend(version)}
                  >
                    {t('Deliverables.sendForApproval')}
                  </Button>
                </HelpTip>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** 52-18: the newest version, the one an outside approver is asked about. */
function latestVersion(
  detail: { readonly versions: readonly DeliverableVersionView[] } | undefined,
): DeliverableVersionView | null {
  if (!detail || detail.versions.length === 0) return null;
  return [...detail.versions].sort((a, b) => (b.versionNo ?? 0) - (a.versionNo ?? 0))[0] ?? null;
}
