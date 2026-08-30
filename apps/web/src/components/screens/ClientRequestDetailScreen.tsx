'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, Skeleton, StateCapsule } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { BackendPending } from './BackendPending';
import { browserApiClient } from '../../lib/api/browser-client';
import { getClientRequest, listPortalProjects, withdrawClientRequest } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import {
  describeCommitment,
  describeDesiredDate,
  formatDay,
  requestStatusCapsule,
  requestStatusLabel,
  requestStatusMeaning,
} from '../../lib/client-request-presentation';

export interface ClientRequestDetailScreenProps {
  organizationSlug: string;
  requestId: string;
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **CL-10 Request detail** (`41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §9), the second half of
 * **CL-06** in `22-SCREEN-BY-SCREEN` §6.
 *
 * §6: "Detail shows submitted/clarifying/accepted/deferred/declined/planned/delivered **with
 * client-safe reason**." Every one of those seven has a capsule, a sentence saying what it
 * means for the reader, and — where the studio gave one — the reason in the studio's own words.
 *
 * ## The two dates never share a line
 *
 * "Asked for" is the client's; "Agreed for" is the studio's, and it exists only once somebody
 * accepted the request. They are two rows in the same list with different labels, and the
 * distinction between *no date agreed* and *agreed to do, no date set yet* is kept: §6 gives an
 * acceptance "committed date or explicit unscheduled state", so "we will do it, we have not
 * scheduled it" is an answer the client was actually given rather than an absence.
 *
 * ## Withdraw appears only when withdrawing would work
 *
 * `canWithdraw` comes from the API, which asks the state machine. It is not derived from
 * `status` here, and it could not be: `triage` and `submitted` are the same word to a client,
 * and `23-ERD` §6 draws `submitted → withdrawn` and **no arrow out of `triage`**. A button
 * rendered from `status` would appear on every fresh-looking request and fail on half of them.
 *
 * When it is absent the screen says why, because a control that silently disappears reads as a
 * bug rather than as a rule.
 *
 * ## What the design draws and this does not
 *
 * The artifact's largest panel is a conversation with the studio — two messages, timestamps,
 * a reply box. That is `CHAT-001` and it does not exist; there is no `messages` table and no
 * endpoint. What does exist is the clarification question, which is the one thing the studio can
 * actually say to a client today, and it is rendered as prominently as the artifact renders the
 * thread. Attachments are `FILE-001`, also absent.
 */
export function ClientRequestDetailScreen({
  organizationSlug,
  requestId,
  clientName,
  providerName,
  client,
}: ClientRequestDetailScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const [withdrawing, setWithdrawing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const request = useQuery({
    queryKey: ['portal-request', organizationSlug, requestId],
    queryFn: () => getClientRequest(api, organizationSlug, requestId),
  });

  const found = request.data;
  const project = projects.data?.find((candidate) => candidate.id === found?.projectId);

  async function withdraw() {
    if (!found) return;
    setFailure(undefined);
    setWithdrawing(true);
    try {
      const updated = await withdrawClientRequest(api, organizationSlug, found.id, found.version);
      queries.setQueryData(['portal-request', organizationSlug, requestId], updated);
      await queries.invalidateQueries({ queryKey: ['portal-requests', organizationSlug] });
      setConfirming(false);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        // 409 is the one worth its own sentence. It means somebody moved the request while
        // this page was open, and the fix is to look again rather than to press harder.
        setFailure(
          error.status === 409
            ? 'This request changed while you were reading it. Reload the page to see where it is now.'
            : error.message,
        );
      } else if (error instanceof NetworkError) {
        setFailure('The portal is not answering. Try again shortly.');
      } else {
        setFailure('Something went wrong. Try again.');
      }
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      {...(project ? { projectName: project.name } : {})}
      activeNavigationId="overview"
      title={found?.title ?? 'Your request'}
      description={found ? `Sent ${formatDay(found.createdAt)}` : undefined}
    >
      {request.isError ? (
        <InlineAlert tone="danger" title="Could not load this request" live>
          {describe(request.error)}
        </InlineAlert>
      ) : null}

      {request.isPending ? (
        <div aria-busy="true" aria-live="polite">
          <span className="tm-visually-hidden">Loading your request.</span>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </div>
      ) : null}

      {found ? (
        <>
          <section className="tm-panel tm-stack" aria-labelledby="tm-request-status">
            <h2 id="tm-request-status" className="tm-eyebrow">
              Where this request is
            </h2>
            <div className="tm-row tm-row--wrap">
              <StateCapsule state={requestStatusCapsule(found.status)}>
                {requestStatusLabel(found.status)}
              </StateCapsule>
            </div>
            <p className="tm-prose">{requestStatusMeaning(found.status)}</p>
          </section>

          {found.clarificationQuestion !== null && found.status === 'clarifying' ? (
            <InlineAlert tone="warning" title={`${providerName} has asked you something`} live>
              <p className="tm-prose">{found.clarificationQuestion}</p>
              <p className="tm-prose">
                There is nowhere to answer this in the portal yet — reply to {providerName} the way
                you normally reach them. This request stays here until they hear back.
              </p>
            </InlineAlert>
          ) : null}

          {found.clientVisibleReason !== null ? (
            <section className="tm-panel tm-stack" aria-labelledby="tm-request-reason">
              <h2 id="tm-request-reason" className="tm-eyebrow">
                What {providerName} said
              </h2>
              <p className="tm-prose">{found.clientVisibleReason}</p>
            </section>
          ) : null}

          {found.clientSafeScopeSummary !== null ? (
            <section className="tm-panel tm-stack" aria-labelledby="tm-request-scope">
              <h2 id="tm-request-scope" className="tm-eyebrow">
                What they have agreed to do
              </h2>
              <p className="tm-prose">{found.clientSafeScopeSummary}</p>
            </section>
          ) : null}

          <section className="tm-panel tm-stack" aria-labelledby="tm-request-dates">
            <h2 id="tm-request-dates" className="tm-eyebrow">
              Dates
            </h2>
            <dl className="tm-detail-list">
              <div className="tm-detail-list__pair">
                <dt>You asked for</dt>
                <dd>{describeDesiredDate(found.desiredAt)}</dd>
              </div>
              <div className="tm-detail-list__pair">
                <dt>{providerName} agreed</dt>
                <dd>{describeCommitment(found)}</dd>
              </div>
            </dl>
            <p className="tm-prose">
              The first is what you wanted. The second is what {providerName} has committed to, and
              it exists only once they have accepted the request. They are never the same line, so a
              date you asked for is never read back to you as a promise.
            </p>
          </section>

          <section className="tm-panel tm-stack" aria-labelledby="tm-request-asked">
            <h2 id="tm-request-asked" className="tm-eyebrow">
              What you asked for
            </h2>
            <p className="tm-prose">{found.description}</p>
            {found.urgencyReason !== null ? (
              <>
                <h3 className="tm-eyebrow">Why the timing mattered</h3>
                <p className="tm-prose">{found.urgencyReason}</p>
              </>
            ) : null}
            <dl className="tm-detail-list">
              <div className="tm-detail-list__pair">
                <dt>Project</dt>
                <dd>{project?.name ?? 'A project shared with you'}</dd>
              </div>
              <div className="tm-detail-list__pair">
                <dt>Category</dt>
                <dd>{found.category}</dd>
              </div>
            </dl>
          </section>

          <section className="tm-panel tm-stack" aria-labelledby="tm-request-withdraw">
            <h2 id="tm-request-withdraw" className="tm-eyebrow">
              Take it back
            </h2>

            {failure ? (
              <InlineAlert tone="danger" title="Could not withdraw the request" live>
                {failure}
              </InlineAlert>
            ) : null}

            {found.status === 'withdrawn' ? (
              <p className="tm-prose">
                You withdrew this request. Nothing is expected from anybody.
              </p>
            ) : found.canWithdraw ? (
              confirming ? (
                <>
                  <InlineAlert tone="warning" title="Withdraw this request?" live>
                    {providerName} will see that you took it back. You can send a new request at any
                    time, but this one cannot be reopened.
                  </InlineAlert>
                  <div className="tm-row">
                    <Button
                      type="button"
                      tone="destructive"
                      size="accessible"
                      loading={withdrawing}
                      loadingLabel="Withdrawing"
                      onClick={() => void withdraw()}
                    >
                      Yes, withdraw it
                    </Button>
                    <Button type="button" tone="outline" onClick={() => setConfirming(false)}>
                      Keep it
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  {/*
                    Two sentences, because `23-ERD` §6 draws two arrows into `withdrawn` and they
                    describe different situations. From `submitted` nobody has looked at the
                    request yet. From `needs_clarification` somebody has — they are the reason
                    this page is showing a question — and telling that reader the studio "has not
                    started on it" contradicts the alert directly above. The first end-to-end run
                    of this journey is what surfaced the second case.
                  */}
                  <p className="tm-prose">
                    {found.status === 'clarifying'
                      ? 'You can still take this back, even with their question open. Withdrawing it is an answer too.'
                      : `You can still take this back — ${providerName} has not started on it.`}
                  </p>
                  <div className="tm-row">
                    <Button type="button" tone="outline" onClick={() => setConfirming(true)}>
                      Withdraw request
                    </Button>
                  </div>
                </>
              )
            ) : (
              /*
                Said rather than merely hidden. `23-ERD` §6 has no arrow out of `triage`, so a
                request somebody at the studio has opened is no longer the client's to take
                back — and a control that vanished without explanation would read as a fault.
              */
              <p className="tm-prose">
                {providerName} has this request open, so it is no longer yours to take back. Ask
                them to close it if you no longer need it.
              </p>
            )}
          </section>

          <BackendPending ticket="CHAT-001 · FILE-001">
            The design draws a conversation with {providerName} on this page, with their messages
            and a box to reply in. Messaging is not built, so the one thing they can say to you here
            is a question when they need something — shown above when there is one. Attachments are
            not built either.
          </BackendPending>
        </>
      ) : null}
    </ClientPortalShell>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}
