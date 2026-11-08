'use client';

import Link from 'next/link';
import { AppShell } from '../shell/AppShell';
import './work-core.css';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { WorkItemDependenciesScreen } from './WorkItemDependenciesScreen';

export interface WorkItemLinksScreenProps {
  organizationSlug: string;
  organizationName: string;
  workItemId: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Work item links (56-07; Figma 575:32674 EN, 575:32881 AR).**
 *
 * Link this item to another one as *blocks*, *blocked by* or *relates to*, see the links with the
 * other item's state, open it, or remove a link. The panel is the x204 one, on the existing
 * `…/work-items/:workItemId/links` API; this screen gives it a page beside activity, time and
 * estimate. Self-links, duplicates and blocking loops are refused by the server and said plainly.
 */
export function WorkItemLinksScreen({
  organizationSlug,
  organizationName,
  workItemId,
  client,
}: WorkItemLinksScreenProps) {
  const t = useT();
  const tr = useTOr();
  const api = client ?? browserApiClient();
  const base = `/${organizationSlug}/work/${workItemId}`;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      eyebrow={t('WorkItemActivityFeed.eyebrow')}
      title={tr('WorkItemLinks.title', 'Links')}
    >
      <div className="tm-wk-page tm-stack">
        <nav
          className="tm-segmented tm-wk-subnav"
          aria-label={t('WorkItemActivityFeed.subnavLabel')}
        >
          <Link href={base}>{t('WorkItemActivityFeed.overview')}</Link>
          <Link href={`${base}/activity`}>{t('WorkItemActivityFeed.activity')}</Link>
          <Link href={`${base}/links`} aria-current="page">
            {tr('WorkItemLinks.tab', 'Links')}
          </Link>
          <Link href={`${base}/time-logs`}>{t('WorkItemActivityFeed.time')}</Link>
          <Link href={`${base}/estimate`}>{t('WorkItemActivityFeed.estimate')}</Link>
        </nav>
        <WorkItemDependenciesScreen
          organizationSlug={organizationSlug}
          workItemId={workItemId}
          api={api}
        />
      </div>
    </AppShell>
  );
}
