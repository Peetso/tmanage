'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listClientRequests, listPortalProjects } from '../../lib/api/portal';
import type { ClientRequest, ClientRequestStatus } from '../../lib/api/portal';
import { PORTAL_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import {
  describeCommitment,
  describeDesiredDate,
  requestStatusLabel,
} from '../../lib/client-request-presentation';
import { shortDay, Tag } from './PortalParts';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';

export interface ClientRequestsScreenProps {
  organizationSlug: string;
  /** The client's own name leads the header. `22` §1. */
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **Your requests** — everything the client has asked the studio for (REQ-001).
 *
 * Reached from CL-01 rather than the bar: `22-SCREEN-BY-SCREEN` §1 fixes the client navigation
 * and "Requests" is not one of its destinations, so the overview stays the active capsule. Drawn
 * in the portal's capsule-card language (CL-02): anything the studio is waiting on an answer to
 * leads, outlined in ink, then the newest first. The asked-for date and the agreed date stay on
 * separate phrases so a wish is never read as a commitment.
 */
export function ClientRequestsScreen({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
}: ClientRequestsScreenProps) {
  const describe = useDescribeApiError(PORTAL_LINES);
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();
  const t = useT();

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
  // REQ-06: this list is every request across every shared project, so heading it with just the
  // first project's name is misleading. More than one project reads "All projects"; one keeps its
  // name.
  const projectCount = (projects.data ?? []).length;
  const requestsEyebrow =
    projectCount > 1
      ? t('ClientRequestsScreen.yourRequestsAll')
      : project
        ? `${t('ClientRequestsScreen.yourRequestsProjectPrefix')}${project.name}`
        : t('ClientRequestsScreen.yourRequests');

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="overview"
      title={t('ClientRequestsScreen.title')}
      eyebrow={requestsEyebrow}
      headerAside={
        // A link that looks like a button: going somewhere is an anchor, so middle-click and
        // open-in-new-tab keep working.
        <Link
          href={`/${organizationSlug}/portal/requests/new`}
          className="tm-pt-btn tm-pt-btn--ink"
        >
          {t('ClientRequestsScreen.askForSomething')}
        </Link>
      }
    >
      <div className="tm-pt tm-pt--compact">
        {requests.isError ? (
          <InlineAlert tone="danger" title={t('ClientRequestsScreen.loadError')} live>
            {describe(requests.error)}
          </InlineAlert>
        ) : null}

        {requests.isPending ? (
          <LoadingRegion label={t('ClientRequestsScreen.loadingLabel')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!requests.isPending && !requests.isError && ordered.length === 0 ? (
          <div className="tm-pt-card tm-pt-card--dashed tm-pt-card--lg">
            <h2 className="tm-pt-card__title">{t('ClientRequestsScreen.emptyTitle')}</h2>
            <p className="tm-pt-card__body">
              {t('ClientRequestsScreen.emptyBefore')}
              {providerName}
              {t('ClientRequestsScreen.emptyAfter')}
            </p>
          </div>
        ) : null}

        {ordered.length > 0 ? (
          <ul className="tm-pt-list" aria-label={t('ClientRequestsScreen.yourRequests')}>
            {ordered.map((request) => {
              const waiting = request.status === 'clarifying';
              return (
                <li
                  key={request.id}
                  className={waiting ? 'tm-pt-action tm-pt-action--lead' : 'tm-pt-action'}
                >
                  <span className="tm-pt-action__orb" aria-hidden="true">
                    {STATUS_GLYPH[request.status] ?? '·'}
                  </span>
                  <div className="tm-pt-action__body">
                    <div className="tm-pt-action__meta">
                      <Tag tone={waiting ? 'lime' : toneFor(request.status)}>
                        {requestStatusLabel(request.status)}
                      </Tag>
                      <span className="tm-pt-mono">
                        {t('ClientRequestsScreen.sentPrefix')}
                        {shortDay(request.createdAt)}
                      </span>
                    </div>
                    <h2 className="tm-pt-action__title">
                      <Link href={`/${organizationSlug}/portal/requests/${request.id}`}>
                        {request.title}
                      </Link>
                    </h2>
                    <p className="tm-pt-action__text">
                      {describeDesiredDate(request.desiredAt)} · {describeCommitment(request)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </ClientPortalShell>
  );
}

const STATUS_GLYPH: Partial<Record<ClientRequestStatus, string>> = {
  submitted: '→',
  clarifying: '?',
  accepted: '✓',
  planned: '▸',
  delivered: '✓',
  deferred: '…',
  declined: '×',
  withdrawn: '–',
};

function toneFor(status: ClientRequestStatus): 'done' | 'danger' | undefined {
  if (status === 'accepted' || status === 'delivered') return 'done';
  if (status === 'declined') return 'danger';
  return undefined;
}

/** Anything the studio is waiting on first, then the newest. */
function byAttentionThenAge(left: ClientRequest, right: ClientRequest): number {
  const leftWaiting = left.status === 'clarifying' ? 0 : 1;
  const rightWaiting = right.status === 'clarifying' ? 0 : 1;
  if (leftWaiting !== rightWaiting) return leftWaiting - rightWaiting;
  if (left.createdAt === right.createdAt) return 0;
  return left.createdAt < right.createdAt ? 1 : -1;
}
