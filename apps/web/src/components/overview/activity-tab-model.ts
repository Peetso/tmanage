import type { ActivityKind } from '@tmanage/domain';
import type { ActivityEntry, ActivityQuery } from '../../lib/api/activity';
import {
  approvalsInboxHref,
  deliverableHref,
  fileHref,
  invoicesHref,
  projectHref,
  projectMilestonesHref,
  timesheetsHref,
} from './overview-links';

/**
 * 62-A2 (B09) — the Activity tab's facts: which kinds the chips offer, what a date choice sends,
 * and which screen each entry opens. Pure, so the rules are provable without a render; the words
 * live in `ActivityTab.tsx`.
 */

/**
 * The kind chips after "All", in the frame's order (753:41712). Other kinds (project, people,
 * milestones, requests) show under All. Money is offered only to a holder of `finance.view`
 * (review FIGMA-D fix 1): the API never returns a money entry to anyone else.
 */
export const ACTIVITY_FILTER_KINDS = ['work', 'files', 'approvals', 'time', 'money'] as const;
export type ActivityFilterKind = (typeof ACTIVITY_FILTER_KINDS)[number];

export function filterKindsFor(mayViewFinance: boolean): readonly ActivityFilterKind[] {
  return mayViewFinance
    ? ACTIVITY_FILTER_KINDS
    : ACTIVITY_FILTER_KINDS.filter((kind) => kind !== 'money');
}

export const ACTIVITY_PERIODS = ['any', '7', '30', '90'] as const;
export type ActivityPeriod = (typeof ACTIVITY_PERIODS)[number];

export interface ActivityFilters {
  readonly kind: ActivityKind | null;
  readonly person: string | null;
  readonly period: ActivityPeriod;
}

export const NO_ACTIVITY_FILTERS: ActivityFilters = { kind: null, person: null, period: 'any' };

export function hasActivityFilters(filters: ActivityFilters): boolean {
  return filters.kind !== null || filters.person !== null || filters.period !== 'any';
}

/** A local calendar day as the API's `YYYY-MM-DD`. */
function isoDay(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${at.getFullYear()}-${month}-${day}`;
}

/** The query the filters send: "Last 30 days" is today and the 29 days before it, inclusive. */
export function activityQueryFor(filters: ActivityFilters, now: Date): ActivityQuery {
  const query: { kind?: ActivityKind; person?: string; from?: string } = {};
  if (filters.kind !== null) query.kind = filters.kind;
  if (filters.person !== null) query.person = filters.person;
  if (filters.period !== 'any') {
    const from = new Date(now);
    from.setDate(from.getDate() - (Number(filters.period) - 1));
    query.from = isoDay(from);
  }
  return query;
}

/**
 * The screen an entry opens (review FIGMA-D fix 2): the record itself where it has a page, else
 * the list that holds it. The API leaves out entries whose record is gone, so every row links.
 */
export function activityEntryHref(org: string, entry: ActivityEntry): string {
  const id = encodeURIComponent(entry.objectId);
  const project = entry.projectId;
  switch (entry.objectType) {
    case 'project':
      return projectHref(org, entry.objectId);
    case 'project_membership':
      return project === null ? `/${org}/people` : `${projectHref(org, project)}/members`;
    case 'work_item':
      return `/${org}/work/${id}`;
    case 'time_log':
      return timesheetsHref(org);
    case 'file_asset':
      return fileHref(org, entry.objectId);
    case 'deliverable':
      return project === null ? `/${org}/files` : deliverableHref(org, project, entry.objectId);
    case 'approval':
      return approvalsInboxHref(org);
    case 'project_milestone':
      return project === null ? `/${org}/projects` : projectMilestonesHref(org, project);
    case 'client_request':
      return `/${org}/work/requests/${id}`;
    case 'client_invoice':
      return `${invoicesHref(org)}/${id}`;
    case 'quote':
      return `/${org}/quotes/${id}`;
    case 'expense':
      return `/${org}/finance/expenses`;
  }
}
