import type { WorkItemView } from '../work/work-items.service.js';
import type { DeliverableView } from '../approvals/deliverables.service.js';
import type { ProjectFileView } from '../files/folders.service.js';
import type { InvoiceSummary } from '../finance/client-invoices.service.js';
import type { ProjectHealthView } from './health.service.js';
import type { BurnReportView } from './budget-burn.service.js';
import type { ProjectBudgetView } from './budget.service.js';
import type { ProjectMilestoneView } from '../clients/project-milestones.controller.js';

/**
 * ONEPAGE (B01). The blocks of the one-page project and client views, and the pure folds that turn
 * a source service's answer into a block. Every figure here is re-derivable from the source read it
 * came from; nothing is stored, nothing is scored that the source did not score.
 *
 * A block is **absent** from a summary when the viewer may not read it (see `summary-access.ts`);
 * a present block with zeros means "readable, and nothing there".
 */

/** How many of the newest files and waiting approvals a block names. More is the full screen. */
export const SUMMARY_LIST_LIMIT = 5;

/** Delivery: the readable work, by where it stands. `complete` is false past the walk budget. */
export interface DeliveryBlock {
  readonly open: number;
  readonly late: number;
  readonly done: number;
  readonly complete: boolean;
}

/** The next planned milestone, or `null` when none is planned. */
export interface MilestoneBlock {
  readonly next: {
    readonly id: string;
    readonly title: string;
    readonly dueOn: string | null;
  } | null;
  readonly planned: number;
  readonly missed: number;
}

/** Health: the project-health band and the risk signals it was derived from. */
export interface HealthBlock {
  readonly band: ProjectHealthView['band'];
  readonly score: number;
  readonly overdueMilestones: number;
  readonly openRisks: number;
  readonly highRisks: number;
}

/** Who a waiting approval waits on: the client approvers, or the team (changes requested). */
export type ApprovalWaitingOn = 'team' | 'client';

export interface WaitingApproval {
  readonly deliverableId: string;
  readonly projectId: string;
  readonly title: string;
  readonly waitingOn: ApprovalWaitingOn;
  readonly since: string;
}

export interface ApprovalsBlock {
  readonly waitingOnTeam: number;
  readonly waitingOnClient: number;
  /** The oldest waiting first, at most {@link SUMMARY_LIST_LIMIT}. */
  readonly items: readonly WaitingApproval[];
}

export interface LatestFile {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly mimeType: string | null;
  readonly updatedAt: string;
}

export interface FilesBlock {
  readonly items: readonly LatestFile[];
}

/** Time logged on the project over the burn report's range (its default when none is asked). */
export interface TimeBlock {
  readonly from: string;
  readonly to: string;
  readonly loggedMinutes: number;
  readonly billableMinutes: number;
}

/** The budget's burn, hours only: amounts belong to the money block. */
export interface BudgetBlock {
  readonly budgetHours: number | null;
  readonly trackedHours: number;
  readonly remainingHours: number | null;
  readonly percentBp: number | null;
  readonly status: NonNullable<ProjectBudgetView['burn']>['status'] | null;
}

/** Money for one project, from the finance profitability report (its default range). */
export interface ProjectMoneyBlock {
  readonly from: string;
  readonly to: string;
  readonly currency: string | null;
  readonly invoicedMinor: number;
  readonly unbilledMinor: number;
  readonly unbilledMinutes: number;
  readonly truncated: boolean;
}

/** Money for one client company in one currency, from its invoices. */
export interface CurrencyTotals {
  readonly currency: string;
  readonly invoicedMinor: number;
  readonly paidMinor: number;
  readonly dueMinor: number;
  readonly overdueMinor: number;
  readonly overdueCount: number;
}

export interface ClientMoneyBlock {
  readonly totals: readonly CurrencyTotals[];
  readonly complete: boolean;
}

/** Not yet invoiced work for one client company, from the finance unbilled report. */
export interface UnbilledBlock {
  readonly from: string;
  readonly to: string;
  readonly currency: string | null;
  readonly minutes: number;
  readonly amountMinor: number;
  readonly truncated: boolean;
}

const OPEN_EXCLUDED: ReadonlySet<WorkItemView['state']> = new Set(['done', 'archived']);

/** Fold readable work items into delivery counts. `late` is open work whose due instant passed. */
export function deliveryOf(
  items: readonly Pick<WorkItemView, 'state' | 'dueAt'>[],
  now: Date,
  complete: boolean,
): DeliveryBlock {
  let open = 0;
  let late = 0;
  let done = 0;
  for (const item of items) {
    if (item.state === 'done') done += 1;
    if (OPEN_EXCLUDED.has(item.state)) continue;
    open += 1;
    if (item.dueAt !== null && Date.parse(item.dueAt) < now.getTime()) late += 1;
  }
  return { open, late, done, complete };
}

/** Sum delivery blocks (a client's projects). Incomplete if any part is. */
export function sumDelivery(blocks: readonly DeliveryBlock[]): DeliveryBlock {
  return blocks.reduce<DeliveryBlock>(
    (sum, block) => ({
      open: sum.open + block.open,
      late: sum.late + block.late,
      done: sum.done + block.done,
      complete: sum.complete && block.complete,
    }),
    { open: 0, late: 0, done: 0, complete: true },
  );
}

