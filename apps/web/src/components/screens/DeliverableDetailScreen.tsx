'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import { addDeliverableVersion, getDeliverable } from '../../lib/api/deliverables';
import type {
  DeliverableApprovalState,
  DeliverableDetailView,
  DeliverableVersionView,
} from '../../lib/api/deliverables';
import { ATTACHMENT_ACCEPT, attachmentProblem, uploadProjectFile } from '../../lib/api/uploads';
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
import { useT } from '../../lib/i18n/use-t';

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
  const queryKey = ['deliverable', organizationSlug, deliverableId] as const;

  const detail = useQuery({
    queryKey,
    queryFn: () => getDeliverable(api, organizationSlug, deliverableId),
  });

  const [file, setFile] = useState<File | null>(null);
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
      const fileAssetId = file
        ? await uploadProjectFile(api, organizationSlug, { projectId, file })
        : null;
      return addDeliverableVersion(api, organizationSlug, deliverableId, {
        fileAssetId,
        note: note.trim() === '' ? null : note.trim(),
      });
    },
    onSuccess: () => {
      setFile(null);
      setNote('');
      refresh();
    },
  });

  const fileProblem = file ? attachmentProblem(file) : null;
  const canUpload =
    (file !== null || note.trim() !== '') && fileProblem === null && !upload.isPending;
  const listHref = `/${organizationSlug}/projects/${encodeURIComponent(projectId)}/deliverables`;

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
                <VersionList
                  detail={detail.data}
                  organizationSlug={organizationSlug}
                  onSend={setSendingVersion}
                />
              </section>
            </div>
            <div className="tm-prj__col tm-prj__col--aside">
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
                >
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-deliverable-file">
                      {t('Deliverables.fileLabel')}
                    </label>
                    <input
                      id="tm-deliverable-file"
                      className="tm-field__control"
                      type="file"
                      accept={ATTACHMENT_ACCEPT}
                      onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                    />
                    {fileProblem ? <p className="tm-field__error">{fileProblem}</p> : null}
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
            </div>
          </div>
        )}
      </div>

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
}: {
  detail: DeliverableDetailView;
  organizationSlug: string;
  onSend: (version: DeliverableVersionView) => void;
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
        return (
          <li key={version.id} className="tm-stack tm-stack--tight">
            <div className="tm-row tm-row--wrap">
              <span className="tm-badge tm-badge--mono">v{version.versionNo ?? ''}</span>
              <span className="tm-meta-mono">{version.createdAt.slice(0, 10)}</span>
              {approval ? (
                <StateCapsule state={approvalCapsule(approval.state)} className="tm-push-end">
                  {t(APPROVAL_KEY[approval.state])}
                </StateCapsule>
              ) : (
                <StateCapsule state="neutral" className="tm-push-end">
                  {t('Deliverables.notSent')}
                </StateCapsule>
              )}
            </div>
            {version.note ? <p className="tm-prose">{version.note}</p> : null}
            <p className="tm-field__hint">
              {version.fileAssetId ? t('Deliverables.fileAttached') : t('Deliverables.noFile')}
            </p>
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
              {pending ? (
                <Link
                  className="tm-button tm-button--outline tm-button--compact"
                  href={`/${organizationSlug}/portal/deliverables/${encodeURIComponent(version.id)}`}
                >
                  {t('Deliverables.portalLink')}
                </Link>
              ) : null}
              {canSend ? (
                <Button tone="ink" size="compact" onClick={() => onSend(version)}>
                  {t('Deliverables.sendForApproval')}
                </Button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
