import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { MalwareScanner } from '../../common/scan/malware-scanner.js';
import type { AuditService } from '../audit/audit.service.js';
import { readResolvedFlags } from '../admin/feature-gate.js';
import { ApprovalsRepository } from '../approvals/approvals.repository.js';
import { ClientProjectionsRepository } from '../approvals/client-projections.repository.js';
import { DeliverableVersionsRepository } from '../approvals/deliverable-versions.repository.js';
import { DeliverablesRepository } from '../approvals/deliverables.repository.js';
import { DeliverablesService } from '../approvals/deliverables.service.js';
import { ProjectMilestonesRepository } from '../clients/project-milestones.repository.js';
import { ProjectMilestonesService } from '../clients/project-milestones.controller.js';
import { FileAssetsRepository } from '../files/file-assets.repository.js';
import { ClientFileSharing } from '../files/client-file-sharing.js';
import { FileFoldersService } from '../files/folders.service.js';
import { ClientInvoicesRepository } from '../finance/client-invoices.repository.js';
import { ClientInvoicesService } from '../finance/client-invoices.service.js';
import { DocumentSequenceService } from '../finance/document-sequences.js';
import { FinanceRepository } from '../finance/finance.repository.js';
import { NotificationsRepository } from '../inbox/notifications.repository.js';
import { FinanceReportsRepository } from '../insights/finance-reports.repository.js';
import { FinanceReportsService } from '../insights/finance-reports.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { WorkItemsService } from '../work/work-items.service.js';
import { BudgetBurnRepository } from './budget-burn.repository.js';
import { BudgetBurnService } from './budget-burn.service.js';
import { ProjectBudgetRepository } from './budget.repository.js';
import { ProjectBudgetService } from './budget.service.js';
import { ProjectHealthService } from './health.service.js';
import { ProjectPortfolioPlanningRepository } from './portfolio.repository.js';
import { ProjectsRepository } from './projects.repository.js';
import type { FlagReader } from './summary-access.js';
import { SummarySignalsReader } from './summary-signals.js';

/**
 * ONEPAGE (B01). The existing read services the one-page summaries compose, each narrowed to the
 * single read a block uses. The summaries never reach a repository or a table of their own: each
 * figure comes through the service that owns it, with that service's tenant filter and relation
 * rule.
 */
/** D4: the client company a project is shared with (the first by name), as the portfolio names it. */
export type ProjectClientReader = (
  context: TenantContext,
  projectId: string,
) => Promise<{ readonly id: string; readonly name: string } | null>;

export interface SummarySources {
  readonly health: Pick<ProjectHealthService, 'get'>;
  readonly work: Pick<WorkItemsService, 'list'>;
  readonly milestones: Pick<ProjectMilestonesService, 'listInternal'>;
  readonly deliverables: Pick<DeliverablesService, 'list'>;
  readonly files: Pick<FileFoldersService, 'listProjectFiles'>;
  readonly burn: Pick<BudgetBurnService, 'burn'>;
  readonly budget: Pick<ProjectBudgetService, 'get'>;
  readonly financeReports: Pick<FinanceReportsService, 'profitability' | 'unbilled'>;
  readonly invoices: Pick<ClientInvoicesService, 'list'>;
  /** B10: the open signals the Risks block lists, behind `business_briefing` (its own gate). */
  readonly signals: Pick<SummarySignalsReader, 'forProject' | 'forClient'>;
  /** D4: called only after the project itself was authorised (the portfolio's own rule). */
  readonly projectClient: ProjectClientReader;
  readonly flags: FlagReader;
}

/** The global dependencies the source services are constructed with. */
export interface SummarySourceDependencies {
  readonly database: TenantDatabase;
  readonly audit: AuditService;
  readonly outbox: OutboxEventsRepository;
  readonly scanner: MalwareScanner;
}

/**
 * Build the sources exactly as their own modules construct them (stateless repositories over the
 * global tenant database), the codebase's convention for a module that reads another module's
 * service without importing — and so duplicating — that dynamic module. Only reads are reachable
 * through {@link SummarySources}.
 */
export function buildSummarySources(deps: SummarySourceDependencies): SummarySources {
  const { database, audit, outbox, scanner } = deps;
  const projects = new ProjectsRepository();
  const finance = new FinanceRepository();
  const flags: FlagReader = (context) => readResolvedFlags(database, context);
  return {
    health: new ProjectHealthService(database),
    work: new WorkItemsService(database, new WorkItemsRepository(), audit, projects, outbox),
    milestones: new ProjectMilestonesService(database, projects, new ProjectMilestonesRepository()),
    deliverables: new DeliverablesService(
      database,
      new DeliverablesRepository(),
      new DeliverableVersionsRepository(),
      new ApprovalsRepository(),
      new ClientProjectionsRepository(),
      projects,
      outbox,
      audit,
      new ClientFileSharing(scanner),
    ),
    files: new FileFoldersService(
      database,
      new FileAssetsRepository(),
      projects,
      undefined,
      scanner,
    ),
    burn: new BudgetBurnService(database),
    budget: new ProjectBudgetService(database, new ProjectBudgetRepository(), projects, {
      audit,
      burn: new BudgetBurnRepository(),
    }),
    financeReports: new FinanceReportsService({
      database,
      repository: new FinanceReportsRepository(),
      budgets: new BudgetBurnRepository(),
      audit,
    }),
    invoices: new ClientInvoicesService({
      database,
      repository: new ClientInvoicesRepository(),
      finance,
      sequences: new DocumentSequenceService(finance),
      notifications: new NotificationsRepository(),
      audit,
    }),
    signals: new SummarySignalsReader(database, flags),
    projectClient: projectClientReader(database),
    flags,
  };
}

function projectClientReader(database: TenantDatabase): ProjectClientReader {
  const planning = new ProjectPortfolioPlanningRepository();
  return async (context, projectId) => {
    const [row] = await database.read(context, (runner) =>
      planning.clients(runner, context, [projectId]),
    );
    return row === undefined ? null : { id: row.clientOrganizationId, name: row.clientName };
  };
}
