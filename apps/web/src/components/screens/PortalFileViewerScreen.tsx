'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { FileViewer, type ViewerHeader } from '../viewer/FileViewer';
import { ViewerIcon } from '../viewer/viewer-icons';
export { portalFileViewerHref } from './PortalReviewLink';
import { decideClientApproval, getClientApproval } from '../../lib/api/approvals';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { PORTAL_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import { usePortalPreview } from '../../lib/portal-preview';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import '../viewer/viewer.css';

export interface PortalFileViewerScreenProps {
  readonly organizationSlug: string;
  readonly fileId: string;
  /** Opened from a published deliverable version: the rail carries that version's decision. */
  readonly deliverableVersionId?: string;
  /** A thread to open straight away (`?thread=` from a notice). */
  readonly initialThreadId?: string;
  readonly clientName: string;
  readonly providerName: string;
  readonly client?: ApiClient;
  readonly apiBase?: string;
  /** Force the team's client preview on or off (stories, tests); the session decides otherwise. */
  readonly preview?: boolean;
}

/**
 * **Portal viewer (R4 slice 8, Figma batch E V-40 – V-45).**
 *
 * The same proofing viewer the team uses, inside the client portal: the file with its numbered
 * pins, boxes and drawings, only the comments the team shared with the client, a composer with no
 * audience switch ("Everyone on the team will see this"), and — when opened from a published
 * deliverable version — the decision card of CL-05 above the comments (Approve / Request changes,
 * a note required for changes), calling the existing client approval routes.
 *
 * A team member who opens this page sees the client's view (V-45): the team's own routes read as
 * the client reads them — team-only comments hidden and counted in the banner — and nothing can be
 * written or decided for the client.
 */
export function PortalFileViewerScreen({
  organizationSlug,
  fileId,
  deliverableVersionId,
  initialThreadId,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
  apiBase,
  preview: previewProp,
}: PortalFileViewerScreenProps) {
  const t = useT();
  const sessionPreview = usePortalPreview(organizationSlug);
  const preview = previewProp ?? sessionPreview;
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  // A name still being read (or a fixture) prints as "the client", never as a blank.
  const clientLabel = clientName || t('Viewer.portal.clientFallback');
  const api = client ?? browserApiClient();
  const backHref = deliverableVersionId
    ? `/${organizationSlug}/portal/deliverables/${encodeURIComponent(deliverableVersionId)}`
    : `/${organizationSlug}/portal/files`;

  const renderShell = (header: ViewerHeader, body: ReactNode) => (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId={deliverableVersionId ? 'deliverables' : 'files'}
      title={header.title}
      eyebrow={
        <nav className="tm-viewer-crumbs" aria-label={t('Viewer.portal.breadcrumb')}>
          <Link href={backHref} className="tm-viewer-crumbs__link">
            {deliverableVersionId ? t('nav.deliverables') : t('nav.files')}
          </Link>
          <span aria-hidden="true">›</span>
          <span>{header.title}</span>
        </nav>
      }
      description={header.titleMeta}
      headerAside={header.actions}
      {...(previewProp === undefined ? {} : { preview: previewProp })}
    >
      <div className="tm-viewer-portal">{body}</div>
    </ClientPortalShell>
  );

  return (
    <FileViewer
      organizationSlug={organizationSlug}
      organizationName={providerName}
      fileId={fileId}
      door="portal"
      previewAsClient={preview}
      teamName={providerName}
      backHref={backHref}
      client={api}
      {...(apiBase ? { apiBase } : {})}
      {...(deliverableVersionId ? { deliverableVersionId } : {})}
      {...(initialThreadId ? { initialThreadId } : {})}
      renderShell={renderShell}
      renderBanner={(hidden) =>
        preview ? (
          <InlineAlert tone="client" title={t('Viewer.portal.previewTitle')}>
            <p>{t('Viewer.portal.previewBody').replace('{client}', clientLabel)}</p>
            {hidden > 0 ? (
              <p>
                {(hidden === 1
                  ? t('Viewer.portal.hiddenOne')
                  : t('Viewer.portal.hiddenMany')
                ).replace('{count}', String(hidden))}
              </p>
            ) : null}
          </InlineAlert>
        ) : null
      }
      {...(deliverableVersionId
        ? {
            railTop: (
              <PortalDecisionCard
                api={api}
                organizationSlug={organizationSlug}
                deliverableVersionId={deliverableVersionId}
                providerName={providerName}
                clientName={clientLabel}
                preview={preview}
              />
            ),
          }
        : {})}
    />
  );
}

/** The content hash as the handoff prints it: "8f2c·d41a". */
function shortHash(hash: string): string {
  const clean = hash.replace(/^sha256:/i, '').slice(0, 8);
  return clean.length === 8 ? `${clean.slice(0, 4)}·${clean.slice(4)}` : clean;
}

/**
 * What the card says once a decision exists: the fresh answer of the decide call wins (its
 * lifecycle state), else the published decision on the version. `recorded` = counted, others to go.
 */
export function decisionShown(
  state: string | null,
  published: string | null,
): 'approved' | 'changes' | 'recorded' | null {
  if (state === 'approved') return 'approved';
  if (state === 'changes_requested') return 'changes';
  if (state !== null) return 'recorded';
  if (published === null || published.trim() === '') return null;
  return /change/i.test(published) ? 'changes' : 'approved';
}

interface PortalDecisionCardProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly deliverableVersionId: string;
  readonly providerName: string;
  readonly clientName: string;
  readonly preview: boolean;
}

