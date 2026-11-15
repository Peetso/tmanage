'use client';

import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import { listPortalDeliverableFiles } from '../../lib/api/portal';
import { useT } from '../../lib/i18n/use-t';
import { usePortalPreview } from '../../lib/portal-preview';
import { PreviewThumb } from '../viewer/PreviewThumb';

export interface PortalDeliverablePreviewProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly deliverableId: string;
  /** The open approval page's large stage; the deliverable card otherwise. */
  readonly tall?: boolean;
}

/**
 * Live P0 (deploy 38bab83c): the picture of a shared deliverable in the client portal. The card
 * and the open page drew a fixed "nothing to show yet" box whatever was shared. This draws the
 * first file the client can review, through the portal preview route (`…/portal/files/:id/preview`,
 * which only answers for files shared with the caller) — or, in the team's "Preview as client",
 * the studio route the portal viewer also uses there (a team member is refused at the client's) —
 * and keeps the empty box only while there is no file or its preview is not drawn yet. The files read shares its cache entry with the
 * card's file list and the page's Review list.
 */
export function PortalDeliverablePreview({
  api,
  organizationSlug,
  deliverableId,
  tall = false,
}: PortalDeliverablePreviewProps) {
  const t = useT();
  const preview = usePortalPreview(organizationSlug);
  const files = useQuery({
    queryKey: ['portal-deliverable-files', organizationSlug, deliverableId],
    queryFn: () => listPortalDeliverableFiles(api, organizationSlug, deliverableId),
  });
  const shown = files.data?.find((file) => file.reviewable);
  const box = tall ? 'tm-pt-preview tm-pt-preview--tall' : 'tm-pt-preview';
  const empty = <>{t('ClientApprovalScreen.nothingToShow')}</>;

  if (!shown) {
    return (
      <div className={box} aria-hidden="true">
        {empty}
      </div>
    );
  }

  return (
    <div className={`${box} tm-pt-preview--media`}>
      <PreviewThumb
        api={api}
        organizationSlug={organizationSlug}
        fileAssetId={shown.id}
        door={preview ? 'studio' : 'portal'}
        size={tall ? 'page' : 'thumb'}
        fallback={empty}
        className="tm-pt-preview__media"
      />
    </div>
  );
}
