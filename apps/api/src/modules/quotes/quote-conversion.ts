import type { QuoteLineRow, QuoteRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { ProjectClientsRepository } from '../clients/project-clients.repository.js';
import { ProjectMilestonesRepository } from '../clients/project-milestones.repository.js';
import { WorkspacesRepository } from '../tenancy/workspaces.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';

/**
 * 52-08 — "Convert to project": what an accepted quote becomes, and the writes that make it.
 *
 * The plan is pure: the project is named after the quote (`Q-0007 · Website`), it gets one
 * milestone carrying the same name (no date: nobody has committed one yet), and every quote line
 * becomes one work item in line order. Prices stay on the quote; a work item carries the work only.
 */

const MAX_PROJECT_NAME = 190;
const MAX_WORK_TITLE = 300;

export interface ConversionPlan {
  readonly projectName: string;
  readonly milestoneTitle: string;
  readonly workItemTitles: readonly string[];
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export function conversionPlan(quote: QuoteRow, lines: readonly QuoteLineRow[]): ConversionPlan {
  const name = clip(`${quote.number} · ${quote.title}`, MAX_PROJECT_NAME);
  return {
    projectName: name,
    milestoneTitle: name,
    workItemTitles: [...lines]
      .sort((a, b) => a.position - b.position)
      .map((line) => clip(line.description, MAX_WORK_TITLE))
      .filter((title) => title !== ''),
  };
}

/** The writes behind a conversion, all inside the caller's transaction. A test passes a fake. */
export interface QuoteConversionWriter {
  /** The workspace to file the project in: `requested` when it is a live workspace here, else the first one. */
  workspaceFor(
    tx: TenantQueryRunner,
    context: TenantContext,
    requested: string | null,
  ): Promise<string | null>;
  shareWithClient(
    tx: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    clientOrganizationId: string,
  ): Promise<string>;
  addMilestone(
    tx: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    title: string,
    description: string,
  ): Promise<void>;
  addWorkItem(
    tx: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    title: string,
  ): Promise<void>;
}

export function repositoryConversionWriter(): QuoteConversionWriter {
  const workspaces = new WorkspacesRepository();
  const shares = new ProjectClientsRepository();
  const milestones = new ProjectMilestonesRepository();
  const workItems = new WorkItemsRepository();
  return {
    async workspaceFor(tx, context, requested) {
      if (requested !== null) {
        const found = await workspaces.findById(tx, context, requested);
        return found !== null && found.archivedAt === null ? found.id : null;
      }
      return (await workspaces.list(tx, context, { limit: 1 }))[0]?.id ?? null;
    },
    async shareWithClient(tx, context, projectId, clientOrganizationId) {
      return (await shares.share(tx, context, { projectId, clientOrganizationId })).id;
    },
    async addMilestone(tx, context, projectId, title, description) {
      await milestones.create(tx, context, {
        projectId,
        title,
        description,
        dueOn: null,
        status: 'planned',
        published: false,
        createdByUserId: context.userId,
      });
    },
    async addWorkItem(tx, context, projectId, title) {
      await workItems.create(tx, context, { projectId, title });
    },
  };
}
