import { SIGNAL_RULES } from './signal-catalog.js';
import type { SignalBriefingGroup, SignalRuleKey, SignalSubjectType } from './signal-catalog.js';

/**
 * 62-A1b + 62-A1c — the business briefing: the open signals one viewer may act on, grouped. One
 * pure builder for the Home card (API) and the morning mail section (worker), so the two always
 * list the same lines for the same person. Rows and rules only; no model is called.
 *
 * ## Who sees what
 *
 * - **Company-wide** viewers (owner, admins: `hasOrgWideScope`) see the whole company.
 * - Anyone else sees the signals of the projects they **lead** (a project member holding
 *   `project.manage`, the same "lead" the notices use) and the overload of the people on those
 *   projects or reporting to them.
 * - Every money rule needs `finance.view`, whoever the viewer is (FIGMA-D fix 1 / 23).
 * - A line is listed only when its record still resolves (not deleted, project not archived), and
 *   every count is taken after these filters, so a count never reveals a record the viewer
 *   cannot open (plan 62-A1b).
 */

/** The drawn order of the groups (FIGMA-D group b; an empty group is absent and the rest close up). */
export const BRIEFING_GROUP_ORDER: readonly SignalBriefingGroup[] = [
  'projects_at_risk',
  'money_to_collect',
  'money_to_invoice',
  'people_overloaded',
  'waiting_on_clients',
  'over_budget',
  'stale_work',
  'unusual_expenses',
];

/** Lines shown per group; the rest is "and N more". */
export const BRIEFING_LINES_PER_GROUP = 3;

/** At most this many open signals are read for one briefing (one company, one hour). */
export const BRIEFING_SIGNAL_LIMIT = 2_000;

/** Whose briefing it is: the whole company, the viewer's own projects and people, or nothing. */
export type BriefingAudience = 'company' | 'team' | 'none';

export interface BriefingViewer {
  readonly companyWide: boolean;
  readonly finance: boolean;
  /** The projects the viewer leads. */
  readonly projectIds: ReadonlySet<string>;
  /** The memberships on the projects they lead, and the people reporting to them. */
  readonly teamMembershipIds: ReadonlySet<string>;
}

/** One signal the last sweep found, as stored in `work_signals`. */
export interface OpenSignal {
  readonly signalId: string;
  readonly rule: SignalRuleKey;
  readonly subjectType: SignalSubjectType;
  readonly subjectId: string;
  readonly projectId: string | null;
  readonly measure: number;
  readonly threshold: number;
}

export interface BriefingAmount {
  readonly minor: number;
  readonly currency: string;
}

/** What a signal's record resolves to: words to show and the ids its link needs. */
export interface BriefingSubject {
  /** The record's own name (task title, project name, invoice number, person, file). */
  readonly title: string | null;
  /** Where it belongs (project, client company); null when the title says it all. */
  readonly context: string | null;
  /** Open amount of an invoice, amount of an expense. */
  readonly amount: BriefingAmount | null;
  /** An expense's category key, shown when the expense has no note. */
  readonly category: string | null;
  /** An approval's deliverable, the page its link opens. */
  readonly deliverableId: string | null;
}

export interface BriefingLine extends OpenSignal, BriefingSubject {
  /** Workspace-relative path of the record ("/work/…"); the caller puts the workspace in front. */
  readonly path: string;
}

export interface BriefingGroup {
  readonly group: SignalBriefingGroup;
  /** Every line the viewer may open in this group. */
  readonly count: number;
  /** The first {@link BRIEFING_LINES_PER_GROUP}, most pressing first. */
  readonly lines: readonly BriefingLine[];
  /** `count - lines.length`: the "and N more". */
  readonly more: number;
  /** Workspace-relative path of the full list the "and N more" opens (FIGMA-D fix 16). */
  readonly path: string;
}

export function briefingAudience(viewer: BriefingViewer): BriefingAudience {
  if (viewer.companyWide) return 'company';
  return viewer.projectIds.size > 0 || viewer.teamMembershipIds.size > 0 ? 'team' : 'none';
}

