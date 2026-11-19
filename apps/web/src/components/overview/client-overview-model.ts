import type { ClientSummary, SummaryCurrencyTotals } from '../../lib/api/client-summary';
import {
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
  approvalsInboxHref,
  clientViewHref,
  deliverableHref,
  fileHref,
  filesHref,
  invoicesHref,
  projectHref,
  timesheetsHref,
} from './overview-links';

/**
 * ONEPAGE — the client summary read as the six blocks of the client company page.
 *
 * Pure, and it keeps the server's absence like the project mapper. Money lines (overdue invoices,
 * "not invoiced yet") come only from the finance-gated `money` / `unbilled` blocks (review fix 1).
 * The summary carries no logged time per client, so the Time card holds only the finance figure and
 * is absent without it.
 */
export function clientOverviewModel(
  summary: ClientSummary,
  organizationSlug: string,
  now: Date,
): OverviewModel {
  const org = organizationSlug;
  const names = new Map(summary.projects.items.map((project) => [project.id, project.name]));
  const delivery = deliveryBlock(summary, org);
  const approvals = approvalsBlock(summary, org, names);
  const risks = risksBlock(summary, org, now);
  const files = filesBlock(summary, org, names);
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

/** Projects at risk first (red, then amber), so the rows a card can hold are the ones that matter. */
const BAND_ORDER = { red: 0, amber: 1, green: 2, neutral: 3 } as const;

function deliveryBlock(summary: ClientSummary, org: string): DeliveryModel | undefined {
  const { delivery } = summary;
  if (!delivery) return undefined;
  const rows = summary.projects.items
    .slice()
    .sort((left, right) => BAND_ORDER[left.band ?? 'neutral'] - BAND_ORDER[right.band ?? 'neutral'])
    .slice(0, OVERVIEW_ROW_LIMIT)
    .map((project) => ({
      kind: 'project' as const,
      id: project.id,
      name: project.name,
      href: projectHref(org, project.id),
      ...(project.band ? { band: project.band } : {}),
    }));
  return {
    link: { kind: 'openProjects', href: clientViewHref(org, summary.client.id, 'projects') },
    open: delivery.open,
    late: delivery.late,
    done: delivery.done,
    complete: delivery.complete && !summary.projects.truncated,
    rows,
  };
}

function approvalsBlock(
  summary: ClientSummary,
  org: string,
  names: ReadonlyMap<string, string>,
): ApprovalsModel | undefined {
  const { approvals } = summary;
  if (!approvals) return undefined;
  return {
    link: { kind: 'openApprovals', href: approvalsInboxHref(org) },
    waitingOnTeam: approvals.waitingOnTeam,
    waitingOnClient: approvals.waitingOnClient,
    items: approvals.items.slice(0, OVERVIEW_ROW_LIMIT).map((item) => {
      const context = names.get(item.projectId);
      return {
        id: item.deliverableId,
        title: item.title,
        href: deliverableHref(org, item.projectId, item.deliverableId),
        waitingOn: item.waitingOn,
        since: item.since,
        ...(context ? { context } : {}),
      };
    }),
  };
}

function risksBlock(summary: ClientSummary, org: string, now: Date): RisksModel | undefined {
  const banded = summary.projects.items.some((project) => project.band !== undefined);
  const { approvals, money } = summary;
  if (!banded && !approvals && !money) return undefined;
  const lines: RiskLine[] = [];

  for (const project of summary.projects.items) {
    const href = projectHref(org, project.id);
    if (project.band === 'red') lines.push({ kind: 'projectBehind', name: project.name, href });
  }
  for (const project of summary.projects.items) {
    const href = projectHref(org, project.id);
    if (project.band === 'amber') lines.push({ kind: 'projectAtRisk', name: project.name, href });
  }
  if (money) {
    for (const totals of money.totals) {
      if (totals.overdueCount > 0) {
        lines.push({
          kind: 'overdueInvoices',
          count: totals.overdueCount,
          currency: totals.currency,
          amountMinor: totals.overdueMinor,
          href: invoicesHref(org),
        });
      }
    }
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
        href: approvalsInboxHref(org),
      });
    }
  }

  return {
    // Review fix 9: there is no client-level health screen; this opens the projects at risk.
    link: {
      kind: 'seeProjectsAtRisk',
      href: clientViewHref(org, summary.client.id, 'projects', { atRisk: true }),
    },
    lines,
  };
}

function filesBlock(
  summary: ClientSummary,
  org: string,
  names: ReadonlyMap<string, string>,
): FilesModel | undefined {
  const { files } = summary;
  if (!files) return undefined;
  return {
    link: { kind: 'openFiles', href: filesHref(org) },
    items: files.items.slice(0, OVERVIEW_ROW_LIMIT).map((file) => {
      const context = names.get(file.projectId);
      return {
        id: file.id,
        name: file.name,
        href: fileHref(org, file.id),
        updatedAt: file.updatedAt,
        ...(context ? { context } : {}),
      };
    }),
  };
}

function timeBlock(summary: ClientSummary, org: string): TimeModel | undefined {
  const { unbilled } = summary;
  if (!unbilled) return undefined;
  return {
    link: { kind: 'openTimesheets', href: timesheetsHref(org) },
    unbilledMinutes: unbilled.minutes,
  };
}

/** The currency with the most invoiced is the one the card shows; the rest are counted. */
function leadingTotals(
  totals: readonly SummaryCurrencyTotals[],
): SummaryCurrencyTotals | undefined {
  return totals.slice().sort((left, right) => right.invoicedMinor - left.invoicedMinor)[0];
}

function moneyBlock(summary: ClientSummary, org: string): MoneyModel | undefined {
  const { money } = summary;
  if (!money) return undefined;
  const lead = leadingTotals(money.totals);
  const link = { kind: 'openInvoices' as const, href: invoicesHref(org) };
  if (!lead) return { link, currency: null, invoicedMinor: 0, moreCurrencies: 0 };
  return {
    link,
    currency: lead.currency,
    invoicedMinor: lead.invoicedMinor,
    paidMinor: lead.paidMinor,
    overdueMinor: lead.overdueMinor,
    overdueCount: lead.overdueCount,
    moreCurrencies: money.totals.length - 1,
  };
}
