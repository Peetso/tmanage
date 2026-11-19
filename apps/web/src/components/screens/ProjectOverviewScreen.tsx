'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { NavIcon } from '../icons/phone';
import { ProjectExportButton } from '../projects/ProjectExportButton';
import { ProjectUpdateComposer } from '../projects/ProjectUpdateComposer';
import { ActivityTab } from '../overview/ActivityTab';
import { OverviewBlocks } from '../overview/OverviewBlocks';
import { OverviewTabs, type OverviewTab } from '../overview/OverviewTabs';
import { projectOverviewModel } from '../overview/project-overview-model';
import { useOverviewCopy, type OverviewCopy } from '../overview/use-overview-copy';
import { useOverviewFormat } from '../overview/use-overview-format';
import {
  portfolioHref,
  projectFilesHref,
  projectHref,
  projectMilestonesHref,
  projectViewHref,
  projectWorkHref,
  type ProjectView,
} from '../overview/overview-links';
import { browserApiClient } from '../../lib/api/browser-client';
import { getProject } from '../../lib/api/projects';
import { getProjectSummary, type ProjectSummary } from '../../lib/api/project-summary';
import type { ApiClient } from '../../lib/api/client';
import { memberDisplayName } from '../../lib/members-presentation';
import { useMembers } from '../../lib/use-members';
import { useRecordRecentItem } from '../../lib/use-record-recent-item';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { PreviewAsClientLink } from './PreviewAsClientLink';

export interface ProjectOverviewScreenProps {
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  /** The tab from `?view=`; Overview when absent. */
  view?: ProjectView;
  client?: ApiClient;
  /** Injected in tests and stories so "2 days ago" and stale approvals are stable. */
  now?: Date;
}

/** The query key of the one summary read, shared with anything that invalidates the page. */
export function projectSummaryQueryKey(organizationSlug: string, projectId: string) {
  return ['project-summary', organizationSlug, projectId] as const;
}

const COMPOSER_HEADING_ID = 'tm-project-update-composer';

/**
 * **ONEPAGE — the project overview** (Figma 739:40334, AR 739:40873, phone 739:42354 / 739:42808,
 * no finance 739:41403 / 739:41881). One page answers "how is this project doing": delivery,
 * approvals waiting and on whom, risks, latest files, time and money, each block opening its full
 * screen. It is one read (`GET …/projects/:id/summary`, B01); a block the viewer may not read is
 * absent from that read and from the page, with no gap left behind.
 *
 * The header keeps the project's own facts: owner, and committed and forecast as two dates
 * (PROJ-001), never collapsed into one "due". "Post update" opens the update composer under the
 * blocks and moves focus to it.
 */
