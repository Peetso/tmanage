import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  DuplicateProjectTemplateNameError,
  ProjectTemplatesRepository,
} from './templates.repository.js';
import type { CreateProjectTemplateInput } from './templates.repository.js';
import type { ProjectView, ProjectsService } from './projects.service.js';
import type { ProjectTemplateRow } from '../../common/database/schema.js';

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
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
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
    },
  ): Promise<ProjectTemplateView> {
    this.authorizeOrg(context, principal, 'project.manage');

    const toWrite: CreateProjectTemplateInput = {
      name: input.name,
      description: input.description ?? null,
      ...(input.defaultObjectives === undefined
        ? {}
        : { defaultObjectives: input.defaultObjectives }),
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
   * the org level. Then a project is created through the **shared** {@link ProjectsService.create} path
   * — seeded with the template's name (or a caller override) — so no create logic is duplicated or
   * bypassed.
   */
  async instantiate(
    context: TenantContext,
    principal: Principal,
    templateId: string,
    input: { readonly workspaceId: string; readonly name?: string },
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

    const name = input.name ?? template.name;
    return this.projects.create(context, { workspaceId: input.workspaceId, name });
  }
}
