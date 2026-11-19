import type { ProjectSummary } from '../../lib/api/project-summary';
import {
  BUDGET_WATCH_BP,
  OVERVIEW_ROW_LIMIT,
  STALE_APPROVAL_DAYS,
  daysSince,
  type ApprovalsModel,
  type DeliveryModel,
  type FilesModel,
  type MoneyModel,
  type OverviewModel,
  type RiskLine,
  type RisksModel,
  type TimeModel,
} from './overview-model';
import {
  deliverableHref,
  fileHref,
  invoicesHref,
  projectDeliverablesHref,
  projectFilesHref,
  projectMilestonesHref,
  projectRiskRegisterHref,
  projectWorkHref,
  timesheetsHref,
} from './overview-links';

/**
 * ONEPAGE — the project summary read as the six blocks of the project overview.
 *
 * Pure: the same summary and `now` give the same model. Every block keeps the server's absence: a
 * key the summary left out stays out. Money-derived facts (budget use, "not invoiced yet") appear
 * only when the summary carried the finance-gated `money` block (review FIGMA-C fix 1), so a viewer
 * without finance sees no money anywhere, not only no Money card.
 */
export function projectOverviewModel(
  summary: ProjectSummary,
  organizationSlug: string,
  now: Date,
): OverviewModel {
  const org = organizationSlug;
  const delivery = deliveryBlock(summary, org);
  const approvals = approvalsBlock(summary, org);
  const risks = risksBlock(summary, org, now);
  const files = filesBlock(summary, org);
  const time = timeBlock(summary, org);
  const money = moneyBlock(summary, org);
  return {
    ...(delivery ? { delivery } : {}),
    ...(approvals ? { approvals } : {}),
    ...(risks ? { risks } : {}),
    ...(files ? { files } : {}),
    ...(time ? { time } : {}),
    ...(money ? { money } : {}),
  };
}

function deliveryBlock(summary: ProjectSummary, org: string): DeliveryModel | undefined {
  const { delivery, milestone, health } = summary;
  if (!delivery) return undefined;
  const projectId = summary.project.id;
  const next = milestone?.next ?? null;
  return {
    link: { kind: 'openWork', href: projectWorkHref(org, projectId) },
    open: delivery.open,
    late: delivery.late,
    done: delivery.done,
    complete: delivery.complete,
    rows: next
      ? [
          {
            kind: 'nextMilestone',
            id: next.id,
            title: next.title,
            dueOn: next.dueOn,
            href: projectMilestonesHref(org, projectId),
            ...(health ? { band: health.band } : {}),
          },
        ]
      : [],
  };
}

function approvalsBlock(summary: ProjectSummary, org: string): ApprovalsModel | undefined {
  const { approvals } = summary;
  if (!approvals) return undefined;
  return {
    link: { kind: 'openApprovals', href: projectDeliverablesHref(org, summary.project.id) },
    waitingOnTeam: approvals.waitingOnTeam,
    waitingOnClient: approvals.waitingOnClient,
    items: approvals.items.slice(0, OVERVIEW_ROW_LIMIT).map((item) => ({
      id: item.deliverableId,
      title: item.title,
      href: deliverableHref(org, item.projectId, item.deliverableId),
      waitingOn: item.waitingOn,
      since: item.since,
    })),
  };
}

/**
 * Risks today read project health (milestones, the risk register) and the summary's own facts;
 * B10 adds the open signals here. Present whenever one of its work-level sources is.
 */
function risksBlock(summary: ProjectSummary, org: string, now: Date): RisksModel | undefined {
  const { health, delivery, approvals, budget, money } = summary;
  if (!health && !delivery && !approvals) return undefined;
  const projectId = summary.project.id;
  const register = projectRiskRegisterHref(org, projectId);
  const lines: RiskLine[] = [];

  if (delivery && delivery.late > 0) {
    lines.push({ kind: 'lateWork', count: delivery.late, href: projectWorkHref(org, projectId) });
  }
  if (health && health.overdueMilestones > 0) {
    lines.push({
      kind: 'overdueMilestones',
      count: health.overdueMilestones,
      href: projectMilestonesHref(org, projectId),
    });
  }
  if (health && health.highRisks > 0) {
    lines.push({ kind: 'highRisks', count: health.highRisks, href: register });
  } else if (health && health.openRisks > 0) {
    lines.push({ kind: 'openRisks', count: health.openRisks, href: register });
  }
  // Budget use is a money fact: only with the finance-gated block (review fix 1).
  if (
    money &&
    budget &&
    budget.percentBp !== null &&
    budget.budgetHours !== null &&
    budget.percentBp >= BUDGET_WATCH_BP
  ) {
    lines.push({
      kind: 'budget',
      percent: Math.round(budget.percentBp / 100),
      trackedHours: budget.trackedHours,
      budgetHours: budget.budgetHours,
      href: register,
    });
  }
  if (approvals) {
    const stale = approvals.items.filter(
      (item) => item.waitingOn === 'client' && daysSince(item.since, now) > STALE_APPROVAL_DAYS,
    );
    const oldest = stale[0];
    if (oldest) {
      lines.push({
        kind: 'staleApprovals',
        count: stale.length,
        oldestTitle: oldest.title,
        href: projectDeliverablesHref(org, projectId),
      });
    }
  }

  return { link: { kind: 'openHealth', href: register }, lines };
}

function filesBlock(summary: ProjectSummary, org: string): FilesModel | undefined {
  const { files } = summary;
  if (!files) return undefined;
  return {
    link: { kind: 'openFiles', href: projectFilesHref(org, summary.project.id) },
    items: files.items.slice(0, OVERVIEW_ROW_LIMIT).map((file) => ({
      id: file.id,
      name: file.name,
      href: fileHref(org, file.id),
      updatedAt: file.updatedAt,
    })),
  };
}

function timeBlock(summary: ProjectSummary, org: string): TimeModel | undefined {
  const { time, money } = summary;
  if (!time) return undefined;
  return {
    link: { kind: 'openTimesheets', href: timesheetsHref(org) },
    loggedMinutes: time.loggedMinutes,
    billableMinutes: time.billableMinutes,
    ...(money ? { unbilledMinutes: money.unbilledMinutes } : {}),
  };
}

function moneyBlock(summary: ProjectSummary, org: string): MoneyModel | undefined {
  const { money } = summary;
  if (!money) return undefined;
  return {
    link: { kind: 'openInvoices', href: invoicesHref(org) },
    currency: money.currency,
    invoicedMinor: money.invoicedMinor,
    unbilledMinor: money.unbilledMinor,
    moreCurrencies: 0,
  };
}
