import { authorize, isInternalRole, PROJECT_CREATOR_ROLE } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  DuplicateProjectTemplateNameError,
  ProjectTemplatesRepository,
} from './templates.repository.js';
import type { CreateProjectTemplateInput } from './templates.repository.js';
import type { ProjectView, ProjectsService } from './projects.service.js';
import type {
  ProjectTemplateMilestone,
  ProjectTemplateRow,
  ProjectTemplateWorkItem,
} from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import { ProjectMembershipsRepository } from './project-memberships.repository.js';
import { ClientOrganizationsRepository } from '../clients/client-organizations.repository.js';
import { ProjectClientsRepository } from '../clients/project-clients.repository.js';
import { ProjectMilestonesRepository } from '../clients/project-milestones.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';

/**
 * The application service for PROJ / module 8 (x234) — reusable project templates. It follows the
 * `OrgObjectivesService` shape: a tenant-owned record with **no project relation**, so authorization is
 * org-scoped, not relation-gated on a project.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question `project.manage`. This service re-checks it
 * against an **org-level** resource (`projectId: null`) with the real `authorize()` evaluator (defence
 * in depth), the same posture {@link OrgObjectivesService} takes: because the resource has no project,
 * the relation gate (§12) does not apply and the decision is the role ceiling and the tenant.
 *
 * ## Instantiate reuses the shared project-create path
 *
 * `instantiate` does not create a project itself — it delegates to {@link ProjectsService.create}, the
 * one project-create path, so a project made from a template is indistinguishable from one made
 * directly and no create guard, audit row or invariant is duplicated or bypassed. The template's
 * `default_objectives_json` is the template's *declared* default objectives, stored for a later slice
 * that seeds them; seeding objectives here would be divergent create logic, which the brief forbids.
 *
 * ## The Known-trap order
 *
 * `instantiate` names a template by id. An unknown or cross-tenant `templateId` is resolved
 * **tenant-scoped before the authorize check**, so it is a 404, never a foreign-key 500 and never a
 * 403 that would tell a caller the template exists.
 */

/** What a caller is allowed to see of a template. `organizationId` is deliberately absent. */
export interface ProjectTemplateView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** The objective titles a project made from this template starts with; `[]` when none declared. */
  readonly defaultObjectives: readonly string[];
  /** A9. How many milestones a project made from it starts with. */
  readonly milestoneCount: number;
  /** A9. How many work items a project made from it starts with. */
  readonly workItemCount: number;
  /** A9. Whether a project made from it is shared with the chosen client. */
  readonly clientPortalOn: boolean;
  /** A9. `monthly` for a retainer; null for a one-off project. */
  readonly repeatInterval: 'monthly' | null;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** A9 — what "New project from a template" sends besides the template id. */
export interface InstantiateProjectTemplateCommand {
  readonly workspaceId: string;
  readonly name?: string;
  /** 'YYYY-MM-DD'. Every template offset counts from it; today when absent. */
  readonly startDate?: string;
  /** The client company the new project is shared with. */
  readonly clientOrganizationId?: string;
  /** The project lead: the project's owner, put on the project as its manager. */
  readonly leadUserId?: string;
}

