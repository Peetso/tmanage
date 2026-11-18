import type { Capability, Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ProjectHealthView } from '../projects/health.service.js';
import { holds, presentOnly, readBlock, requireInternal } from '../projects/summary-access.js';
import {
  approvalsOf,
  clientMoneyOf,
  deliveryOf,
  filesOf,
  sumDelivery,
} from '../projects/summary-blocks.js';
import type {
  ApprovalsBlock,
  ClientMoneyBlock,
  DeliveryBlock,
  FilesBlock,
  UnbilledBlock,
} from '../projects/summary-blocks.js';
import { clientInvoices, readableWork } from '../projects/summary-reads.js';
import type { SummarySources } from '../projects/summary-sources.js';
import type { ClientsService } from './clients.service.js';
import type { DeliverableView } from '../approvals/deliverables.service.js';
import type { ProjectFileView } from '../files/folders.service.js';

/** The DI token the clients module provides {@link ClientSummaryService} under. */
export const CLIENT_SUMMARY_SERVICE = Symbol.for('tmanage.ClientSummaryService');

/** How many of the client's projects the page folds in; more is the full projects screen. */
export const CLIENT_SUMMARY_PROJECT_LIMIT = 20;

export interface ClientSummaryHeader {
  readonly id: string;
  readonly name: string;
  readonly archivedAt: string | null;
}

/** One of the client's projects; `band` is absent when the viewer may not read its health. */
export interface ClientSummaryProject {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly band?: ProjectHealthView['band'];
}

export interface ClientProjectsBlock {
  readonly items: readonly ClientSummaryProject[];
  /** More projects are shared with the client than the page folds in. */
  readonly truncated: boolean;
}

/** ONEPAGE: one client company on one page. A block the viewer may not read is absent. */
export interface ClientSummaryView {
  readonly client: ClientSummaryHeader;
  readonly projects: ClientProjectsBlock;
  readonly delivery?: DeliveryBlock;
  readonly approvals?: ApprovalsBlock;
  readonly files?: FilesBlock;
  readonly money?: ClientMoneyBlock;
  readonly unbilled?: UnbilledBlock;
}

/**
 * ONEPAGE (B01). The one read behind the client page, composed from the existing services.
 *
 * The client company is authorised first through `ClientsService.getOrganization` (`org.manage`,
 * 404 for a foreign company), and its projects come from `listOrganizationProjects`. A client-level
 * block is present only when the viewer holds its capability across the organization; each
 * project's part is then read through the owning service, which applies its own relation rule, and
 * a project that service refuses contributes nothing. Money comes from the client's invoices
 * (`finance.view`, `client_invoicing` flag) and not-yet-invoiced work from the finance unbilled
 * report (`finance.view`, `finance_reports` flag).
 */
export class ClientSummaryService {
  constructor(
    private readonly clients: Pick<ClientsService, 'getOrganization' | 'listOrganizationProjects'>,
    private readonly sources: SummarySources,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(
    context: TenantContext,
    principal: Principal,
    clientOrganizationId: string,
  ): Promise<ClientSummaryView> {
    requireInternal(principal);
    const client = await this.clients.getOrganization(context, principal, clientOrganizationId);
    const shared = await this.clients.listOrganizationProjects(context, principal, client.id);
    const folded = shared.slice(0, CLIENT_SUMMARY_PROJECT_LIMIT);
    const orgWide = (capability: Capability) => holds(principal, context, capability, null);
    const { sources } = this;

    const projects: ClientSummaryProject[] = [];
    const deliveries: DeliveryBlock[] = [];
    const deliverables: DeliverableView[] = [];
    const files: ProjectFileView[] = [];
    for (const project of folded) {
      const health = orgWide('work.read')
        ? await readBlock(() => sources.health.get(context, principal, project.id))
        : undefined;
      projects.push({
        id: project.id,
        name: project.name,
        status: project.status,
        ...(health === undefined ? {} : { band: health.band }),
      });
      if (orgWide('work.read')) {
        const walked = await readBlock(() =>
          readableWork(sources.work, context, principal, project.id),
        );
        if (walked) deliveries.push(deliveryOf(walked.items, this.now(), walked.complete));
        const rows = await readBlock(() =>
          sources.deliverables.list(context, principal, project.id),
        );
        if (rows) deliverables.push(...rows);
      }
      if (orgWide('file.download')) {
        const rows = await readBlock(() =>
          sources.files.listProjectFiles(context, principal, project.id),
        );
        if (rows) files.push(...rows);
      }
    }

    return {
      client: { id: client.id, name: client.name, archivedAt: client.archivedAt },
      projects: { items: projects, truncated: shared.length > folded.length },
      ...presentOnly({
        delivery: orgWide('work.read') ? sumDelivery(deliveries) : undefined,
        approvals: orgWide('work.read') ? approvalsOf(deliverables) : undefined,
        files: orgWide('file.download') ? filesOf(files) : undefined,
        ...(await this.finance(context, principal, client.id)),
      }),
    };
  }

  /** The finance blocks: `finance.view` across the organization, each behind its source's flag. */
  private async finance(
    context: TenantContext,
    principal: Principal,
    clientOrganizationId: string,
  ): Promise<{
    readonly money?: ClientMoneyBlock | undefined;
    readonly unbilled?: UnbilledBlock | undefined;
  }> {
    if (!holds(principal, context, 'finance.view', null)) return {};
    const flags = await this.sources.flags(context);
    return {
      money: flags.client_invoicing
        ? await this.money(context, principal, clientOrganizationId)
        : undefined,
      unbilled: flags.finance_reports
        ? await this.unbilled(context, principal, clientOrganizationId)
        : undefined,
    };
  }

  /** Invoiced, paid, due and overdue per currency, from the client's invoices. */
  private money(
    context: TenantContext,
    principal: Principal,
    clientOrganizationId: string,
  ): Promise<ClientMoneyBlock | undefined> {
    return readBlock(async () => {
      const walked = await clientInvoices(
        this.sources.invoices,
        context,
        principal,
        clientOrganizationId,
      );
      return clientMoneyOf(walked.items, walked.complete);
    });
  }

  /** Work not yet invoiced for the client, from the finance unbilled report (its default range). */
  private unbilled(
    context: TenantContext,
    principal: Principal,
    clientOrganizationId: string,
  ): Promise<UnbilledBlock | undefined> {
    return readBlock(async () => {
      const report = await this.sources.financeReports.unbilled(context, principal, {
        by: 'client',
      });
      const row = report.rows.find((entry) => entry.clientOrganizationId === clientOrganizationId);
      return {
        from: report.from,
        to: report.to,
        currency: report.currency,
        minutes: row?.minutes ?? 0,
        amountMinor: row?.amountMinor ?? 0,
        truncated: report.truncated,
      };
    });
  }
}