export function ProjectOverviewScreen({
  organizationSlug,
  organizationName,
  projectId,
  view = 'overview',
  client,
  now: injectedNow,
}: ProjectOverviewScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const tOr = useTOr();
  const copy = useOverviewCopy();
  const [now] = useState(() => injectedNow ?? new Date());
  const format = useOverviewFormat(now);
  const [composing, setComposing] = useState(false);

  // The same key the route's 404 check reads, so this is one request, not two.
  const project = useQuery({
    queryKey: ['project', organizationSlug, projectId],
    queryFn: () => getProject(api, organizationSlug, projectId),
  });
  const summary = useQuery({
    queryKey: projectSummaryQueryKey(organizationSlug, projectId),
    queryFn: () => getProjectSummary(api, organizationSlug, projectId),
  });
  const directory = useMembers(api, organizationSlug);

  useRecordRecentItem({
    organizationSlug,
    objectType: 'project',
    objectId: projectId,
    enabled: project.isSuccess,
    client,
  });

  const name = summary.data?.project.name ?? project.data?.name;
  const owner = project.data
    ? memberDisplayName(project.data.ownerUserId, directory.members, directory.isPending)
    : null;
  const facts = summary.data?.project ?? project.data;
  const meta = [
    owner === null ? null : copy.fill('Overview.ledBy', { name: owner }),
    facts?.committedAt
      ? copy.fill('Overview.dueOn', { date: format.day(facts.committedAt) })
      : null,
    facts?.forecastAt && facts.forecastAt !== facts.committedAt
      ? copy.fill('Overview.forecastOn', { date: format.day(facts.forecastAt) })
      : null,
  ].filter((part): part is string => part !== null);

  const openComposer = () => {
    setComposing(true);
    // After the composer mounts, take the person to it (WCAG 2.4.3).
    requestAnimationFrame(() => document.getElementById(COMPOSER_HEADING_ID)?.focus());
  };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={name ?? t('ProjectOverviewScreen.projectFallback')}
      eyebrow={
        <Link className="tm-ov-back" href={portfolioHref(organizationSlug)}>
          <NavIcon name="back" size={14} />
          {copy.text('Overview.backToProjects')}
        </Link>
      }
      description={meta.length > 0 ? meta.join(' · ') : undefined}
      actions={
        <div className="tm-ov-actions">
          <PreviewAsClientLink
            organizationSlug={organizationSlug}
            projectId={projectId}
            compact={false}
          />
          <ProjectExportButton
            organizationSlug={organizationSlug}
            project={project.data}
            client={api}
          />
          <Button
            tone="ink"
            size="accessible"
            aria-expanded={composing}
            aria-controls={composing ? `${COMPOSER_HEADING_ID}-card` : undefined}
            onClick={openComposer}
          >
            {copy.text('Overview.postUpdate')}
          </Button>
        </div>
      }
    >
      <div className="tm-ov">
        <OverviewTabs
          label={copy.text('Overview.tabsLabel')}
          current={view}
          tabs={projectTabs(organizationSlug, projectId, summary.data, copy, tOr, format.count)}
        />
        {view === 'activity' ? (
          <ActivityTab
            api={api}
            organizationSlug={organizationSlug}
            scope={{ kind: 'project', projectId }}
            now={now}
          />
        ) : summary.isPending ? (
          <OverviewBlocks state="loading" />
        ) : summary.isError ? (
          <OverviewBlocks state="error" onRetry={() => void summary.refetch()} />
        ) : (
          <OverviewBlocks
            state="ready"
            now={now}
            deliveryEmpty="work"
            model={projectOverviewModel(summary.data, organizationSlug, now)}
          />
        )}
        {composing ? (
          <div id={`${COMPOSER_HEADING_ID}-card`}>
            <ProjectUpdateComposer
              api={api}
              organizationSlug={organizationSlug}
              projectId={projectId}
              headingId={COMPOSER_HEADING_ID}
            />
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}

/**
 * The frame's tabs (Overview, Work with its count, Files, Activity) and then the project's other
 * sections, so nothing the old segmented switch reached is lost; every tab is a real route.
 */
function projectTabs(
  org: string,
  projectId: string,
  summary: ProjectSummary | undefined,
  copy: OverviewCopy,
  tOr: (key: string, english: string) => string,
  count: (value: number) => string,
): readonly OverviewTab[] {
  const base = projectHref(org, projectId);
  const open = summary?.delivery?.open;
  return [
    { id: 'overview', label: copy.text('Overview.tabOverview'), href: base },
    {
      id: 'work',
      label: copy.text('Overview.tabWork'),
      href: projectWorkHref(org, projectId),
      ...(open === undefined ? {} : { count: count(open) }),
    },
    { id: 'files', label: copy.text('Overview.tabFiles'), href: projectFilesHref(org, projectId) },
    {
      id: 'activity',
      label: tOr('ActivityTab.tab', 'Activity'),
      href: projectViewHref(org, projectId, 'activity'),
    },
    {
      id: 'milestones',
      label: tOr('ProjectTabs.milestones', 'Milestones'),
      href: projectMilestonesHref(org, projectId),
    },
    { id: 'plan', label: tOr('ProjectTabs.plan', 'Plan'), href: `${base}/baselines` },
    {
      id: 'iterations',
      label: tOr('ProjectTabs.iterations', 'Iterations'),
      href: `${base}/iterations`,
    },
    { id: 'team', label: tOr('ProjectTabs.team', 'Team'), href: `${base}/members` },
    { id: 'risks', label: tOr('ProjectTabs.risks', 'Risks'), href: `${base}/risks` },
    {
      id: 'objectives',
      label: tOr('ProjectTabs.objectives', 'Objectives'),
      href: `${base}/objectives`,
    },
  ];
}