/** The earliest planned milestone (undated last), and the planned / missed tallies. */
export function milestoneOf(
  milestones: readonly Pick<ProjectMilestoneView, 'id' | 'title' | 'dueOn' | 'status'>[],
): MilestoneBlock {
  const planned = milestones
    .filter((row) => row.status === 'planned')
    .sort((a, b) => compareDueOn(a.dueOn, b.dueOn) || a.id.localeCompare(b.id));
  const first = planned[0];
  return {
    next: first ? { id: first.id, title: first.title, dueOn: first.dueOn } : null,
    planned: planned.length,
    missed: milestones.filter((row) => row.status === 'missed').length,
  };
}

export function healthOf(view: ProjectHealthView): HealthBlock {
  return {
    band: view.band,
    score: view.score,
    overdueMilestones: view.signals.overdueMilestones,
    openRisks: view.signals.openRisks,
    highRisks: view.signals.highRisks,
  };
}

/**
 * The deliverable states that wait on someone: a version in review waits on its client approvers;
 * a version sent back with changes requested waits on the team's next version.
 */
const WAITING_ON: Readonly<Partial<Record<DeliverableView['state'], ApprovalWaitingOn>>> = {
  in_review: 'client',
  changes_requested: 'team',
};

/** Fold deliverables (any number of projects) into the waiting approvals, oldest first. */
export function approvalsOf(
  deliverables: readonly Pick<
    DeliverableView,
    'id' | 'projectId' | 'title' | 'state' | 'updatedAt'
  >[],
): ApprovalsBlock {
  const waiting: WaitingApproval[] = [];
  for (const row of deliverables) {
    const waitingOn = WAITING_ON[row.state];
    if (waitingOn === undefined) continue;
    waiting.push({
      deliverableId: row.id,
      projectId: row.projectId,
      title: row.title,
      waitingOn,
      since: row.updatedAt,
    });
  }
  waiting.sort(
    (a, b) => a.since.localeCompare(b.since) || a.deliverableId.localeCompare(b.deliverableId),
  );
  return {
    waitingOnTeam: waiting.filter((row) => row.waitingOn === 'team').length,
    waitingOnClient: waiting.filter((row) => row.waitingOn === 'client').length,
    items: waiting.slice(0, SUMMARY_LIST_LIMIT),
  };
}

/** The newest files (any number of projects), at most {@link SUMMARY_LIST_LIMIT}. */
export function filesOf(
  files: readonly Pick<ProjectFileView, 'id' | 'projectId' | 'name' | 'mimeType' | 'updatedAt'>[],
): FilesBlock {
  const newest = [...files]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, SUMMARY_LIST_LIMIT);
  return {
    items: newest.map((file) => ({
      id: file.id,
      projectId: file.projectId,
      name: file.name,
      mimeType: file.mimeType,
      updatedAt: file.updatedAt,
    })),
  };
}

export function timeOf(report: BurnReportView): TimeBlock {
  let loggedMinutes = 0;
  let billableMinutes = 0;
  for (const bucket of report.buckets) {
    loggedMinutes += bucket.minutes;
    billableMinutes += bucket.billableMinutes;
  }
  return { from: report.from, to: report.to, loggedMinutes, billableMinutes };
}

export function budgetOf(view: ProjectBudgetView): BudgetBlock {
  return {
    budgetHours: view.budgetHours,
    trackedHours: view.trackedHours,
    remainingHours: view.remainingHours,
    percentBp: view.burn?.percentBp ?? null,
    status: view.burn?.status ?? null,
  };
}

const INVOICED_STATES: ReadonlySet<string> = new Set(['sent', 'partially_paid', 'paid']);

/** Fold a client's invoices into per-currency totals (currency ascending). Drafts and voids are not invoiced. */
export function clientMoneyOf(
  invoices: readonly Pick<
    InvoiceSummary,
    'state' | 'currency' | 'totalMinor' | 'paidMinor' | 'amountDueMinor' | 'overdue'
  >[],
  complete: boolean,
): ClientMoneyBlock {
  const byCurrency = new Map<string, CurrencyTotals>();
  for (const invoice of invoices) {
    if (!INVOICED_STATES.has(invoice.state)) continue;
    const sum = byCurrency.get(invoice.currency) ?? {
      currency: invoice.currency,
      invoicedMinor: 0,
      paidMinor: 0,
      dueMinor: 0,
      overdueMinor: 0,
      overdueCount: 0,
    };
    byCurrency.set(invoice.currency, {
      currency: invoice.currency,
      invoicedMinor: sum.invoicedMinor + invoice.totalMinor,
      paidMinor: sum.paidMinor + invoice.paidMinor,
      dueMinor: sum.dueMinor + invoice.amountDueMinor,
      overdueMinor: sum.overdueMinor + (invoice.overdue ? invoice.amountDueMinor : 0),
      overdueCount: sum.overdueCount + (invoice.overdue ? 1 : 0),
    });
  }
  return {
    totals: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    complete,
  };
}

/** `YYYY-MM-DD` ascending, undated last. */
function compareDueOn(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}