/** Whether this viewer may see this signal (before its record is resolved). */
export function briefingSignalVisible(signal: OpenSignal, viewer: BriefingViewer): boolean {
  const rule = SIGNAL_RULES[signal.rule];
  if (rule.money && !viewer.finance) return false;
  if (viewer.companyWide) return true;
  if (rule.subjectType === 'membership') return viewer.teamMembershipIds.has(signal.subjectId);
  return signal.projectId !== null && viewer.projectIds.has(signal.projectId);
}

/** The key a resolved subject is found under. */
export function briefingSubjectKey(subjectType: SignalSubjectType, subjectId: string): string {
  return `${subjectType}:${subjectId}`;
}

const segment = encodeURIComponent;

/** The record a line opens (FIGMA-D fix 16), workspace-relative. */
export function briefingLinePath(
  signal: OpenSignal,
  subject: Pick<BriefingSubject, 'deliverableId'>,
): string {
  switch (signal.subjectType) {
    case 'work_item':
      return `/work/${segment(signal.subjectId)}`;
    case 'membership':
      return `/people/${segment(signal.subjectId)}`;
    case 'client_invoice':
      return `/finance/invoices/${segment(signal.subjectId)}`;
    case 'project':
      return `/projects/${segment(signal.subjectId)}`;
    case 'expense':
      return '/finance/expenses';
    case 'approval':
      return signal.projectId !== null && subject.deliverableId !== null
        ? `/projects/${segment(signal.projectId)}/deliverables/${segment(subject.deliverableId)}`
        : '/inbox';
  }
}

/** The full list each group's "and N more" opens, workspace-relative. */
export const BRIEFING_GROUP_PATHS: Readonly<Record<SignalBriefingGroup, string>> = {
  projects_at_risk: '/projects/portfolio',
  money_to_collect: '/finance/invoices',
  money_to_invoice: '/finance/reports',
  people_overloaded: '/people/capacity',
  waiting_on_clients: '/inbox',
  over_budget: '/projects/portfolio',
  stale_work: '/work',
  unusual_expenses: '/finance/expenses',
};

/** Most pressing first: the nearest deadline, else the largest figure; ties by id. */
function pressing(a: BriefingLine, b: BriefingLine): number {
  const byMeasure = a.rule === 'deadline_at_risk' ? a.measure - b.measure : b.measure - a.measure;
  return byMeasure !== 0 ? byMeasure : a.signalId.localeCompare(b.signalId);
}

/**
 * The briefing: the visible signals whose record resolved, grouped in the drawn order, each group
 * with its count, its first lines and its "and N more". A group with nothing in it is absent.
 */
export function buildBriefing(
  signals: readonly OpenSignal[],
  subjects: ReadonlyMap<string, BriefingSubject>,
  viewer: BriefingViewer,
): readonly BriefingGroup[] {
  const byGroup = new Map<SignalBriefingGroup, BriefingLine[]>();
  for (const signal of signals) {
    if (!briefingSignalVisible(signal, viewer)) continue;
    const subject = subjects.get(briefingSubjectKey(signal.subjectType, signal.subjectId));
    if (subject === undefined) continue;
    const group = SIGNAL_RULES[signal.rule].briefingGroup;
    const line: BriefingLine = { ...signal, ...subject, path: briefingLinePath(signal, subject) };
    byGroup.set(group, [...(byGroup.get(group) ?? []), line]);
  }
  return BRIEFING_GROUP_ORDER.flatMap((group): BriefingGroup[] => {
    const all = byGroup.get(group);
    if (all === undefined || all.length === 0) return [];
    const lines = [...all].sort(pressing).slice(0, BRIEFING_LINES_PER_GROUP);
    return [
      {
        group,
        count: all.length,
        lines,
        more: all.length - lines.length,
        path: BRIEFING_GROUP_PATHS[group],
      },
    ];
  });
}
