import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ProjectsService, ProjectView } from './projects.service.js';
import { holds, presentOnly, readBlock, requireInternal } from './summary-access.js';
import {
  approvalsOf,
  budgetOf,
  deliveryOf,
  filesOf,
  healthOf,
  milestoneOf,
  timeOf,
} from './summary-blocks.js';
import type {
  ApprovalsBlock,
  BudgetBlock,
  DeliveryBlock,
  FilesBlock,
  HealthBlock,
  MilestoneBlock,
  ProjectMoneyBlock,
  TimeBlock,
} from './summary-blocks.js';
import { readableWork } from './summary-reads.js';
import type { SummarySignalsBlock } from './summary-signals.js';
import type { SummarySources } from './summary-sources.js';

/** The DI token the projects module provides {@link ProjectSummaryService} under. */
export const PROJECT_SUMMARY_SERVICE = Symbol.for('tmanage.ProjectSummaryService');

/** The project header every reader of the page sees. `organizationId` is deliberately absent. */
export interface ProjectSummaryHeader {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly committedAt: string | null;
  readonly forecastAt: string | null;
  readonly archivedAt: string | null;
}

/** ONEPAGE: one project on one page. A block the viewer may not read is absent, not empty. */
export interface ProjectSummaryView {
  readonly project: ProjectSummaryHeader;
  readonly delivery?: DeliveryBlock;
  readonly milestone?: MilestoneBlock;
  readonly health?: HealthBlock;
  readonly approvals?: ApprovalsBlock;
  readonly files?: FilesBlock;
  readonly time?: TimeBlock;
  readonly budget?: BudgetBlock;
  readonly money?: ProjectMoneyBlock;
  /** B10: the project's open signals as briefing groups, only where `business_briefing` is on. */
  readonly signals?: SummarySignalsBlock;
}

/**
 * ONEPAGE (B01). The one read behind the project page: the project, then each block from the
 * existing service that owns it.
 *
 * The parent is authorised first through `ProjectsService.get`, so an unreadable or foreign project
 * is the same 404 as a missing one and no block is read for it. Each block is then gated on the
 * capability its own full screen asks for (`summary-access.ts`), and its source applies its relation
 * rule again: work, health, approvals and time on `work.read`; files on `file.download`; milestones
 * and budget on `project.manage`; money on `finance.view` with the `finance_reports` flag on;
 * signals through `summary-signals.ts` (the Home briefing narrowed to the project).
 *
 * Reads run one after another on purpose: one page view holds at most one pooled connection.
 */
export class ProjectSummaryService {
  constructor(
    private readonly projects: Pick<ProjectsService, 'get'>,
    private readonly sources: SummarySources,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ProjectSummaryView> {
    requireInternal(principal);
    const project = await this.projects.get(context, principal, projectId);
    const { sources } = this;
    const may = (capability: Parameters<typeof holds>[2]) =>
      holds(principal, context, capability, project.id);

    const delivery = may('work.read')
      ? await readBlock(async () => {
          const walked = await readableWork(sources.work, context, principal, project.id);
          return deliveryOf(walked.items, this.now(), walked.complete);
        })
      : undefined;
    const milestone = may('project.manage')
      ? await readBlock(async () =>
          milestoneOf(await sources.milestones.listInternal(context, principal, project.id)),
        )
      : undefined;
    const health = may('work.read')
      ? await readBlock(async () =>
          healthOf(await sources.health.get(context, principal, project.id)),
        )
      : undefined;
    const approvals = may('work.read')
      ? await readBlock(async () =>
          approvalsOf(await sources.deliverables.list(context, principal, project.id)),
        )
      : undefined;
    const files = may('file.download')
      ? await readBlock(async () =>
          filesOf(await sources.files.listProjectFiles(context, principal, project.id)),
        )
      : undefined;
    const time = may('work.read')
      ? await readBlock(async () =>
          timeOf(await sources.burn.burn(context, principal, project.id, {})),
        )
      : undefined;
    const budget = may('project.manage')
      ? await readBlock(async () =>
          budgetOf(await sources.budget.get(context, principal, project.id)),
        )
      : undefined;
    const money = await this.money(context, principal, project.id);
    const signals = await readBlock(() =>
      sources.signals.forProject(context, principal, project.id),
    );

    return {
      project: headerOf(project),
      ...presentOnly({
        delivery,
        milestone,
        health,
        approvals,
        files,
        time,
        budget,
        money,
        signals,
      }),
    };
  }

  /** Invoiced and not-yet-invoiced, from the finance reports. Finance capability and flag only. */
  private async money(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ProjectMoneyBlock | undefined> {
    if (!holds(principal, context, 'finance.view', null)) return undefined;
    if (!(await this.sources.flags(context)).finance_reports) return undefined;
    return readBlock(async () => {
      const reports = this.sources.financeReports;
      const profitability = await reports.profitability(context, principal, { by: 'project' });
      const unbilled = await reports.unbilled(context, principal, { by: 'project' });
      const row = profitability.rows.find((entry) => entry.projectId === projectId);
      const open = unbilled.rows.find((entry) => entry.projectId === projectId);
      return {
        from: profitability.from,
        to: profitability.to,
        currency: profitability.currency,
        invoicedMinor: row?.invoicedMinor ?? 0,
        unbilledMinor: row?.unbilledMinor ?? 0,
        unbilledMinutes: open?.minutes ?? 0,
        truncated: profitability.truncated || unbilled.truncated,
      };
    });
  }
}

function headerOf(project: ProjectView): ProjectSummaryHeader {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    committedAt: project.committedAt,
    forecastAt: project.forecastAt,
    archivedAt: project.archivedAt,
  };
}
