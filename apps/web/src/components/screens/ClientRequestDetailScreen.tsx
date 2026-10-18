'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getClientRequest, listPortalProjects, withdrawClientRequest } from '../../lib/api/portal';
import type { ClientRequestStatus } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import {
  describeCommitment,
  describeDesiredDate,
  formatDay,
  requestStatusLabel,
  requestStatusMeaning,
} from '../../lib/client-request-presentation';
import { Tag } from './PortalParts';

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

  const waitingOnClient = found?.status === 'clarifying';
  const committed = found?.commitment === 'committed' && found.committedAt !== null;

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="overview"
      title={found?.title ?? 'Your request'}
      eyebrow={
        found ? (
          <span className="tm-pt-action__meta">
            <Tag tone={waitingOnClient ? 'lime' : undefined}>
              {requestStatusLabel(found.status)}
            </Tag>
            {found.status === 'accepted' && !committed ? <Tag>No committed date</Tag> : null}
            <span>Sent {formatDay(found.createdAt)}</span>
          </span>
        ) : undefined
      }
      headerAside={
        found && found.canWithdraw && found.status !== 'withdrawn' && !confirming ? (
          <Button type="button" tone="outline" onClick={() => setConfirming(true)}>
            Withdraw request
          </Button>
        ) : undefined
      }
    >
      <div className="tm-pt tm-pt--compact">
        {request.isError ? (
          <InlineAlert tone="danger" title="Could not load this request" live>
            {describe(request.error)}
          </InlineAlert>
        ) : null}

        {request.isPending ? (
          <LoadingRegion label="Loading your request.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {found ? (
          <div className="tm-pt-split tm-pt-split--aside">
            <div className="tm-pt-col">
              {failure ? (
                <InlineAlert tone="danger" title="Could not withdraw the request" live>
                  {failure}
                </InlineAlert>
              ) : null}

              {confirming ? (
                <section className="tm-pt-card tm-pt-card--lead" aria-label="Withdraw">
                  <InlineAlert tone="warning" title="Withdraw this request?" live>
                    {providerName} will see that you took it back. You can send a new request at any
                    time, but this one cannot be reopened.
                  </InlineAlert>
                  <div className="tm-pt-form__actions">
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
                </section>
              ) : null}

              <section className="tm-pt-ink tm-pt-banner" aria-labelledby="tm-request-status">
                <span className="tm-pt-banner__dot" aria-hidden="true" />
                <div className="tm-pt-item__main">
                  <h2 id="tm-request-status" className="tm-pt-ink__title">
                    {waitingOnClient && found.clarificationQuestion !== null
                      ? `${providerName} has asked you something`
                      : 'Where this request is'}
                  </h2>
                  {waitingOnClient && found.clarificationQuestion !== null ? (
                    <>
                      <p className="tm-pt-banner__question">{found.clarificationQuestion}</p>
                      <p className="tm-pt-quiet">
                        Reply to {providerName} the way you normally reach them. This request stays
                        here until they hear back.
                      </p>
                    </>
                  ) : (
                    <p className="tm-pt-quiet">{requestStatusMeaning(found.status)}</p>
                  )}
                </div>
              </section>

              <section className="tm-pt-card tm-pt-card--lg" aria-labelledby="tm-request-asked">
                <h2 id="tm-request-asked" className="tm-pt-eyebrow">
                  What you asked for
                </h2>
                <p className="tm-pt-card__body tm-pt-card__body--ink">{found.description}</p>
                {found.urgencyReason !== null ? (
                  <>
                    <h3 className="tm-pt-eyebrow">Why the timing mattered</h3>
                    <p className="tm-pt-card__body">{found.urgencyReason}</p>
                  </>
                ) : null}
                <dl className="tm-pt-facts">
                  <div>
                    <dt>Project</dt>
                    <dd>{project?.name ?? 'A project shared with you'}</dd>
                  </div>
                  <div>
                    <dt>Category</dt>
                    <dd>{found.category}</dd>
                  </div>
                </dl>
              </section>

              <section className="tm-pt-card tm-pt-card--lg" aria-labelledby="tm-request-dates">
                <h2 id="tm-request-dates" className="tm-pt-eyebrow">
                  Dates
                </h2>
                <dl className="tm-pt-dates">
                  <div className="tm-pt-date tm-pt-date--dashed">
                    <dt className="tm-pt-eyebrow">You asked for</dt>
                    <dd className="tm-pt-date__value">{describeDesiredDate(found.desiredAt)}</dd>
                  </div>
                  <div className="tm-pt-date">
                    <dt className="tm-pt-eyebrow">{providerName} agreed</dt>
                    <dd className="tm-pt-date__value">{describeCommitment(found)}</dd>
                  </div>
                </dl>
              </section>

              {found.clientVisibleReason !== null ? (
                <section className="tm-pt-card tm-pt-card--lg" aria-labelledby="tm-request-reason">
                  <h2 id="tm-request-reason" className="tm-pt-eyebrow">
                    What {providerName} said
                  </h2>
                  <p className="tm-pt-card__body tm-pt-card__body--ink">
                    {found.clientVisibleReason}
                  </p>
                </section>
              ) : null}

              {found.clientSafeScopeSummary !== null ? (
                <section className="tm-pt-card tm-pt-card--lg" aria-labelledby="tm-request-scope">
                  <h2 id="tm-request-scope" className="tm-pt-eyebrow">
                    What they have agreed to do
                  </h2>
                  <p className="tm-pt-card__body tm-pt-card__body--ink">
                    {found.clientSafeScopeSummary}
                  </p>
                </section>
              ) : null}
            </div>

            <div className="tm-pt-col">
              <section className="tm-pt-card" aria-labelledby="tm-request-journey">
                <h2 id="tm-request-journey" className="tm-pt-eyebrow">
                  How it has moved
                </h2>
                <ol className="tm-pt-steps">
                  <li className="tm-pt-steps__item tm-pt-steps__item--done">
                    <p className="tm-pt-rows__title">You sent it</p>
                    <p className="tm-pt-quiet">{formatDay(found.createdAt)}</p>
                  </li>
                  {found.status !== 'submitted' ? (
                    <li
                      className={
                        waitingOnClient
                          ? 'tm-pt-steps__item tm-pt-steps__item--now'
                          : 'tm-pt-steps__item tm-pt-steps__item--done'
                      }
                    >
                      <p className="tm-pt-rows__title">
                        {journeyLabel(found.status, providerName)}
                      </p>
                      <p className="tm-pt-quiet">{formatDay(found.updatedAt)}</p>
                    </li>
                  ) : null}
                  {found.status === 'withdrawn' || found.status === 'declined' ? null : (
                    <li
                      className={
                        committed
                          ? 'tm-pt-steps__item tm-pt-steps__item--done'
                          : 'tm-pt-steps__item'
                      }
                    >
                      <p className="tm-pt-rows__title">Studio commits a date</p>
                      <p className="tm-pt-quiet">
                        {committed ? formatDay(found.committedAt!) : 'not scheduled yet'}
                      </p>
                    </li>
                  )}
                </ol>
              </section>

              {found.desiredAt !== null && !committed ? (
                <section
                  className="tm-pt-card tm-pt-card--warning"
                  aria-labelledby="tm-request-wish"
                >
                  <h2 id="tm-request-wish" className="tm-pt-eyebrow">
                    About the date you asked for
                  </h2>
                  <p className="tm-pt-quiet">
                    It has not been committed, so treat it as a wish until {providerName} confirms.
                    A date you asked for is never read back to you as a promise.
                  </p>
                </section>
              ) : null}

              <section className="tm-pt-card" aria-labelledby="tm-request-withdraw">
                <h2 id="tm-request-withdraw" className="tm-pt-eyebrow">
                  Take it back
                </h2>
                {found.status === 'withdrawn' ? (
                  <p className="tm-pt-quiet">
                    You withdrew this request. Nothing is expected from anybody.
                  </p>
                ) : found.canWithdraw ? (
                  // Two sentences: from `submitted` nobody has looked yet; from `clarifying`
                  // somebody has — they are the reason this page shows a question.
                  <p className="tm-pt-quiet">
                    {found.status === 'clarifying'
                      ? 'You can still take this back, even with their question open. Withdrawing it is an answer too.'
                      : `You can still take this back — ${providerName} has not started on it.`}
                  </p>
                ) : (
                  // Said rather than merely hidden: a control that vanished without explanation
                  // would read as a fault.
                  <p className="tm-pt-quiet">
                    {providerName} has this request open, so it is no longer yours to take back. Ask
                    them to close it if you no longer need it.
                  </p>
                )}
              </section>
            </div>
          </div>
        ) : null}
      </div>
    </ClientPortalShell>
  );
}

function journeyLabel(status: ClientRequestStatus, providerName: string): string {
  switch (status) {
    case 'clarifying':
      return `${providerName} asked you something`;
    case 'accepted':
      return 'Studio accepted it';
    case 'planned':
      return 'Studio is planning it';
    case 'delivered':
      return 'Studio delivered it';
    case 'deferred':
      return 'Studio set it aside for now';
    case 'declined':
      return 'Studio declined it';
    case 'withdrawn':
      return 'You withdrew it';
    default:
      return 'Studio has it';
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}
