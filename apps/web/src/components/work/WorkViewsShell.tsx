'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { WORK_ITEM_STATES } from '@tmanage/domain';
import type { WorkItemState } from '@tmanage/domain';
import { AppShell } from '../shell/AppShell';
import { useCanCreateProjects } from '../projects/NewProjectLink';
import { WorkViewSwitcher, type WorkView } from '../views/WorkViewSwitcher';
import { OPEN_COMMAND_PALETTE_EVENT } from '../screens/CommandPalette';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import type { ApiClient } from '../../lib/api/client';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useA6T } from './DueDatePicker';
import { HelpTip } from '../help/HelpTip';
import '../screens/work-core.css';
import './work-views-shell.css';

/**
 * FIX2 item 3 (Peter, 2026-11-09: "List, Board, Timeline, Calendar and Workload are not consistent;
 * some have a left side menu and some do not").
 *
 * The one shell every Work view is drawn in — the design system's ContextRail + ViewCapsules pair
 * (`docs/design/source/.../inventory.md`: "ContextRail (flat …) Work list", "ViewCapsules
 * (list/board/timeline/calendar/workload)"), which the Work list already carried:
 *
 *  - the same left context rail (VIEWS, PROJECTS, MORE) on every view;
 *  - the same header: "<org> · Work · <view>" eyebrow, the project (or "All work") as the title,
 *    the search trigger and "+ New work" as the actions;
 *  - the same view bar (the capsules, at the inline end) and, under it, one toolbar row for the
 *    view's own controls, with the same spacing on every view.
 */

/** The rail's views: each is a real server-side state filter, named the way people ask for it. */
export const WORK_STATE_VIEWS: readonly {
  readonly label: string;
  readonly labelKey: MessageKey;
  readonly states: readonly WorkItemState[];
}[] = [
  { label: 'All work', labelKey: 'WorkListScreen.viewAllWork', states: [] },
  {
    label: 'All open work',
    labelKey: 'WorkListScreen.viewAllOpen',
    states: WORK_ITEM_STATES.filter((state) => state !== 'done' && state !== 'archived'),
  },
  { label: 'Blocked work', labelKey: 'WorkListScreen.viewBlocked', states: ['blocked'] },
  {
    label: 'In internal review',
    labelKey: 'WorkListScreen.viewInternalReview',
    states: ['internal_review'],
  },
  { label: 'Done', labelKey: 'WorkListScreen.viewDone', states: ['done'] },
];

export function sameStates(
  left: readonly WorkItemState[],
  right: readonly WorkItemState[],
): boolean {
  return left.length === right.length && left.every((state) => right.includes(state));
}

const VIEW_LABEL_KEYS: Record<WorkView, readonly [string, string]> = {
  list: ['ViewSwitcher.list', 'List'],
  board: ['ViewSwitcher.board', 'Board'],
  timeline: ['ViewSwitcher.timeline', 'Timeline'],
  calendar: ['ViewSwitcher.calendar', 'Calendar'],
  workload: ['ViewSwitcher.workload', 'Workload'],
};

