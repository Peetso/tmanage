'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  decideClientApproval,
  getClientApproval,
  type ClientApprovalView,
  type ClientDecideResult,
} from '../../lib/api/approvals';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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
  clientName,
  providerName,
  deliverableVersionId,
  client,
}: ClientApprovalScreenProps) {
  const api = client ?? browserApiClient();
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

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="deliverables"
      title="Review and decide"
      description={`A version ${providerName} has published for your decision.`}
    >
      {projection.isError ? (
        <InlineAlert tone="danger" title="Could not open this deliverable" live>
          {describe(projection.error)}
        </InlineAlert>
      ) : null}

      {projection.isPending ? (
        <LoadingRegion label="Loading the deliverable.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {projection.data ? (
        <article className="tm-panel tm-stack" aria-label="Published deliverable">
          <ProjectionBody view={projection.data} />

          {result ? (
            <Confirmation result={result} />
          ) : (
            <section className="tm-stack tm-stack--tight" aria-label="Your decision">
              {decide.isError ? (
                <InlineAlert tone="danger" title="Could not record your decision" live>
                  {describe(decide.error)}
                </InlineAlert>
              ) : null}

              <label className="tm-field" htmlFor="approval-note">
                <span className="tm-field__label">
                  A note for {providerName} (required to request changes)
                </span>
                <textarea
                  id="approval-note"
                  className="tm-input"
                  rows={3}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  aria-invalid={noteRequired ? true : undefined}
                  {...(noteRequired ? { 'aria-describedby': 'approval-note-error' } : {})}
                />
                {noteRequired ? (
                  <span id="approval-note-error" className="tm-field__error" role="alert">
                    Add a note so {providerName} knows what to change.
                  </span>
                ) : null}
              </label>

              <div className="tm-row tm-row--wrap">
                <Button
                  tone="lime"
                  loading={decide.isPending && decide.variables === 'approve'}
                  disabled={decide.isPending}
                  onClick={() => decide.mutate('approve')}
                >
                  Approve
                </Button>
                <Button
                  tone="outline"
                  loading={decide.isPending && decide.variables === 'request_changes'}
                  disabled={decide.isPending}
                  onClick={onRequestChanges}
                >
                  Request changes
                </Button>
              </div>
            </section>
          )}
        </article>
      ) : null}
    </ClientPortalShell>
  );
}

function ProjectionBody({ view }: { view: ClientApprovalView }) {
  const { projection } = view;
  return (
    <div className="tm-stack tm-stack--tight">
      <h2 className="tm-heading">{projection.title}</h2>
      {projection.milestoneState ? (
        <div className="tm-row tm-row--wrap">
          <StateCapsule state="client">{projection.milestoneState}</StateCapsule>
        </div>
      ) : null}
      {projection.summary ? <p className="tm-prose">{projection.summary}</p> : null}
      <dl className="tm-detail-list">
        {projection.forecastDate ? (
          <div>
            <dt>Forecast date</dt>
            <dd>{projection.forecastDate}</dd>
          </div>
        ) : null}
        {projection.publishedRisk ? (
          <div>
            <dt>Risk</dt>
            <dd>{projection.publishedRisk}</dd>
          </div>
        ) : null}
        {projection.decision ? (
          <div>
            <dt>Decision</dt>
            <dd>{projection.decision}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function Confirmation({ result }: { result: ClientDecideResult }) {
  if (result.state === 'approved') {
    return (
      <InlineAlert tone="success" title="You approved this version" live>
        <p className="tm-prose">Your approval has been recorded. Nothing further is needed.</p>
      </InlineAlert>
    );
  }
  if (result.state === 'changes_requested') {
    return (
      <InlineAlert tone="warning" title="You requested changes" live>
        <p className="tm-prose">
          Your request has been sent{result.feedback ? `: “${result.feedback}”` : '.'}
        </p>
      </InlineAlert>
    );
  }
  return (
    <InlineAlert tone="warning" title="This version changed before your decision" live>
      <p className="tm-prose">
        The deliverable was updated, so your decision could not be applied to it. Please review the
        latest version.
      </p>
    </InlineAlert>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}
