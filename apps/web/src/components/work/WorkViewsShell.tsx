'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '../shell/AppShell';
import { useCanCreateProjects } from '../projects/NewProjectLink';
import { WorkViewSwitcher, type WorkView } from '../views/WorkViewSwitcher';
import { OPEN_COMMAND_PALETTE_EVENT } from '../screens/CommandPalette';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { listTeams } from '../../lib/api/people-teams';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { withNumerals } from '../../lib/i18n/display-format';
import { appLocale } from '../../lib/i18n/app-locale';
import { useA6T } from './DueDatePicker';
import { HelpTip } from '../help/HelpTip';
import { SearchIcon } from './work-icons';
import {
  NO_FILTERS,
  RAIL_VIEWS,
  activeRailView,
  railViewFilters,
  workListQuery,
  type RailCounts,
  type RailView,
  type WorkListFilters,
} from './list/work-list-model';
import '../screens/work-core.css';
import './work-views-shell.css';
import './list/work-list.css';

/**
 * FIX2 item 3 (Peter, 2026-11-09): every Work view is drawn in one shell, so List, Board,
 * Timeline, Calendar and Workload share the same rail, header and view bar.
 *
 * Work area v2 (W-WEB-2, Figma `WV2-01` `930:95062`):
 *  - the header: "Work", its count line, the search field and the one lime "New work";
 *  - the context rail: Views (All work · My work · Due this week · Waiting for review), Projects,
 *    Teams and More (Requests · Saved views · Time logs), each with its count where the list
 *    knows it;
 *  - one row under the header: the five view capsules at the start and the view's own controls
 *    (the list's five filters) at the end.
 */

export const RAIL_VIEW_KEY: Readonly<Record<RailView, string>> = {
  all: 'WorkListScreen.viewAllWork',
  mine: 'WorkListScreen.viewMine',
  week: 'WorkListScreen.viewDueWeek',
  review: 'WorkListScreen.viewWaitingReview',
};

export function teamsKey(organizationSlug: string) {
  return ['people-teams', organizationSlug] as const;
}

export interface WorkViewsShellProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly client?: ApiClient;
  readonly view: WorkView;
  /** The project shown, `''` for all projects. */
  readonly projectId: string;
  /** Pick a project from the rail; `''` clears it. */
  readonly onChooseProject: (projectId: string) => void;
  /** The list's filters, when the view has them (List, Board); elsewhere the rail links there. */
  readonly filters?: WorkListFilters;
  /** The list applies the rail's views and teams in place. */
  readonly onChooseFilters?: (filters: WorkListFilters) => void;
  /** The list draws List and Board in place. */
  readonly onLocalViewChange?: (view: 'list' | 'board') => void;
  /** The rail's counts, when the list has read them. */
  readonly counts?: RailCounts;
  /** Overrides the title; "Work" by default (the project shows on its filter and rail item). */
  readonly title?: string;
  readonly titleMeta?: ReactNode;
  /** The view's own controls, drawn at the end of the view bar. */
  readonly toolbar?: ReactNode;
  readonly lens?: ReactNode;
  readonly children: ReactNode;
}