export interface WorkViewsShellProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly client?: ApiClient;
  readonly view: WorkView;
  /** The project shown, `''` for all projects. */
  readonly projectId: string;
  /** Pick a project from the rail; `''` clears it. */
  readonly onChooseProject: (projectId: string) => void;
  /** The list's state filter, when the view has one (List, Board). */
  readonly states?: readonly WorkItemState[];
  /** The list draws its state views in place; elsewhere they link to the list. */
  readonly onChooseStates?: (states: readonly WorkItemState[]) => void;
  /** The list draws List and Board in place. */
  readonly onLocalViewChange?: (view: 'list' | 'board') => void;
  /** Overrides the title (the list's state-view name); otherwise the project or "All work". */
  readonly title?: string;
  readonly titleMeta?: ReactNode;
  /** The view's own controls, drawn in the one toolbar row under the view bar. */
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
  states,
  onChooseStates,
  onLocalViewChange,
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
  const projectName = projects.data?.find((project) => project.id === projectId)?.name;
  const activeStateView =
    states === undefined
      ? undefined
      : WORK_STATE_VIEWS.find((entry) => sameStates(entry.states, states));
  const [viewKey, viewFallback] = VIEW_LABEL_KEYS[view];
  const base = `/${organizationSlug}`;

  const stateHref = (next: readonly WorkItemState[]) => {
    const params = new URLSearchParams();
    if (projectId !== '') params.set('project', projectId);
    if (next.length > 0) params.set('state', next.join(','));
    const query = params.toString();
    return `${base}/work${query === '' ? '' : `?${query}`}`;
  };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      eyebrow={`${tOr('WorkViewsShell.work', 'Work')} · ${tOr(viewKey, viewFallback)}`}
      title={
        title ??
        projectName ??
        (activeStateView ? t(activeStateView.labelKey) : t('WorkListScreen.viewAllWork'))
      }
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
              className="tm-wk-search"
              data-kind="trigger"
              onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))}
            >
              <span className="tm-wk-search__icon" aria-hidden="true">
                ⌕
              </span>
              <span className="tm-wk-search__placeholder">{ta('WorkBoard.search')}</span>
              <kbd className="tm-wk-search__key" aria-hidden="true">
                ⌘K
              </kbd>
            </button>
          </HelpTip>
          <HelpTip
            tip={tOr('WorkViewsShell.newWorkTip', 'Add a task or other work item to a project.')}
          >
            <Link
              href={`${base}/capture${projectId === '' ? '' : `?project=${encodeURIComponent(projectId)}`}`}
              className="tm-wk-new"
            >
              <span className="tm-wk-new__orb" aria-hidden="true">
                +
              </span>
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
              {WORK_STATE_VIEWS.map((entry) => (
                <li key={entry.label}>
                  {onChooseStates ? (
                    <button
                      type="button"
                      className="tm-wk-rail__item"
                      data-kind="view"
                      aria-pressed={activeStateView?.label === entry.label}
                      onClick={() => onChooseStates(entry.states)}
                    >
                      {t(entry.labelKey)}
                    </button>
                  ) : (
                    <Link
                      className="tm-wk-rail__item"
                      data-kind="view"
                      href={stateHref(entry.states)}
                    >
                      {t(entry.labelKey)}
                    </Link>
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
                    <button
                      type="button"
                      className="tm-wk-rail__item"
                      data-kind="project"
                      aria-pressed={projectId === project.id}
                      onClick={() => onChooseProject(projectId === project.id ? '' : project.id)}
                    >
                      <span className="tm-wk-rail__dot" aria-hidden="true" />
                      <span className="tm-wk-rail__text">{project.name}</span>
                    </button>
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

          <div className="tm-wk-rail__group">
            <h2 className="tm-wk-rail__heading" id="tm-work-more">
              {t('WorkListScreen.railMore')}
            </h2>
            <ul className="tm-wk-rail__group" aria-labelledby="tm-work-more">
              <li>
                <Link className="tm-wk-rail__item" href={`${base}/work/requests`}>
                  {t('WorkListScreen.clientRequests')}
                </Link>
              </li>
              <li>
                <Link className="tm-wk-rail__item" href={`${base}/work/saved-views`}>
                  {t('WorkListScreen.savedViews')}
                </Link>
              </li>
            </ul>
          </div>
        </div>
      }
    >
      <div className="tm-view-bar tm-wk-view-bar">
        <WorkViewSwitcher
          organizationSlug={organizationSlug}
          projectId={projectId}
          current={view}
          {...(onLocalViewChange ? { onLocalChange: onLocalViewChange } : {})}
        />
      </div>
      {toolbar ? (
        <div
          className="tm-wk-viewtools"
          role="toolbar"
          aria-label={tOr('WorkViewsShell.toolbar', 'View options')}
        >
          {toolbar}
        </div>
      ) : null}
      {children}
    </AppShell>
  );
}
