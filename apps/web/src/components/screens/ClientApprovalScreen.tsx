'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  decideClientApproval,
  getClientApproval,
  type ClientApprovalView,
  type ClientDecideResult,
} from '../../lib/api/approvals';
import { PORTAL_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { longDay } from './PortalParts';
import { listPortalDeliverableFiles } from '../../lib/api/portal';
import { PortalReviewLink } from './PortalReviewLink';
import { PortalDeliverablePreview } from './PortalDeliverablePreview';
import { CheckedLabel } from './CheckedLabel';
import './download-scan-policy.css';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';

export interface ClientApprovalScreenProps {
  organizationSlug: string;
  clientName: string;
  providerName: string;
  /** The governed version the deep link points at — the projection and decide are addressed by it. */
  deliverableVersionId: string;
  client?: ApiClient;
}

/**
 * **FR-05 client deep link.** A client opens the governed, published version, reads the
 * allowlisted projection (`client_projection.read`), and decides — approve, or request changes
 * with a note (`approval.decide`, gated at the object layer on the role ceiling and the client's
 * project relation; the projection's `approvedContacts` is a display field, not part of the gate).
 *
 * ## Only the projection is rendered
 *
 * The screen shows exactly what x97's projection carries (`22-SCREEN-BY-SCREEN` §6's approval
 * card): title, summary, milestone state, forecast date, published risk, decision. It never
 * reaches for an internal field, because the API never hands it one — the client view is the
 * projection, not the internal record with fields hidden (`25-AUTH-AND-TENANT-ISOLATION` §7).
 *
 * ## The decision is final and the confirmation says so
 *
 * A decision is append-only: once made it cannot be remade, so the actions are replaced by a
 * confirmation rather than left clickable. `request_changes` requires a note — the API refuses it
 * empty, and this asks for it before sending so the client is not bounced by a 422. When the
 * governed content changed under the client the decision `invalidates`; the confirmation says that
 * plainly rather than claiming an approval that did not happen.
 */
export function ClientApprovalScreen({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  deliverableVersionId,
  client,
}: ClientApprovalScreenProps) {
  const describe = useDescribeApiError(PORTAL_LINES);
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();
  const t = useT();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [noteRequired, setNoteRequired] = useState(false);

  const projectionKey = ['client-approval', organizationSlug, deliverableVersionId];

  const projection = useQuery({
    queryKey: projectionKey,
    queryFn: () => getClientApproval(api, organizationSlug, deliverableVersionId),
  });

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'request_changes') =>
      decideClientApproval(api, organizationSlug, deliverableVersionId, {
        decision,
        ...(decision === 'request_changes' ? { feedback: note } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectionKey });
    },
  });

  function onRequestChanges() {
    if (note.trim() === '') {
      setNoteRequired(true);
      return;
    }
    setNoteRequired(false);
    decide.mutate('request_changes');
  }

  const result: ClientDecideResult | undefined = decide.data;
  const view = projection.data;
  const decided = view?.projection.decision ?? null;
  // Shared without "Send for approval": plain viewing, no decision asked (the API's own fact).
  const asked = view?.awaitingDecision === true;

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="deliverables"
      title={
        view
          ? asked && !decided && !result
            ? t('ClientApprovalScreen.worksForYou')
            : view.projection.title
          : t('ClientApprovalScreen.reviewAndDecide')
      }
      eyebrow={
        view
          ? asked || decided || result
            ? `${t('ClientApprovalScreen.approvalPrefix')}${view.projection.title}`
            : t('ClientApprovalScreen.sharedWithYou')
          : t('ClientApprovalScreen.approval')
      }
      description={
        view?.projection.summary ??
        `${t('ClientApprovalScreen.versionPublishedPrefix')}${providerName}${t('ClientApprovalScreen.versionPublishedSuffix')}`
      }
    >
      <div className="tm-pt tm-pt--compact">
        {projection.isError ? (
          <InlineAlert tone="danger" title={t('ClientApprovalScreen.openError')} live>
            {describe(projection.error)}
          </InlineAlert>
        ) : null}

        {projection.isPending ? (
          <LoadingRegion label={t('ClientApprovalScreen.loadingLabel')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {view ? (
          <div className="tm-pt-split tm-pt-split--aside">
            <article
              className="tm-pt-col"
              aria-label={t('ClientApprovalScreen.publishedDeliverable')}
            >
              <PortalDeliverablePreview
                api={api}
                organizationSlug={organizationSlug}
                deliverableId={view.deliverableId}
                tall
              />
              <ProjectionBody view={view} />
              <ReviewFiles
                api={api}
                organizationSlug={organizationSlug}
                deliverableId={view.deliverableId}
                deliverableVersionId={deliverableVersionId}
              />
            </article>

            <div className="tm-pt-col">
              {asked || decided || result ? (
                <section
                  className="tm-pt-card tm-pt-card--lg"
                  aria-label={t('ClientApprovalScreen.yourDecision')}
                >
                  <p className="tm-pt-eyebrow">{t('ClientApprovalScreen.whatDecidingOn')}</p>
                  <p className="tm-pt-item">
                    <span className="tm-pt-mono tm-pt-mono--raw tm-pt-item__main">
                      {shortHash(view.contentHash)}
                    </span>
                    <span className="tm-pt-mono">{stamp(view.publishedAt)}</span>
                  </p>
                  <p className="tm-pt-quiet">{t('ClientApprovalScreen.decisionRecordedNote')}</p>

                  {result ? (
                    <Confirmation result={result} />
                  ) : decided ? (
                    <p className="tm-pt-item">
                      <span className="tm-pt-orb tm-pt-orb--done" aria-hidden="true">
                        ✓
                      </span>
                      <span className="tm-pt-item__title">{words(decided)}</span>
                    </p>
                  ) : (
                    <>
                      {decide.isError ? (
                        <InlineAlert
                          tone="danger"
                          title={t('ClientApprovalScreen.recordError')}
                          live
                        >
                          {describe(decide.error)}
                        </InlineAlert>
                      ) : null}

                      <label className="tm-field tm-pt-form-field" htmlFor="approval-note">
                        <span className="tm-pt-eyebrow">
                          {t('ClientApprovalScreen.noteForPrefix')}
                          {providerName}
                          {t('ClientApprovalScreen.noteForSuffix')}
                        </span>
                        <textarea
                          id="approval-note"
                          className="tm-input tm-pt-textarea"
                          rows={3}
                          value={note}
                          onChange={(event) => setNote(event.target.value)}
                          aria-invalid={noteRequired ? true : undefined}
                          {...(noteRequired ? { 'aria-describedby': 'approval-note-error' } : {})}
                        />
                        {noteRequired ? (
                          <span id="approval-note-error" className="tm-field__error" role="alert">
                            {t('ClientApprovalScreen.addNotePrefix')}
                            {providerName}
                            {t('ClientApprovalScreen.addNoteSuffix')}
                          </span>
                        ) : null}
                      </label>

                      <Button
                        tone="lime"
                        className="tm-pt-btn--block tm-pt-btn--tall"
                        loading={decide.isPending && decide.variables === 'approve'}
                        disabled={decide.isPending}
                        onClick={() => decide.mutate('approve')}
                      >
                        {t('ClientApprovalScreen.approveVersion')}
                      </Button>
                      <Button
                        tone="outline"
                        className="tm-pt-btn--block tm-pt-btn--tall"
                        loading={decide.isPending && decide.variables === 'request_changes'}
                        disabled={decide.isPending}
                        onClick={onRequestChanges}
                      >
                        {t('ClientApprovalScreen.requestChanges')}
                      </Button>
                      <p className="tm-pt-quiet tm-pt-center">
                        {t('ClientApprovalScreen.requestChangesNote')}
                      </p>
                    </>
                  )}
                </section>
              ) : null}

              <p className="tm-pt-card tm-pt-card--dashed tm-pt-quiet">
                {t('ClientApprovalScreen.clientViewNote')}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </ClientPortalShell>
  );
}

/**
 * R4 slice 8 (V-44, CL-08) — the deliverable's files the client can open in the viewer, each with
 * a Review button and its open-comment count. Absent when there is nothing to review.
 */
function ReviewFiles({
  api,
  organizationSlug,
  deliverableId,
  deliverableVersionId,
}: {
  api: ApiClient;
  organizationSlug: string;
  deliverableId: string;
  deliverableVersionId: string;
}) {
  const t = useT();
  const files = useQuery({
    queryKey: ['portal-deliverable-files', organizationSlug, deliverableId],
    queryFn: () => listPortalDeliverableFiles(api, organizationSlug, deliverableId),
  });
  const rows = (files.data ?? []).filter((file) => file.reviewable);
  if (rows.length === 0) return null;
  return (
    <section className="tm-pt-card" aria-label={t('Viewer.portal.reviewFiles')}>
      <p className="tm-pt-eyebrow">{t('Viewer.portal.reviewFiles')}</p>
      <ul className="tm-pt-files">
        {rows.map((file) => (
          <li key={file.id} className="tm-pt-item">
            <span className="tm-pt-file__icon" aria-hidden="true" />
            <div className="tm-pt-item__main">
              <p className="tm-pt-item__title">
                {file.name}
                {file.safety === 'checked' ? <CheckedLabel withNote /> : null}
              </p>
            </div>
            <PortalReviewLink
              organizationSlug={organizationSlug}
              fileId={file.id}
              fileName={file.name}
              openComments={file.openComments}
              deliverableVersionId={deliverableVersionId}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The content hash as the handoff prints it: "8f2c·d41a". */
function shortHash(hash: string): string {
  const clean = hash.replace(/^sha256:/i, '').slice(0, 8);
  return clean.length === 8 ? `${clean.slice(0, 4)}·${clean.slice(4)}` : clean;
}

function stamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(parsed);
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(
    parsed,
  );
  return `${day} ${time}`;
}

/** An enum-looking value (`in_review`) said in words; free text is shown as written. */
function words(value: string): string {
  if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(value)) return value;
  const spaced = value.replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function ProjectionBody({ view }: { view: ClientApprovalView }) {
  const t = useT();
  const { projection } = view;
  return (
    <div className="tm-pt-dates">
      <div className="tm-pt-date">
        <span className="tm-pt-eyebrow">{t('ClientApprovalScreen.whereItIs')}</span>
        <p className="tm-pt-date__value">
          {projection.milestoneState
            ? words(projection.milestoneState)
            : t('ClientApprovalScreen.sharedWithYou')}
        </p>
      </div>
      <div className="tm-pt-date">
        <span className="tm-pt-eyebrow">{t('ClientApprovalScreen.expected')}</span>
        <p className="tm-pt-date__value">
          {projection.forecastDate
            ? longDay(projection.forecastDate)
            : t('ClientApprovalScreen.noDateYet')}
        </p>
      </div>
      {projection.publishedRisk ? (
        <div className="tm-pt-date">
          <span className="tm-pt-eyebrow">{t('ClientApprovalScreen.risk')}</span>
          <p className="tm-pt-date__value">{words(projection.publishedRisk)}</p>
        </div>
      ) : null}
      {projection.decision ? (
        <div className="tm-pt-date">
          <span className="tm-pt-eyebrow">{t('ClientApprovalScreen.decision')}</span>
          <p className="tm-pt-date__value">{words(projection.decision)}</p>
        </div>
      ) : null}
    </div>
  );
}

function Confirmation({ result }: { result: ClientDecideResult }) {
  const t = useT();
  if (result.state === 'requested' || result.state === 'viewed') {
    // Several approvers: this approval is recorded and the others still have to decide (a change
    // request is always final, so only an approval can leave the version waiting).
    return (
      <InlineAlert tone="success" title={t('ClientApprovalScreen.approvalRecordedTitle')} live>
        <p className="tm-prose">{t('ClientApprovalScreen.waitingForOthersBody')}</p>
      </InlineAlert>
    );
  }
  if (result.state === 'approved') {
    return (
      <InlineAlert tone="success" title={t('ClientApprovalScreen.approvedTitle')} live>
        <p className="tm-prose">{t('ClientApprovalScreen.approvedBody')}</p>
      </InlineAlert>
    );
  }
  if (result.state === 'changes_requested') {
    return (
      <InlineAlert tone="warning" title={t('ClientApprovalScreen.changesRequestedTitle')} live>
        <p className="tm-prose">
          {t('ClientApprovalScreen.requestSent')}
          {result.feedback ? `: “${result.feedback}”` : '.'}
        </p>
      </InlineAlert>
    );
  }
  return (
    <InlineAlert tone="warning" title={t('ClientApprovalScreen.versionChangedTitle')} live>
      <p className="tm-prose">{t('ClientApprovalScreen.versionChangedBody')}</p>
    </InlineAlert>
  );
}
