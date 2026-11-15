'use client';

import Link from 'next/link';
import { useTOr } from '../../lib/i18n/use-t-or';
import { HelpTip } from '../help/HelpTip';
import { PORTAL_PROJECT_PARAM } from '../shell/PortalProjectSwitcher';

export interface PreviewAsClientLinkProps {
  readonly organizationSlug: string;
  /** Open the portal on this project (the portal's own project switcher otherwise). */
  readonly projectId?: string;
  readonly compact?: boolean;
}

/**
 * UX-1 (live UX test 69836a13, O-P1-6): the team's way into the client preview of the portal,
 * which was reachable only by typing its address. It opens `/:org/portal` — the page a client
 * sees, with the staff preview banner — so a person can check what a share reached. Navigation
 * only: the portal's API decides what the preview shows.
 */
export function PreviewAsClientLink({
  organizationSlug,
  projectId,
  compact = true,
}: PreviewAsClientLinkProps) {
  const tOr = useTOr();
  const href =
    projectId === undefined
      ? `/${organizationSlug}/portal`
      : `/${organizationSlug}/portal?${PORTAL_PROJECT_PARAM}=${encodeURIComponent(projectId)}`;
  return (
    <HelpTip
      tip={tOr(
        'PreviewAsClient.tip',
        'Open the client portal the way your client sees it. Nothing you do there is sent to them.',
      )}
    >
      <Link
        className={`tm-button tm-button--outline ${compact ? 'tm-button--compact' : 'tm-button--accessible'}`}
        href={href}
      >
        {tOr('PreviewAsClient.label', 'Preview as client')}
      </Link>
    </HelpTip>
  );
}
