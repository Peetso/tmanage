'use client';

import type { ReactNode } from 'react';
import { StateCapsule } from '@tmanage/ui';
import type { ProjectHealthReason } from '../../lib/api/client-summary';
import {
  STALE_APPROVAL_DAYS,
  riskSeverity,
  type RiskLine,
  type RisksModel,
} from './overview-model';
import { useOverviewCopy, type OverviewCopy } from './use-overview-copy';
import type { OverviewFormat } from './use-overview-format';
import { OverviewCard, OverviewEmpty, OverviewRow, OverviewRows } from './OverviewCard';

/**
 * ONEPAGE Risks (Figma 739:40646): one line per fact that needs a look, each saying what and why,
 * with Blocked "Late" or Waiting "Watch" (review fix 10). Read from project health, the risk
 * register and the summary; where `business_briefing` is on, the open signals the viewer may see
 * are more lines of the same kind, one per briefing group (B10, `signal-risk-lines.ts`).
 */
export function RisksBlock({
  model,
  format,
}: {
  readonly model: RisksModel;
  readonly format: OverviewFormat;
}) {
  const copy = useOverviewCopy();
  return (
    <OverviewCard
      block="risks"
      title={copy.text('Overview.risks')}
      link={{ href: model.link.href, label: copy.link(model.link.kind) }}
    >
      {model.lines.length === 0 ? (
        <OverviewEmpty>{copy.text('Overview.risksEmpty')}</OverviewEmpty>
      ) : (
        <OverviewRows>
          {model.lines.map((line) => {
            const { title, meta } = riskWords(line, copy, format);
            return (
              <OverviewRow
                key={riskKey(line)}
                title={title}
                href={line.href}
                {...(meta ? { meta } : {})}
                end={
                  riskSeverity(line) === 'late' ? (
                    <StateCapsule state="blocked">{copy.text('Overview.riskLate')}</StateCapsule>
                  ) : (
                    <StateCapsule state="waiting">{copy.text('Overview.riskWatch')}</StateCapsule>
                  )
                }
              />
            );
          })}
        </OverviewRows>
      )}
    </OverviewCard>
  );
}

function riskKey(line: RiskLine): string {
  if (line.kind === 'projectBehind' || line.kind === 'projectAtRisk') {
    return `${line.kind}:${line.href}`;
  }
  if (line.kind === 'overdueInvoices') return `${line.kind}:${line.currency}`;
  if (line.kind === 'signal') return `${line.kind}:${line.group}`;
  return line.kind;
}

function riskWords(
  line: RiskLine,
  copy: OverviewCopy,
  format: OverviewFormat,
): { title: ReactNode; meta?: ReactNode } {
  switch (line.kind) {
    case 'lateWork':
      return {
        title: copy.count(
          'Overview.riskLateWorkOne',
          'Overview.riskLateWorkMany',
          line.count,
          format.count(line.count),
        ),
        meta: copy.text('Overview.riskLateWorkMeta'),
      };
    case 'overdueMilestones':
      return {
        title: copy.count(
          'Overview.riskMilestonesOne',
          'Overview.riskMilestonesMany',
          line.count,
          format.count(line.count),
        ),
        meta: copy.text('Overview.riskMilestonesMeta'),
      };
    case 'highRisks':
      return {
        title: copy.count(
          'Overview.riskHighOne',
          'Overview.riskHighMany',
          line.count,
          format.count(line.count),
        ),
        meta: copy.text('Overview.riskRegisterMeta'),
      };
    case 'openRisks':
      return {
        title: copy.count(
          'Overview.riskOpenOne',
          'Overview.riskOpenMany',
          line.count,
          format.count(line.count),
        ),
        meta: copy.text('Overview.riskRegisterMeta'),
      };
    case 'budget':
      return {
        title: copy.fill('Overview.riskBudget', { percent: format.count(line.percent) }),
        meta: copy.isolated('Overview.riskBudgetMeta', {
          tracked: format.count(Math.round(line.trackedHours)),
          budget: format.count(Math.round(line.budgetHours)),
        }),
      };
    case 'staleApprovals': {
      const days = format.count(STALE_APPROVAL_DAYS);
      return {
        title:
          line.count === 1
            ? copy.fill('Overview.riskStaleOne', { days })
            : copy.fill('Overview.riskStaleMany', { count: format.count(line.count), days }),
        meta: copy.isolated('Overview.riskStaleMeta', { title: line.oldestTitle }),
      };
    }
    case 'projectBehind':
    case 'projectAtRisk':
      return {
        title: copy.isolated(
          line.kind === 'projectBehind'
            ? 'Overview.riskProjectBehind'
            : 'Overview.riskProjectAtRisk',
          { name: line.name },
        ),
        ...(line.reason ? { meta: reasonWords(line.reason, copy, format) } : {}),
      };
    case 'signal':
      return {
        title: copy.count(
          `Overview.signal.${line.group}One`,
          `Overview.signal.${line.group}Many`,
          line.count,
          format.count(line.count),
        ),
        meta: copy.fill(`Overview.signal.${line.group}Meta`, {
          threshold: format.count(line.threshold),
        }),
      };
    case 'overdueInvoices':
      return {
        title: copy.count(
          'Overview.riskInvoicesOne',
          'Overview.riskInvoicesMany',
          line.count,
          format.count(line.count),
        ),
        meta: <bdi>{format.money(line.amountMinor, line.currency)}</bdi>,
      };
  }
}

/** D7: why a project is behind or needs attention, as the health signal that cost it most. */
const REASON_KEYS = {
  overdueMilestones: ['Overview.riskMilestonesOne', 'Overview.riskMilestonesMany'],
  highRisks: ['Overview.riskHighOne', 'Overview.riskHighMany'],
  openRisks: ['Overview.riskOpenOne', 'Overview.riskOpenMany'],
  missedObjectives: ['Overview.reasonObjectivesOne', 'Overview.reasonObjectivesMany'],
} as const satisfies Record<ProjectHealthReason['kind'], readonly [string, string]>;

function reasonWords(reason: ProjectHealthReason, copy: OverviewCopy, format: OverviewFormat) {
  const [one, many] = REASON_KEYS[reason.kind];
  return copy.count(one, many, reason.count, format.count(reason.count));
}
