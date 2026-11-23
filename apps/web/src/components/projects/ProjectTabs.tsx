'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/projects.css';

export type ProjectTabId =
  | 'overview'
  | 'plan'
  | 'milestones'
  | 'work'
  | 'iterations'
  | 'team'
  | 'risks'
  | 'objectives'
  // W-WEB-5: the project's stages (its own set or the workspace's; Figma W8).
  | 'stages';

export interface ProjectTabsProps {
  organizationSlug: string;
  /** Omitted on the organization-level project pages (tags, templates): only the back capsule. */
  projectId?: string;
  /** The tab that is current, if the page is one of them. */
  current?: ProjectTabId;
  /** The trailing actions of the row (PRJ-01's "Post update"). */
  end?: ReactNode;
}

/**
 * PRJ-01 / PRJ-02 top row: the "← Portfolio" capsule, the project's segmented section switch and
 * the screen's trailing actions. Every tab is a real route; the design's "Story" and "Settings"
 * tabs have no route yet, so they are not drawn rather than drawn as dead links.
 */
export function ProjectTabs({ organizationSlug, projectId, current, end }: ProjectTabsProps) {
  const t = useT();
  const tOr = useTOr();
  const base = `/${organizationSlug}/projects/${encodeURIComponent(projectId ?? '')}`;
  const tabs: readonly { id: ProjectTabId; label: string; href: string }[] = [
    { id: 'overview', label: t('ProjectTabs.overview'), href: base },
    { id: 'plan', label: t('ProjectTabs.plan'), href: `${base}/baselines` },
    // A9: the project's milestones list.
    {
      id: 'milestones',
      label: tOr('ProjectTabs.milestones', 'Milestones'),
      href: `${base}/milestones`,
    },
    {
      id: 'work',
      label: t('ProjectTabs.work'),
      href: `/${organizationSlug}/work?project=${encodeURIComponent(projectId ?? '')}`,
    },
    // 53-21: the project's iterations (light sprints).
    {
      id: 'iterations',
      label: tOr('ProjectTabs.iterations', 'Iterations'),
      href: `${base}/iterations`,
    },
    { id: 'team', label: t('ProjectTabs.team'), href: `${base}/members` },
    { id: 'risks', label: t('ProjectTabs.risks'), href: `${base}/risks` },
    { id: 'objectives', label: t('ProjectTabs.objectives'), href: `${base}/objectives` },
    { id: 'stages', label: t('ProjectTabs.stages'), href: `${base}/stages` },
  ];

  return (
    <div className="tm-prj-tabs">
      <Link className="tm-prj-tabs__back" href={`/${organizationSlug}/projects/portfolio`}>
        <span className="tm-prj-tabs__back-orb" aria-hidden="true">
          ←
        </span>
        {t('ProjectTabs.portfolio')}
      </Link>
      {projectId !== undefined ? (
        <nav className="tm-segmented tm-prj-tabs__nav" aria-label={t('ProjectTabs.sectionsLabel')}>
          {tabs.map((tab) => (
            <Link
              key={tab.id}
              href={tab.href}
              {...(tab.id === current ? { 'aria-current': 'page' as const } : {})}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      ) : null}
      {end ? <div className="tm-prj-tabs__end">{end}</div> : null}
    </div>
  );
}

/** Two-letter initials for an avatar disc. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '·';
}
