'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, Skeleton, StateCapsule } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  DEFAULT_PORTAL_INBOX_PAGE,
  listPortalInbox,
  listPortalProjects,
  markPortalBundleRead,
} from '../../lib/api/portal';
import type { PortalInboxBundle, PortalInboxMode } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import {
  formatDay,
  requestStatusCapsule,
  requestStatusLabel,
} from '../../lib/client-request-presentation';

export interface ClientInboxScreenProps {
  organizationSlug: string;
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * The client's inbox — INBOX-001's second half, on the portal.
 *
 * ## This screen has no ID, and that is a divergence rather than an invention
 *
 * `22-SCREEN-BY-SCREEN` §6 gives the client `CL-08 Updates` — "published status updates and
 * decisions", a feed the studio writes — and no inbox. `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX`
 * §4's `IN-01` through `IN-07` are the internal inbox. But NOTIF-001 writes a row to the
 * client who submitted a request every time the studio answers it, and until this screen
 * those rows had no reader. So the page exists, at `/portal/inbox`, reached from `CL-01`;
 * **`CLIENT_NAVIGATION` was not touched**, for the reason `ClientRequestsScreen` gives — a
 * rail item §1 does not list would be a destination this codebase invented. The divergence is
 * recorded in `docs/implementation-status.md`.
 *
 * ## What a row says
 *
 * One row per request, with the title and the client-safe status the API read through the
 * portal's own path at the moment of the request — the same words `CL-06` uses, and never an
 * internal state. Each row links to the request. The API dropped, before answering, any row
 * about a request this client may no longer see; the screen has no way to ask for them.
 *
 * ## Two modes, one action
 *
 * `All` and `Unread` are the API's two queries, not a filter over the page. "Mark read" posts
 * the bundle id and asks the list again, as `TM-04` does: the API reauthorizes before it
 * writes, and the screen has no way to know what it decided except by reading.
 */
export function ClientInboxScreen({
  organizationSlug,
  clientName,
  providerName,
  client,
}: ClientInboxScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<PortalInboxMode>('all');

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const inbox = useInfiniteQuery({
    queryKey: ['portal-inbox', organizationSlug, mode],
    queryFn: ({ pageParam }) =>
      listPortalInbox(api, organizationSlug, {
        mode,
        limit: DEFAULT_PORTAL_INBOX_PAGE,
        ...(pageParam === undefined ? {} : { before: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const markRead = useMutation({
    mutationFn: (bundleId: string) => markPortalBundleRead(api, organizationSlug, bundleId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['portal-inbox', organizationSlug] }),
  });

  const bundles = mergePages(inbox.data?.pages.map((page) => page.items) ?? []);
  const project = projects.data?.[0];

  const selectMode = (next: PortalInboxMode) => {
    markRead.reset();
    setMode(next);
  };

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      {...(project ? { projectName: project.name } : {})}
      activeNavigationId="overview"
      title="What has changed"
      description={`Each time ${providerName} answers one of your requests, it appears here.`}
    >
      {inbox.isError ? (
        <InlineAlert tone="danger" title="Could not load your notifications" live>
          {describe(inbox.error)}
        </InlineAlert>
      ) : null}

      {markRead.isError ? (
        <InlineAlert tone="danger" title="Could not mark that read" live>
          {describe(markRead.error)}
        </InlineAlert>
      ) : null}

      <section className="tm-panel tm-stack" aria-labelledby="tm-portal-inbox-modes">
        <h2 id="tm-portal-inbox-modes" className="tm-eyebrow">
          Show
        </h2>
        <div className="tm-row tm-row--wrap" role="group" aria-label="Notification mode">
          {MODES.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className={[
                'tm-button',
                'tm-button--outline',
                mode === candidate.id ? 'is-active' : '',
              ]
                .join(' ')
                .trim()}
              aria-pressed={mode === candidate.id}
              onClick={() => selectMode(candidate.id)}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      </section>

      {inbox.isPending ? (
        <div aria-busy="true" aria-live="polite">
          <span className="tm-visually-hidden">Loading your notifications.</span>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </div>
      ) : null}

      {/* "Nothing" only once the API has said it: a page can be short while a cursor remains. */}
      {!inbox.isPending && !inbox.isError && bundles.length === 0 && !inbox.hasNextPage ? (
        <InlineAlert tone="neutral" title={EMPTY_TITLES[mode]}>
          <p className="tm-prose">{EMPTY_BODIES[mode].replace('{provider}', providerName)}</p>
        </InlineAlert>
      ) : null}

      {!inbox.isPending && !inbox.isError && bundles.length === 0 && inbox.hasNextPage ? (
        <p className="tm-prose">Nothing you can still see on this page. There are older pages.</p>
      ) : null}

      {bundles.length > 0 ? (
        <ul className="tm-stack tm-list" aria-label="Your notifications">
          {bundles.map((bundle) => (
            <li key={bundle.bundleId} className="tm-panel tm-stack tm-stack--tight">
              <div className="tm-row tm-row--wrap">
                <StateCapsule state={requestStatusCapsule(bundle.status)}>
                  {requestStatusLabel(bundle.status)}
                </StateCapsule>
                {bundle.unreadCount > 0 ? (
                  <span className="tm-field__hint">
                    {bundle.unreadCount} unread of {bundle.count}
                  </span>
                ) : (
                  <span className="tm-field__hint">
                    {bundle.count} {bundle.count === 1 ? 'update' : 'updates'}
                  </span>
                )}
              </div>
              <p className="tm-prose">
                <Link href={`/${organizationSlug}/portal/requests/${bundle.requestId}`}>
                  <strong>{bundle.title}</strong>
                </Link>
              </p>
              <p className="tm-field__hint">
                {describeWhy(bundle, providerName)} · Latest {formatDay(bundle.latestAt)}
              </p>
              {bundle.unreadCount > 0 ? (
                <div className="tm-row">
                  <Button
                    tone="outline"
                    size="accessible"
                    loading={markRead.isPending && markRead.variables === bundle.bundleId}
                    loadingLabel="Marking read"
                    aria-label={`Mark read: ${bundle.title}`}
                    onClick={() => markRead.mutate(bundle.bundleId)}
                  >
                    Mark read
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {inbox.hasNextPage ? (
        <div className="tm-row">
          <Button
            tone="outline"
            size="accessible"
            loading={inbox.isFetchingNextPage}
            loadingLabel="Loading more"
            onClick={() => void inbox.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </ClientPortalShell>
  );
}

const MODES: readonly { readonly id: PortalInboxMode; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
];

const EMPTY_TITLES: Record<PortalInboxMode, string> = {
  all: 'Nothing has changed yet',
  unread: 'Nothing is unread',
};

const EMPTY_BODIES: Record<PortalInboxMode, string> = {
  all: 'When {provider} answers one of your requests — a question back, a date, a decision — it shows up here.',
  unread: 'You have seen everything that reached you.',
};

/** The one event type the portal is told about, said in words. Unknown types are shown as is. */
const WHY: Record<string, string> = {
  'client_request.transitioned.v1': '{provider} answered',
};

function describeWhy(bundle: PortalInboxBundle, providerName: string): string {
  return bundle.types
    .map((type) => (WHY[type] ?? type).replace('{provider}', providerName))
    .join(', ');
}

/**
 * The API bundles one page at a time, so a request whose rows straddle a page boundary
 * arrives twice. Folded here as `TM-04` folds: counts add, unread counts add, types union,
 * the newest time wins, and the row keeps the place of its first appearance.
 */
function mergePages(
  pages: readonly (readonly PortalInboxBundle[])[],
): readonly PortalInboxBundle[] {
  const byId = new Map<string, PortalInboxBundle>();
  for (const page of pages) {
    for (const bundle of page) {
      const seen = byId.get(bundle.bundleId);
      if (!seen) {
        byId.set(bundle.bundleId, bundle);
        continue;
      }
      const types = [...seen.types];
      for (const type of bundle.types) if (!types.includes(type)) types.push(type);
      byId.set(bundle.bundleId, {
        ...seen,
        count: seen.count + bundle.count,
        unreadCount: seen.unreadCount + bundle.unreadCount,
        types,
        latestAt: seen.latestAt >= bundle.latestAt ? seen.latestAt : bundle.latestAt,
      });
    }
  }
  return [...byId.values()];
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}
