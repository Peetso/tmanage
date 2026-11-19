import type { SignalBriefingGroup } from '@tmanage/domain';
import type { SummarySignalGroup, SummarySignals } from '../../lib/api/project-summary';
import type { RiskLine } from './overview-model';
import { projectDeliverablesHref, projectWorkHref } from './overview-links';

/**
 * B10 — the open signals as Risks lines: one line per Home-briefing group, in the briefing's
 * order, its number the signals behind it on this page. The summary already applied the
 * briefing's rule (who may see which signal, money groups only with finance) and the
 * `business_briefing` flag: no signals key, no lines, and the block is exactly today's.
 *
 * A group whose fact the block already states from its own source is not said twice: over budget
 * beside the budget line, waiting on clients beside the stale-approvals line, money to collect
 * beside the overdue-invoices line.
 */

/** The project page's project; `null` on the client page. */
export interface SignalScope {
  readonly org: string;
  readonly projectId: string | null;
}

/** The groups the block already says from its own facts, given the lines it drew. */
export function groupsSaidElsewhere(lines: readonly RiskLine[]): ReadonlySet<SignalBriefingGroup> {
  const said = new Set<SignalBriefingGroup>();
  for (const line of lines) {
    if (line.kind === 'budget') said.add('over_budget');
    if (line.kind === 'staleApprovals') said.add('waiting_on_clients');
    if (line.kind === 'overdueInvoices') said.add('money_to_collect');
  }
  return said;
}

/**
 * Where a line opens: the summary's path (the one record, or the group's full list), kept to the
 * project on the project page when the group holds more than one task or approval.
 */
function hrefOf(group: SummarySignalGroup, scope: SignalScope): string {
  const { org, projectId } = scope;
  if (projectId !== null && group.count > 1) {
    if (group.group === 'stale_work' || group.group === 'projects_at_risk') {
      return projectWorkHref(org, projectId);
    }
    if (group.group === 'waiting_on_clients') return projectDeliverablesHref(org, projectId);
  }
  return `/${org}${group.path}`;
}

export function signalRiskLines(
  signals: SummarySignals | undefined,
  scope: SignalScope,
  said: ReadonlySet<SignalBriefingGroup>,
): readonly RiskLine[] {
  if (!signals) return [];
  return signals.groups
    .filter((group) => group.count > 0 && !said.has(group.group))
    .map((group) => ({
      kind: 'signal',
      group: group.group,
      count: group.count,
      threshold: group.threshold,
      href: hrefOf(group, scope),
    }));
}
