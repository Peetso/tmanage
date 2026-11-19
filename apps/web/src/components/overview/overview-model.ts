import type { SignalBriefingGroup } from '@tmanage/domain';
import type { ProjectHealthBand } from '../../lib/api/project-health';
import type { SummaryWaitingOn } from '../../lib/api/project-summary';
import type { ProjectHealthReason } from '../../lib/api/client-summary';

/**
 * ONEPAGE — the view model both one-page screens (project overview, client company) draw.
 *
 * The two mappers (`project-overview-model.ts`, `client-overview-model.ts`) turn a summary read
 * into this shape; the six block components only draw it. A block that is `undefined` here is
 * **absent** (the viewer may not read it: the server left it out of the summary), and the layout
 * draws no card and no gap for it. A block that is present but holds nothing is **empty**, and its
 * card stays with one calm line (review FIGMA-C fix 7).
 *
 * The model carries facts and kinds, never words: every sentence is built in the block from the
 * active locale, so the mappers stay pure and the same fact reads the same way on both pages.
 */

/** Which "Open …" link a card header carries; each names the full screen it opens. */
export type OverviewLinkKind =
  | 'openWork'
  | 'openProjects'
  | 'openApprovals'
  | 'openHealth'
  | 'seeProjectsAtRisk'
  | 'openFiles'
  | 'openTimesheets'
  | 'openInvoices';

export interface OverviewLink {
  readonly kind: OverviewLinkKind;
  readonly href: string;
}

/** A health band said as a capsule: `red` is behind, `amber` at risk, `green` on track. */
export type OverviewBand = ProjectHealthBand;

export type DeliveryRow =
  | {
      readonly kind: 'nextMilestone';
      readonly id: string;
      readonly title: string;
      readonly dueOn: string | null;
      readonly href: string;
      /** From project health, never a fixed value (review fix 3); absent without health. */
      readonly band?: OverviewBand;
    }
  | {
      readonly kind: 'project';
      readonly id: string;
      readonly name: string;
      readonly href: string;
      readonly band?: OverviewBand;
    };

export interface DeliveryModel {
  readonly link: OverviewLink;
  readonly open: number;
  readonly late: number;
  readonly done: number;
  /** False when the summary walked only part of the work; the figures are then "at least". */
  readonly complete: boolean;
  readonly rows: readonly DeliveryRow[];
}

export interface ApprovalItem {
  readonly id: string;
  readonly title: string;
  readonly href: string;
  readonly waitingOn: SummaryWaitingOn;
  readonly since: string;
  /** The project's name on the client page, where approvals come from several projects. */
  readonly context?: string;
}

export interface ApprovalsModel {
  readonly link: OverviewLink;
  readonly waitingOnTeam: number;
  readonly waitingOnClient: number;
  readonly items: readonly ApprovalItem[];
}

/**
 * One risk line. `late` lines are drawn with the Blocked capsule, `watch` lines with Waiting
 * (review fix 10: one status language with the rest of the page).
 */
export type RiskLine =
  | { readonly kind: 'lateWork'; readonly count: number; readonly href: string }
  | { readonly kind: 'overdueMilestones'; readonly count: number; readonly href: string }
  | { readonly kind: 'highRisks'; readonly count: number; readonly href: string }
  | { readonly kind: 'openRisks'; readonly count: number; readonly href: string }
  | {
      readonly kind: 'budget';
      readonly percent: number;
      readonly trackedHours: number;
      readonly budgetHours: number;
      readonly href: string;
    }
  | {
      readonly kind: 'staleApprovals';
      readonly count: number;
      readonly oldestTitle: string;
      readonly href: string;
    }
  /** D7: `reason` says why (the heaviest health signal), never the band's colour. */
  | {
      readonly kind: 'projectBehind';
      readonly name: string;
      readonly href: string;
      readonly reason?: ProjectHealthReason;
    }
  | {
      readonly kind: 'projectAtRisk';
      readonly name: string;
      readonly href: string;
      readonly reason?: ProjectHealthReason;
    }
  | {
      readonly kind: 'overdueInvoices';
      readonly count: number;
      readonly currency: string;
      readonly amountMinor: number;
      readonly href: string;
    }
  /** B10: one briefing group of open signals; `count` is how many signals stand behind it. */
  | {
      readonly kind: 'signal';
      readonly group: SignalBriefingGroup;
      readonly count: number;
      readonly threshold: number;
      readonly href: string;
    };

export type RiskSeverity = 'late' | 'watch';

export interface RisksModel {
  readonly link: OverviewLink;
  readonly lines: readonly RiskLine[];
}

export interface FileItem {
  readonly id: string;
  readonly name: string;
  readonly href: string;
  readonly updatedAt: string;
  readonly context?: string;
}

export interface FilesModel {
  readonly link: OverviewLink;
  readonly items: readonly FileItem[];
}

/** D7: one project's hours on the client page's Time card. */
export interface TimeProjectRow {
  readonly id: string;
  readonly name: string;
  readonly href: string;
  readonly loggedMinutes: number;
}

/** Each figure is present only when the viewer may read it; money-derived ones need finance. */
export interface TimeModel {
  readonly link: OverviewLink;
  readonly loggedMinutes?: number;
  readonly billableMinutes?: number;
  readonly unbilledMinutes?: number;
  /** The client page's per-project lines, most hours first; the project page has none. */
  readonly projects?: readonly TimeProjectRow[];
}

export interface MoneyModel {
  readonly link: OverviewLink;
  /** `null` when nothing has been invoiced yet in any currency. */
  readonly currency: string | null;
  readonly invoicedMinor: number;
  readonly paidMinor?: number;
  readonly overdueMinor?: number;
  readonly overdueCount?: number;
  readonly unbilledMinor?: number;
  /** Other currencies the client was invoiced in, beyond the one shown. */
  readonly moreCurrencies: number;
}

export interface OverviewModel {
  readonly delivery?: DeliveryModel;
  readonly approvals?: ApprovalsModel;
  readonly risks?: RisksModel;
  readonly files?: FilesModel;
  readonly time?: TimeModel;
  readonly money?: MoneyModel;
}

/** An approval waiting on the client this long is a risk line (the frames' "over 2 days old"). */
export const STALE_APPROVAL_DAYS = 2;

/** Budget use from which the risks block warns, in basis points (80 %), and calls it over (100 %). */
export const BUDGET_WATCH_BP = 8_000;
export const BUDGET_OVER_BP = 10_000;

/** Rows a list block shows; the card links to the full screen for the rest. */
export const OVERVIEW_ROW_LIMIT = 3;

export function riskSeverity(line: RiskLine): RiskSeverity {
  switch (line.kind) {
    case 'lateWork':
    case 'overdueMilestones':
    case 'projectBehind':
      return 'late';
    case 'budget':
      return line.percent * 100 >= BUDGET_OVER_BP ? 'late' : 'watch';
    case 'signal':
      return line.group === 'money_to_collect' || line.group === 'over_budget' ? 'late' : 'watch';
    default:
      return 'watch';
  }
}

/** Whole days between an instant and `now`, never negative. */
export function daysSince(iso: string, now: Date): number {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
}
