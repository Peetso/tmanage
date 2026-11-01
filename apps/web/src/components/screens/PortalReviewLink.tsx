'use client';

import Link from 'next/link';
import { useT } from '../../lib/i18n/use-t';
import './portal-review.css';

/** The portal path of the viewer for one file — the "Review" buttons link here (R4 slice 8). */
export function portalFileViewerHref(
  organizationSlug: string,
  fileId: string,
  deliverableVersionId?: string,
): string {
  const query = deliverableVersionId
    ? `?deliverableVersionId=${encodeURIComponent(deliverableVersionId)}`
    : '';
  return `/${organizationSlug}/portal/files/${encodeURIComponent(fileId)}${query}`;
}

export interface PortalReviewLinkProps {
  readonly organizationSlug: string;
  readonly fileId: string;
  readonly fileName: string;
  readonly openComments: number;
  readonly deliverableVersionId?: string;
  /** False where a table shows the count in its own Comments column. */
  readonly showCount?: boolean;
}

/**
 * V-44 — the "Review" button on a portal file row, with the open-comment count beside it. A row
 * with comments waiting is the one that needs the client, so its button is lime; others outline.
 */
export function PortalReviewLink({
  organizationSlug,
  fileId,
  fileName,
  openComments,
  deliverableVersionId,
  showCount = true,
}: PortalReviewLinkProps) {
  const t = useT();
  return (
    <span className="tm-pt-review">
      {showCount ? <PortalOpenComments openComments={openComments} /> : null}
      <Link
        className={openComments > 0 ? 'tm-pt-btn tm-pt-btn--lime' : 'tm-pt-btn'}
        href={portalFileViewerHref(organizationSlug, fileId, deliverableVersionId)}
        aria-label={t('Viewer.portal.reviewFile').replace('{name}', fileName)}
      >
        {t('Viewer.portal.review')}
      </Link>
    </span>
  );
}

/** "3 open" / "None open" — a file's open comments as the portal lists them. */
export function PortalOpenComments({ openComments }: { readonly openComments: number }) {
  const t = useT();
  return (
    <span className="tm-pt-review__count" data-open={openComments > 0 ? 'true' : undefined}>
      {openComments > 0
        ? t('Viewer.portal.openComments').replace('{count}', String(openComments))
        : t('Viewer.portal.noComments')}
    </span>
  );
}
