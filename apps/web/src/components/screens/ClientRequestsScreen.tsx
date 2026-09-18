'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listClientRequests, listPortalProjects } from '../../lib/api/portal';
import type { ClientRequest } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import {
  describeCommitment,
  describeDesiredDate,
  formatDay,
  requestStatusCapsule,
  requestStatusLabel,
} from '../../lib/client-request-presentation';

export interface ClientRequestsScreenProps {
  organizationSlug: string;
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * Everything this client organization has asked for.
 *
 * ## This screen has no ID, and that is a divergence rather than an invention
 *
 * `22-SCREEN-BY-SCREEN` §6 gives `CL-06 New request / request detail` and no list.
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §9 splits the same thing into `CL-09 New request` and
 * `CL-10 Request detail`, and also has no list. But the design artifact for both draws a
 * breadcrumb reading **"Requests · New request"**, which is a section neither document's
 * navigation contains: `22` §1 fixes the client rail as "Overview, My Actions, Deliverables,
 * Timeline, Updates, Files, People".
 *
 * So this page exists — a client with four requests has to be able to find the third one — and
 * **`CLIENT_NAVIGATION` was not touched**, because a rail item that §1 does not list would be a
 * destination this codebase invented. It is reached from `CL-01 Overview` and from
 * `CL-02 My Actions`. The divergence is recorded in `docs/implementation-status.md` rather than
 * resolved by picking whichever document was more convenient.
 *
 * ## Ordering
 *
 * Requests waiting on the client first, then everything else newest-first. That is the same
 * rule `CL-02` applies to actions and for the same reason: the only ordering this screen can
 * honestly apply is one the reader can verify from what is on the card.
 */
export function ClientRequestsScreen({
  organizationSlug,
  clientName,
  providerName,
  client,
}: ClientRequestsScreenProps) {
  const api = client ?? browserApiClient();

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const requests = useQuery({
    queryKey: ['portal-requests', organizationSlug],
    queryFn: () => listClientRequests(api, organizationSlug),
  });

  const ordered = (requests.data ?? []).slice().sort(byAttentionThenAge);
  const project = projects.data?.[0];

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      {...(project ? { projectName: project.name } : {})}
      activeNavigationId="overview"
      title="Your requests"
      description={`Everything you have asked ${providerName} for.`}
    >
      {requests.isError ? (
        <InlineAlert tone="danger" title="Could not load your requests" live>
          {describe(requests.error)}
        </InlineAlert>
      ) : null}

      {requests.isPending ? (
        <LoadingRegion label="Loading your requests.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      <div className="tm-row">
        {/*
          A link that looks like a button, not a button that navigates. `ProjectOverviewScreen`
          does the same: going somewhere is an anchor, so middle-click, open-in-new-tab and the
          browser's own affordances keep working.
        */}
        <Link
          href={`/${organizationSlug}/portal/requests/new`}
          className="tm-button tm-button--ink tm-button--accessible"
        >
          Ask for something
        </Link>
      </div>

      {!requests.isPending && !requests.isError && ordered.length === 0 ? (
        <InlineAlert tone="neutral" title="You have not asked for anything yet">
          <p className="tm-prose">
            When you need something from {providerName}, ask here. They read it, ask you anything
            unclear, and then either agree a date or tell you why not — and whichever it is appears
            on this page.
          </p>
        </InlineAlert>
      ) : null}

      {ordered.length > 0 ? (
        <ul className="tm-stack tm-list" aria-label="Your requests">
          {ordered.map((request) => (
            <li key={request.id} className="tm-panel tm-stack tm-stack--tight">
              <div className="tm-row tm-row--wrap">
                <StateCapsule state={requestStatusCapsule(request.status)}>
                  {requestStatusLabel(request.status)}
                </StateCapsule>
              </div>
              <p className="tm-prose">
                <Link href={`/${organizationSlug}/portal/requests/${request.id}`}>
                  <strong>{request.title}</strong>
                </Link>
              </p>
              <p className="tm-prose">
                {describeDesiredDate(request.desiredAt)} · {describeCommitment(request)}
              </p>
              <p className="tm-field__hint">Sent {formatDay(request.createdAt)}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </ClientPortalShell>
  );
}

/**
 * Anything the studio is waiting on the client for, first; then newest first.
 *
 * `clarifying` is the only status where the request is the client's to move, so it is the only
 * one that earns the top of the list. Everything below it is history in the order it happened.
 */
function byAttentionThenAge(left: ClientRequest, right: ClientRequest): number {
  const leftWaiting = left.status === 'clarifying' ? 0 : 1;
  const rightWaiting = right.status === 'clarifying' ? 0 : 1;
  if (leftWaiting !== rightWaiting) return leftWaiting - rightWaiting;
  if (left.createdAt === right.createdAt) return 0;
  return left.createdAt < right.createdAt ? 1 : -1;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}