export function WorkViewsShell({
  organizationSlug,
  organizationName,
  client,
  view,
  projectId,
  onChooseProject,
  filters,
  onChooseFilters,
  onLocalViewChange,
  counts,
  title,
  titleMeta,
  toolbar,
  lens,
  children,
}: WorkViewsShellProps) {
  const t = useT();
  const tOr = useTOr();
  const ta = useA6T();
  const api = client ?? browserApiClient();
  const canCreateProjects = useCanCreateProjects(organizationSlug, client);
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });
  const teams = useQuery({
    queryKey: teamsKey(organizationSlug),
    queryFn: () => listTeams(api, organizationSlug),
  });
  const teamList = teams.data?.teams ?? [];
  const base = `/${organizationSlug}`;
  const current = filters ?? { ...NO_FILTERS, projectId };
  const activeView = filters ? activeRailView(filters) : null;
  const count = (value: number | undefined) =>
    value === undefined ? null : (
      <span className="tm-wl-rail__count">
        {new Intl.NumberFormat(withNumerals(appLocale())).format(value)}
        {counts?.partial ? '+' : ''}
      </span>
    );
  const listHref = (next: WorkListFilters) =>
    `${base}/work${workListQuery({ view: 'list', filters: next })}`;

  /** A rail entry: in place on the list, a link to the list from the other views. */
  const railEntry = (
    key: string,
    pressed: boolean,
    next: WorkListFilters,
    label: ReactNode,
    value: number | undefined,
    kind: 'view' | 'project' | 'team',
  ) =>
    onChooseFilters ? (
      <button
        key={key}
        type="button"
        className="tm-wk-rail__item"
        data-kind={kind}
        aria-pressed={pressed}
        onClick={() => onChooseFilters(next)}
      >
        <span className="tm-wk-rail__text">{label}</span>
        {count(value)}
      </button>
    ) : (
      <Link key={key} className="tm-wk-rail__item" data-kind={kind} href={listHref(next)}>
        <span className="tm-wk-rail__text">{label}</span>
      </Link>
    );

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={title ?? tOr('WorkViewsShell.work', 'Work')}
      {...(titleMeta === undefined ? {} : { titleMeta })}
      {...(lens === undefined ? {} : { lens })}
      actions={
        <>
          <HelpTip
            tip={tOr(
              'WorkViewsShell.searchTip',
              'Find any work item, project or person by typing a few letters.',
            )}
          >
            <button
              type="button"
              className="tm-wl-search"
              aria-label={t('WorkListScreen.searchWork')}
              onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))}
            >
              <SearchIcon />
              <span className="tm-wl-search__placeholder" aria-hidden="true">
                {t('WorkListScreen.searchWork')}
              </span>
            </button>
          </HelpTip>
          <HelpTip
            tip={tOr('WorkViewsShell.newWorkTip', 'Add a task or other work item to a project.')}
          >
            <Link
              href={`${base}/capture${projectId === '' ? '' : `?project=${encodeURIComponent(projectId)}`}`}
              className="tm-wl-new"
            >
              {t('WorkListScreen.newWork')}
            </Link>
          </HelpTip>
        </>
      }
      contextRail={
        <div className="tm-wk-rail">
          <div className="tm-wk-rail__group">
            <h2 className="tm-wk-rail__heading" id="tm-work-views">
              {t('WorkListScreen.railViews')}
            </h2>
            <ul className="tm-wk-rail__group" aria-labelledby="tm-work-views">
              {RAIL_VIEWS.map((entry) => (
                <li key={entry}>
                  {railEntry(
                    entry,
                    activeView === entry,
                    railViewFilters(entry, current),
                    ta(RAIL_VIEW_KEY[entry]),
                    counts?.views[entry],
                    'view',
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div className="tm-wk-rail__group">
            <h2 className="tm-wk-rail__heading" id="tm-work-projects">
              {t('WorkListScreen.railProjects')}
            </h2>
            <ul className="tm-wk-rail__group" aria-labelledby="tm-work-projects">
              {(projects.data ?? [])
                .filter((project) => !project.archivedAt)
                .map((project) => (
                  <li key={project.id}>
                    {onChooseFilters ? (
                      railEntry(
                        project.id,
                        current.projectId === project.id,
                        {
                          ...current,
                          projectId: current.projectId === project.id ? '' : project.id,
                          stageIds: [],
                        },
                        <bdi>{project.name}</bdi>,
                        counts ? (counts.projects.get(project.id) ?? 0) : undefined,
                        'project',
                      )
                    ) : (
                      <button
                        type="button"
                        className="tm-wk-rail__item"
                        data-kind="project"
                        aria-pressed={projectId === project.id}
                        onClick={() => onChooseProject(projectId === project.id ? '' : project.id)}
                      >
                        <span className="tm-wk-rail__text">
                          <bdi>{project.name}</bdi>
                        </span>
                      </button>
                    )}
                  </li>
                ))}
              {canCreateProjects ? (
                <li>
                  <Link className="tm-wk-rail__item" href={`${base}/projects/new`}>
                    <span className="tm-wk-rail__text">{t('WorkListScreen.railNewProject')}</span>
                  </Link>
                </li>
              ) : null}
            </ul>
          </div>

          {teamList.length > 0 ? (
            <div className="tm-wk-rail__group">
              <h2 className="tm-wk-rail__heading" id="tm-work-teams">
                {t('WorkListScreen.railTeams')}
              </h2>
              <ul className="tm-wk-rail__group" aria-labelledby="tm-work-teams">
                {teamList.map((team) => (
                  <li key={team.id}>
                    {railEntry(
                      team.id,
                      current.teamId === team.id,
                      { ...current, teamId: current.teamId === team.id ? '' : team.id },
                      <bdi>{team.name}</bdi>,
                      counts ? (counts.teams.get(team.id) ?? 0) : undefined,
                      'team',
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="tm-wk-rail__group">
            <h2 className="tm-wk-rail__heading" id="tm-work-more">
              {t('WorkListScreen.railMore')}
            </h2>
            <ul className="tm-wk-rail__group" aria-labelledby="tm-work-more">
              <li>
                <Link className="tm-wk-rail__item" href={`${base}/work/requests`}>
                  {t('WorkListScreen.railRequests')}
                </Link>
              </li>
              <li>
                <Link className="tm-wk-rail__item" href={`${base}/work/saved-views`}>
                  {t('WorkListScreen.savedViews')}
                </Link>
              </li>
              <li>
                <Link className="tm-wk-rail__item" href={`${base}/finance/timesheets`}>
                  {t('WorkListScreen.railTimeLogs')}
                </Link>
              </li>
            </ul>
          </div>
        </div>
      }
    >
      <div className="tm-wl-bar">
        <WorkViewSwitcher
          organizationSlug={organizationSlug}
          projectId={projectId}
          current={view}
          {...(onLocalViewChange ? { onLocalChange: onLocalViewChange } : {})}
        />
        {toolbar ? (
          <div
            className="tm-wl-bar__tools"
            role="toolbar"
            aria-label={tOr('WorkViewsShell.toolbar', 'View options')}
          >
            {toolbar}
          </div>
        ) : null}
      </div>
      {children}
    </AppShell>
  );
}
