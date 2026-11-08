'use client';

import { useTOr } from '../../lib/i18n/use-t-or';
import { ViewSwitcher } from './ViewSwitcher';
import type { ViewOption } from './ViewSwitcher';

export const WORK_VIEWS = ['list', 'board', 'timeline', 'calendar', 'workload'] as const;
export type WorkView = (typeof WORK_VIEWS)[number];

export interface WorkViewSwitcherProps {
  readonly organizationSlug: string;
  /** The chosen project, carried to every other view so the filter survives the switch. */
  readonly projectId: string;
  readonly current: WorkView;
  /**
   * Set on the Work list page, where List and Board are drawn in place; elsewhere they are links
   * back to `/work?view=…`.
   */
  readonly onLocalChange?: (view: 'list' | 'board') => void;
}

/** The address of a work view, keeping the project filter. */
export function workViewHref(organizationSlug: string, view: WorkView, projectId: string): string {
  const params = new URLSearchParams();
  if (view === 'list' || view === 'board') params.set('view', view);
  if (projectId !== '') params.set('project', projectId);
  const query = params.toString();
  const path =
    view === 'list' || view === 'board'
      ? `/${organizationSlug}/work`
      : `/${organizationSlug}/work/${view}`;
  return query === '' ? path : `${path}?${query}`;
}

/**
 * **R38 G5-views** — Work's views (List, Board, Timeline, Calendar, Workload) in the shared
 * `ViewSwitcher`, the same control the Projects, Clients and People pages carry.
 */
export function WorkViewSwitcher({
  organizationSlug,
  projectId,
  current,
  onLocalChange,
}: WorkViewSwitcherProps) {
  const tOr = useTOr();
  const labels: Record<WorkView, string> = {
    list: tOr('ViewSwitcher.list', 'List'),
    board: tOr('ViewSwitcher.board', 'Board'),
    timeline: tOr('ViewSwitcher.timeline', 'Timeline'),
    calendar: tOr('ViewSwitcher.calendar', 'Calendar'),
    workload: tOr('ViewSwitcher.workload', 'Workload'),
  };
  const options: ViewOption<WorkView>[] = WORK_VIEWS.map((id) =>
    onLocalChange && (id === 'list' || id === 'board')
      ? { id, label: labels[id] }
      : { id, label: labels[id], href: workViewHref(organizationSlug, id, projectId) },
  );
  return (
    <ViewSwitcher
      label={tOr('ViewSwitcher.workLabel', 'Work view')}
      options={options}
      value={current}
      onChange={(view) => {
        if (onLocalChange && (view === 'list' || view === 'board')) onLocalChange(view);
      }}
    />
  );
}