/** A9 — `start` ('YYYY-MM-DD') moved by `offsetDays`, as 'YYYY-MM-DD'. Calendar arithmetic in UTC. */
export function shiftDay(start: string, offsetDays: number): string {
  const [year, month, day] = start.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

/** Today's calendar day in UTC, 'YYYY-MM-DD'. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). `organization_id`
 * is never echoed into a response body; the nullable JSON column is normalised to an array.
 */
function toView(row: ProjectTemplateRow): ProjectTemplateView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    defaultObjectives: row.defaultObjectivesJson ?? [],
    milestoneCount: row.milestonesJson?.length ?? 0,
    workItemCount: row.workItemsJson?.length ?? 0,
    clientPortalOn: row.clientPortalOn,
    repeatInterval: row.repeatInterval ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export class ProjectTemplatesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly templates: ProjectTemplatesRepository = new ProjectTemplatesRepository(),
    /**
     * The one project-create path. `instantiate` delegates to it rather than writing a second create,
     * so a template-made project carries the same audit row and invariants as any other.
     */
    private readonly projects?: ProjectsService,
    /** A9: the lead grant, the client share and the template copy are audited. */
    private readonly audit?: AuditService,
    private readonly members: MembershipsRepository = new MembershipsRepository(),
    private readonly projectMembers: ProjectMembershipsRepository = new ProjectMembershipsRepository(),
    private readonly clientOrganizations: ClientOrganizationsRepository = new ClientOrganizationsRepository(),
    private readonly shares: ProjectClientsRepository = new ProjectClientsRepository(),
    private readonly milestones: ProjectMilestonesRepository = new ProjectMilestonesRepository(),
    private readonly workItems: WorkItemsRepository = new WorkItemsRepository(),
  ) {}

  /**
   * Re-check `capability` against the org-level resource with the real evaluator, or throw the ordinary
   * 403. `projectId` is `null` — a template has no project — so the relation gate never applies and the
   * decision is the role ceiling and the tenant.
   */
  private authorizeOrg(context: TenantContext, principal: Principal, capability: Capability): void {
    const permitted = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, `denied_${capability}`);
    }
  }

  /**
   * List the tenant's templates the principal may manage, in creation order.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly limit?: number } = {},
  ): Promise<readonly ProjectTemplateView[]> {
    this.authorizeOrg(context, principal, 'project.manage');

    const rows = await this.database.read(context, (runner) =>
      this.templates.list(runner, context, options),
    );
    return rows.map(toView);
  }

  /**
   * Define a template. Gated on `project.manage` at the org level; a name already used in the tenant is
   * a 409 (the repository pre-checks inside the transaction, and the unique key is the backstop).
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly name: string;
      readonly description?: string | null;
      readonly defaultObjectives?: readonly string[];
      readonly milestones?: readonly ProjectTemplateMilestone[];
      readonly workItems?: readonly ProjectTemplateWorkItem[];
      readonly clientPortalOn?: boolean;
      readonly repeatInterval?: 'monthly' | null;
    },
  ): Promise<ProjectTemplateView> {
    this.authorizeOrg(context, principal, 'project.manage');

    const toWrite: CreateProjectTemplateInput = {
      name: input.name,
      description: input.description ?? null,
      ...(input.defaultObjectives === undefined
        ? {}
        : { defaultObjectives: input.defaultObjectives }),
      ...(input.milestones === undefined ? {} : { milestones: input.milestones }),
      ...(input.workItems === undefined ? {} : { workItems: input.workItems }),
      ...(input.clientPortalOn === undefined ? {} : { clientPortalOn: input.clientPortalOn }),
      ...(input.repeatInterval === undefined ? {} : { repeatInterval: input.repeatInterval }),
      createdBy: context.userId,
    };

    try {
      const row = await this.database.transaction(context, (tx) =>
        this.templates.create(tx, context, toWrite),
      );
      return toView(row);
    } catch (error) {
      if (error instanceof DuplicateProjectTemplateNameError) {
        throw new ApiError(409, 'conflict', 'A template with that name already exists', [
          { field: 'name', message: 'must be unique within the organization' },
        ]);
      }
      throw error;
    }
  }

  /**
   * Create a project from a template.
   *
   * The template is resolved tenant-scoped **before** the authorize check (Known-trap): an unknown or
   * cross-tenant `templateId` is a 404, never a foreign-key 500. Then `project.manage` is re-checked at
   * the org level, and the creation policy (`project.create` + "Members can create projects", F47).
   * Then a project is created through the **shared** {@link ProjectsService.create} path
   * — seeded with the template's name (or a caller override) — so no create logic is duplicated or
   * bypassed.
   */
  async instantiate(
    context: TenantContext,
    principal: Principal,
    templateId: string,
    input: InstantiateProjectTemplateCommand,
  ): Promise<ProjectView> {
    const template = await this.database.read(context, (runner) =>
      this.templates.findById(runner, context, templateId),
    );
    if (!template) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'template_not_visible');
    }

    this.authorizeOrg(context, principal, 'project.manage');

    if (!this.projects) {
      // Unreachable in the running application: ProjectTemplatesModule always wires the shared
      // ProjectsService. Asserted rather than assumed, so a misconfigured module fails loudly here.
      throw new ApiError(500, 'internal_error', MESSAGES.internal);
    }

    // F47. Instantiating creates a project, so it answers to the creation policy (`project.create`
    // and "Members can create projects"), refused before any other read. The shared create runs it
    // again.
    await this.projects.requireMayCreate(context, principal);

    // A9: the client and the lead are checked before anything is written, so a bad id is a 400
    // and no half-made project is left behind.
    if (input.clientOrganizationId !== undefined) {
      await this.requireClient(context, input.clientOrganizationId);
    }
    if (input.leadUserId !== undefined) await this.requireMember(context, input.leadUserId);

    const name = input.name ?? template.name;
    const project = await this.projects.create(context, principal, {
      workspaceId: input.workspaceId,
      name,
      ...(input.leadUserId === undefined ? {} : { ownerUserId: input.leadUserId }),
    });

    await this.copyPlan(context, template, project.id, input);
    return project;
  }

  /**
   * A9 — copy the template's plan into the new project in one transaction: the lead's project role,
   * the client share, every milestone (dates moved to the start date) and every work item.
   */
  private async copyPlan(
    context: TenantContext,
    template: ProjectTemplateRow,
    projectId: string,
    input: InstantiateProjectTemplateCommand,
  ): Promise<void> {
    const start = input.startDate ?? todayUtc();
    const milestones = template.milestonesJson ?? [];
    const workItems = template.workItemsJson ?? [];
    const shared = input.clientOrganizationId !== undefined;

    await this.database.transaction(context, async (tx) => {
      if (input.leadUserId !== undefined && input.leadUserId !== context.userId) {
        const lead = await this.projectMembers.add(tx, context, {
          projectId,
          userId: input.leadUserId,
          role: PROJECT_CREATOR_ROLE,
        });
        await this.audit?.record(tx, context, {
          action: 'project_membership.granted',
          result: 'allowed',
          objectId: lead.id,
          metadata: { project_id: projectId, target_user_id: lead.userId, granted_role: lead.role },
        });
      }

      if (input.clientOrganizationId !== undefined) {
        const share = await this.shares.share(tx, context, {
          projectId,
          clientOrganizationId: input.clientOrganizationId,
        });
        await this.audit?.record(tx, context, {
          action: 'project.client_linked',
          objectId: share.id,
          result: 'allowed',
          metadata: { project_id: projectId, client_organization_id: share.clientOrganizationId },
        });
      }

      for (const milestone of milestones) {
        await this.milestones.create(tx, context, {
          projectId,
          title: milestone.title,
          description: milestone.description ?? null,
          dueOn: shiftDay(start, milestone.offsetDays),
          status: 'planned',
          // Client-visible only when the project is actually shared and the template says so.
          published: shared && template.clientPortalOn && milestone.clientVisible !== false,
          createdByUserId: context.userId,
        });
      }

      for (const item of workItems) {
        await this.workItems.create(tx, context, {
          projectId,
          title: item.title,
          ...(item.offsetDays === undefined
            ? {}
            : { dueAt: new Date(`${shiftDay(start, item.offsetDays)}T00:00:00.000Z`) }),
        });
      }
    });
  }

  /** A9 — the client must be a live client company of this tenant. */
  private async requireClient(context: TenantContext, clientOrganizationId: string): Promise<void> {
    const client = await this.database.read(context, (runner) =>
      this.clientOrganizations.findById(runner, context, clientOrganizationId),
    );
    if (!client || client.archivedAt !== null) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'clientOrganizationId', message: 'must be an active client of this organization' },
      ]);
    }
  }

  /** A9 — the lead must be an active internal member of this tenant. */
  private async requireMember(context: TenantContext, userId: string): Promise<void> {
    const membership = await this.database.read(context, (runner) =>
      this.members.findByUserId(runner, context, userId),
    );
    if (!membership || membership.status !== 'active' || !isInternalRole(membership.role)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'leadUserId', message: 'must be an active member of this organization' },
      ]);
    }
  }
}