/**
 * V-40's decision card (CL-05 `55:276`): what the client is deciding on (the version's hash), then
 * Approve / Request changes. Requesting changes needs a note. The calls are the existing client
 * approval routes; a decided version is read-only ("Approved by you"). In the team's preview the
 * buttons are shown disabled with the reason.
 */
function PortalDecisionCard({
  api,
  organizationSlug,
  deliverableVersionId,
  providerName,
  clientName,
  preview,
}: PortalDecisionCardProps) {
  const t = useT();
  const describe = useDescribeApiError(PORTAL_LINES);
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [noteRequired, setNoteRequired] = useState(false);
  const key = ['client-approval', organizationSlug, deliverableVersionId];

  const approval = useQuery({
    queryKey: key,
    queryFn: () => getClientApproval(api, organizationSlug, deliverableVersionId),
    // The approval read is the client's own; a previewing team member never calls it.
    enabled: !preview,
  });
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'request_changes') =>
      decideClientApproval(api, organizationSlug, deliverableVersionId, {
        decision,
        ...(decision === 'request_changes' ? { feedback: note.trim() } : {}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const view = approval.data;
  const decided = decisionShown(decide.data?.state ?? null, view?.projection.decision ?? null);

  function requestChanges() {
    if (note.trim() === '') {
      setNoteRequired(true);
      return;
    }
    setNoteRequired(false);
    decide.mutate('request_changes');
  }

  return (
    <section className="tm-viewer-decision" aria-label={t('ClientApprovalScreen.yourDecision')}>
      <p className="tm-viewer-decision__eyebrow">{t('ClientApprovalScreen.whatDecidingOn')}</p>
      {approval.isPending && !preview ? <Skeleton height="40px" /> : null}
      {view ? (
        <p className="tm-viewer-decision__hash">
          <span>{shortHash(view.contentHash)}</span>
        </p>
      ) : null}
      <p className="tm-viewer-decision__note">{t('ClientApprovalScreen.decisionRecordedNote')}</p>

      {approval.isError ? (
        <InlineAlert tone="danger" title={t('ClientApprovalScreen.openError')} live>
          {describe(approval.error)}
        </InlineAlert>
      ) : null}

      {preview ? (
        <>
          <Button tone="lime" className="tm-viewer-decision__button" disabled>
            {t('Viewer.portal.approve')}
          </Button>
          <Button tone="outline" className="tm-viewer-decision__button" disabled>
            {t('ClientApprovalScreen.requestChanges')}
          </Button>
          <p className="tm-viewer-decision__note">
            {t('Viewer.portal.previewDecision').replace('{client}', clientName)}
          </p>
        </>
      ) : decided ? (
        <InlineAlert tone="success" title={t('Viewer.portal.decidedTitle')}>
          {t(
            decided === 'changes'
              ? 'Viewer.portal.decidedChanges'
              : decided === 'approved'
                ? 'Viewer.portal.decidedApproved'
                : 'Viewer.portal.decidedRecorded',
          )}
        </InlineAlert>
      ) : view ? (
        <>
          {decide.isError ? (
            <InlineAlert tone="danger" title={t('ClientApprovalScreen.recordError')} live>
              {describe(decide.error)}
            </InlineAlert>
          ) : null}
          <label className="tm-viewer-decision__field" htmlFor="portal-viewer-decision-note">
            <span className="tm-viewer-decision__eyebrow">
              {t('ClientApprovalScreen.noteForPrefix')}
              {providerName}
              {t('ClientApprovalScreen.noteForSuffix')}
            </span>
            <textarea
              id="portal-viewer-decision-note"
              className="tm-input tm-viewer-decision__text"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              aria-invalid={noteRequired ? true : undefined}
              {...(noteRequired ? { 'aria-describedby': 'portal-viewer-decision-error' } : {})}
            />
            {noteRequired ? (
              <span id="portal-viewer-decision-error" className="tm-field__error" role="alert">
                {t('ClientApprovalScreen.addNotePrefix')}
                {providerName}
                {t('ClientApprovalScreen.addNoteSuffix')}
              </span>
            ) : null}
          </label>
          <Button
            tone="lime"
            className="tm-viewer-decision__button"
            loading={decide.isPending && decide.variables === 'approve'}
            disabled={decide.isPending}
            onClick={() => decide.mutate('approve')}
          >
            <ViewerIcon name="check" />
            {t('Viewer.portal.approve')}
          </Button>
          <Button
            tone="outline"
            className="tm-viewer-decision__button"
            loading={decide.isPending && decide.variables === 'request_changes'}
            disabled={decide.isPending}
            onClick={requestChanges}
          >
            {t('ClientApprovalScreen.requestChanges')}
          </Button>
          <p className="tm-viewer-decision__note">{t('ClientApprovalScreen.requestChangesNote')}</p>
        </>
      ) : null}
    </section>
  );
}
