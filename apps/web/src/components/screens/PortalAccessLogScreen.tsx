'use client';

import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPortalAccessLog, MAX_PORTAL_ACCESS_PAGE } from '../../lib/api/portal-access-log';
import type {
  PortalAccessLogEvent,
  PortalAccessResourceKind,
} from '../../lib/api/portal-access-log';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { appLocale } from '../../lib/i18n/app-locale';

export interface PortalAccessLogScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The project whose portal access log this screen shows — from the `[projectId]` route segment. */
  projectId: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const RESOURCE_LABELS: Readonly<Record<PortalAccessResourceKind, string>> = {
  project: 'Project',
  work_item: 'Work item',
  deliverable: 'Deliverable',
  deliverable_file: 'Deliverable file',
  update: 'Update',
};

/**
 * **Portal access log** — the internal audit view of what a client accessed (SEC / Client portal,
 * module 13, x237). Reads `GET /v1/organizations/:orgSlug/projects/:projectId/portal-access-log`,
 * which is gated on `project.manage`.
 *
 * Three decisions worth stating:
 *
 * 1. **Authorization is the API's.** The read sits behind `project.manage`; a member without it
 *    gets the ordinary 403, which `describe()` turns into a sentence. The screen never guesses a
 *    capability of its own and never renders blank on a refusal.
 * 2. **This is internal, never a client surface.** It shows the studio which client member looked at
 *    which project resource and when. A client cannot reach it — there is no `/portal` route to the
 *    log — and the projection carries nothing sensitive: a fixed resource kind and an instant.
 * 3. **Keyset pagination, not offset.** "Load more" carries the oldest loaded id as the cursor, so a
 *    page boundary can never repeat or skip a row; a full page (`MAX_PORTAL_ACCESS_PAGE`) is the
 *    only signal that more may exist.
 */
export function PortalAccessLogScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: PortalAccessLogScreenProps) {
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();

  const events = useInfiniteQuery({
    queryKey: ['portal-access-log', organizationSlug, projectId],
    queryFn: ({ pageParam }) =>
      listPortalAccessLog(api, organizationSlug, projectId, {
        limit: MAX_PORTAL_ACCESS_PAGE,
        ...(pageParam === undefined ? {} : { before: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length === MAX_PORTAL_ACCESS_PAGE ? lastPage[lastPage.length - 1]?.id : undefined,
  });

  const rows = useMemo(() => events.data?.pages.flat() ?? [], [events.data]);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={t('PortalAccessLogScreen.title')}
      description={t('PortalAccessLogScreen.description')}
      eyebrow={t('PortalAccessLogScreen.eyebrow')}
      topBar={<ProjectTabs organizationSlug={organizationSlug} projectId={projectId} />}
    >
      <div className="tm-prj tm-prj--sub">
        {events.isPending ? (
          <LoadingRegion
            label={t('PortalAccessLogScreen.loading')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {events.isError ? (
          <InlineAlert tone="danger" title={t('PortalAccessLogScreen.loadErrorTitle')} live>
            {describe(events.error)}
          </InlineAlert>
        ) : null}

        {!events.isPending && !events.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral">{t('PortalAccessLogScreen.empty')}</InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <section className="tm-card tm-prj-card" aria-labelledby="tm-portal-access-heading">
            <h2 id="tm-portal-access-heading" className="tm-prj-eyebrow">
              {t('PortalAccessLogScreen.accessEventsHeading')}
            </h2>
            <table className="tm-table" aria-label={t('PortalAccessLogScreen.tableLabel')}>
              <thead>
                <tr>
                  <th scope="col">{t('PortalAccessLogScreen.thWhen')}</th>
                  <th scope="col">{t('PortalAccessLogScreen.thClientMember')}</th>
                  <th scope="col">{t('PortalAccessLogScreen.thResource')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((event) => (
                  <AccessRow key={event.id} event={event} />
                ))}
              </tbody>
            </table>

            {events.hasNextPage ? (
              <div>
                <Button
                  type="button"
                  tone="outline"
                  size="compact"
                  onClick={() => void events.fetchNextPage()}
                  disabled={events.isFetchingNextPage}
                >
                  {events.isFetchingNextPage
                    ? t('PortalAccessLogScreen.loadingMore')
                    : t('PortalAccessLogScreen.loadMore')}
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}

function AccessRow({ event }: { event: PortalAccessLogEvent }) {
  return (
    <tr>
      <td className="tm-mono">{formatMoment(event.accessedAt)}</td>
      <td className="tm-mono">{event.clientMemberId}</td>
      <td>{RESOURCE_LABELS[event.resourceKind]}</td>
    </tr>
  );
}

/**
 * Format an ISO timestamp for display, following the browser's locale. An unparseable value is shown
 * verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(appLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    at,
  );
}
