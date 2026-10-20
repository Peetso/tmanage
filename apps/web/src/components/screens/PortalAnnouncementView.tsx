'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPortalAnnouncements } from '../../lib/api/portal-announcements';
import type { ClientPortalAnnouncement } from '../../lib/api/portal-announcements';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

export interface PortalAnnouncementViewProps {
  organizationSlug: string;
  /** The client's own client-organization id — the path the portal read names (x304). */
  clientId: string;
  /** The client's own name leads the header. `22` §POR. */
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **Portal announcements (x304)** — the pinned-banner region of the client portal home.
 *
 * The API returns only the banners active *now* for this client, newest window first, and the
 * projection carries no author — so this screen renders what it is given without deciding visibility.
 * A 404 from the endpoint means "not your client" (which cannot happen for the client's own id); an
 * empty list is drawn as nothing, because a banner region with no banners should be silent, not a
 * standing heading over empty space.
 */
export function PortalAnnouncementView({
  organizationSlug,
  clientId,
  clientName,
  providerName,
  client,
}: PortalAnnouncementViewProps) {
  const api = client ?? browserApiClient();
  const t = useT();

  const announcements = useQuery({
    queryKey: ['portal-announcements', organizationSlug, clientId],
    queryFn: () => listPortalAnnouncements(api, organizationSlug, clientId),
  });

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="home"
      title={t('PortalAnnouncementView.title')}
      description={t('PortalAnnouncementView.description')}
    >
      {announcements.isError ? (
        <InlineAlert tone="danger" title={t('PortalAnnouncementView.loadErrorTitle')} live>
          {describe(announcements.error)}
        </InlineAlert>
      ) : announcements.isPending ? (
        <LoadingRegion label={t('PortalAnnouncementView.loading')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : (
        <AnnouncementBanners announcements={announcements.data ?? []} />
      )}
    </ClientPortalShell>
  );
}

function AnnouncementBanners({
  announcements,
}: {
  announcements: readonly ClientPortalAnnouncement[];
}) {
  const t = useT();
  if (announcements.length === 0) return null;
  return (
    <section className="tm-stack" aria-label={t('PortalAnnouncementView.announcementsLabel')}>
      {announcements.map((announcement) => (
        <InlineAlert key={announcement.id} tone="neutral" title={announcement.title}>
          <p className="tm-prose">{announcement.body}</p>
          <p className="tm-field__hint">{describeWindow(announcement)}</p>
        </InlineAlert>
      ))}
    </section>
  );
}

function describeWindow(announcement: ClientPortalAnnouncement): string {
  const start = formatDate(announcement.startsAt);
  if (announcement.endsAt === null) return `Posted ${start}`;
  return `Posted ${start} · until ${formatDate(announcement.endsAt)}`;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(parsed);
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}
