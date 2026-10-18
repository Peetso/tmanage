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
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { longDay } from './PortalParts';
import { usePortalNames } from '../../lib/use-organization-names';

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
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
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
  const view = projection.data;
  const decided = view?.projection.decision ?? null;

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="deliverables"
      title={
        view
          ? decided || result
            ? view.projection.title
            : 'Does this work for you?'
          : 'Review and decide'
      }
      eyebrow={view ? `Approval · ${view.projection.title}` : 'Approval'}
      description={
        view?.projection.summary ?? `A version ${providerName} has published for your decision.`
      }
    >
      <div className="tm-pt tm-pt--compact">
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

        {view ? (
          <div className="tm-pt-split tm-pt-split--aside">
            <article className="tm-pt-col" aria-label="Published deliverable">
              <div className="tm-pt-preview tm-pt-preview--tall" aria-hidden="true">
                nothing to show yet
              </div>
              <ProjectionBody view={view} />
            </article>

            <div className="tm-pt-col">
              <section className="tm-pt-card tm-pt-card--lg" aria-label="Your decision">
                <p className="tm-pt-eyebrow">What you are deciding on</p>
                <p className="tm-pt-item">
                  <span className="tm-pt-mono tm-pt-mono--raw tm-pt-item__main">
                    {shortHash(view.contentHash)}
                  </span>
                  <span className="tm-pt-mono">{stamp(view.publishedAt)}</span>
                </p>
                <p className="tm-pt-quiet">
                  Your decision is recorded against this exact version. If the file changes, the
                  approval stops being valid and we ask you again.
                </p>

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
                      <InlineAlert tone="danger" title="Could not record your decision" live>
                        {describe(decide.error)}
                      </InlineAlert>
                    ) : null}

                    <label className="tm-field tm-pt-form-field" htmlFor="approval-note">
                      <span className="tm-pt-eyebrow">
                        A note for {providerName} (required to request changes)
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
                          Add a note so {providerName} knows what to change.
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
                      Approve this version
                    </Button>
                    <Button
                      tone="outline"
                      className="tm-pt-btn--block tm-pt-btn--tall"
                      loading={decide.isPending && decide.variables === 'request_changes'}
                      disabled={decide.isPending}
                      onClick={onRequestChanges}
                    >
                      Request changes
                    </Button>
                    <p className="tm-pt-quiet tm-pt-center">
                      Requesting changes needs at least one specific point so the team can act on
                      it.
                    </p>
                  </>
                )}
              </section>

              <p className="tm-pt-card tm-pt-card--dashed tm-pt-quiet">
                You are seeing the client view of this project. Internal notes and estimates are not
                part of it.
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </ClientPortalShell>
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
  const { projection } = view;
  return (
    <div className="tm-pt-dates">
      <div className="tm-pt-date">
        <span className="tm-pt-eyebrow">Where it is</span>
        <p className="tm-pt-date__value">
          {projection.milestoneState ? words(projection.milestoneState) : 'Shared with you'}
        </p>
      </div>
      <div className="tm-pt-date">
        <span className="tm-pt-eyebrow">Expected</span>
        <p className="tm-pt-date__value">
          {projection.forecastDate ? longDay(projection.forecastDate) : 'No date yet'}
        </p>
      </div>
      {projection.publishedRisk ? (
        <div className="tm-pt-date">
          <span className="tm-pt-eyebrow">Risk</span>
          <p className="tm-pt-date__value">{words(projection.publishedRisk)}</p>
        </div>
      ) : null}
      {projection.decision ? (
        <div className="tm-pt-date">
          <span className="tm-pt-eyebrow">Decision</span>
          <p className="tm-pt-date__value">{words(projection.decision)}</p>
        </div>
      ) : null}
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
