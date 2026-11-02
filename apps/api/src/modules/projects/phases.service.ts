import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectPhasesRepository } from './phases.repository.js';
import { ProjectsRepository } from './projects.repository.js';
import type { ProjectPhaseRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';

/**
 * The application service for PROJ / module 8 (x294) — project timeline phases. It follows the
 * `ProjectRiskRegisterService` shape.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question `project.manage`. This service adds the
 * **relation** check with the row's project in hand — a member without organization-wide scope acts
 * only on the projects they belong to.
 *
 * ## The Known-trap order
 *
 * Every route names a project, phase or milestone by id, and the composite foreign key would surface
 * an unknown or cross-tenant id as a foreign-key 500 the `HttpExceptionFilter` cannot map. So every
 * id the request names is resolved **tenant-scoped before the relation check and the write**: an
 * unknown or another tenant's id is a 404, never a 500, and the relation failure is a 404 too (a 403
 * would confirm the row exists to a caller who is not a member).
 *
 * ## One table, two row kinds
 *
 * A milestone-to-phase assignment is recorded on `project_phases` (as a row with `milestone_id` set),
 * not on `project_milestones` — this slice references milestone ids without editing that table. The
 * milestone is only *read* (to resolve it tenant-scoped and confirm it shares the phase's project).
 */

/** A phase column on the timeline, with the ids of the milestones placed in it. */
export interface ProjectPhaseView {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly position: number;
  readonly milestoneIds: readonly string[];
  /** 53-07. The band's explicit start, or null (then derived from its milestones). */
  readonly startsOn?: string | null;
  /** 53-07. The band's explicit end, or null. */
  readonly endsOn?: string | null;
  /** 53-07. A design-token name for the band colour, or null. */
  readonly colorToken?: string | null;
}

/** 53-07. What `PUT …/phases/:phaseId/dates` sets — all three, each nullable. */
export interface PhaseDatesInput {
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly colorToken: string | null;
}

/** The record of a milestone placed into a phase. */
export interface MilestonePhaseAssignmentView {
  readonly milestoneId: string;
  readonly phaseId: string;
  readonly projectId: string;
}

export class ProjectPhasesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly phases: ProjectPhasesRepository = new ProjectPhasesRepository(),
    /** Read-only, used to prove a named project exists **inside this tenant** before a write. */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    /** 53-07. `phase.updated`. */
    private readonly audit?: AuditService,
  ) {}

  /**
   * 53-07. Set a phase's band dates and colour (`project.manage`). The project is resolved
   * manage-visible first, then the phase as a **definition** row of that project — an assignment
   * row, another project's phase or an unknown id is a 404. Audited with before/after.
   */
  async setDates(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    phaseId: string,
    input: PhaseDatesInput,
  ): Promise<ProjectPhaseView> {
    await this.requireManageableProject(context, principal, projectId);
    const phase = await this.database.read(context, (runner) =>
      this.phases.findDefinitionById(runner, context, phaseId),
    );
    if (!phase || phase.projectId !== projectId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'phase_not_visible');
    }

    const { row, assignments } = await this.database.transaction(context, async (tx) => {
      const updated = await this.phases.updateDefinitionDates(tx, context, phaseId, input);
      if (!updated) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      await this.audit?.record(tx, context, {
        action: 'phase.updated',
        result: 'allowed',
        objectId: phaseId,
        metadata: { project_id: projectId },
        changes: [
          { field: 'starts_on', before: phase.startsOn ?? null, after: input.startsOn },
          { field: 'ends_on', before: phase.endsOn ?? null, after: input.endsOn },
          { field: 'color_token', before: phase.colorToken ?? null, after: input.colorToken },
        ],
      });
      return {
        row: updated,
        assignments: await this.phases.listAssignments(tx, context, projectId),
      };
    });
    return toView(row, assignments);
  }

  /**
   * Resolve a project the principal may manage, tenant- and relation-scoped, or throw the not-found
   * that both an unknown id and a non-member's probe must earn.
   */
  private async requireManageableProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<void> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
    if (!this.mayManage(principal, context.organizationId, projectId)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
  }

  private mayManage(principal: Principal, organizationId: string, projectId: string): boolean {
    return authorize({
      principal,
      capability: 'project.manage',
      resource: { organizationId, projectId, audience: 'internal', lifecycle: 'active' },
    }).allowed;
  }

  /**
   * List a project's phase columns, each with the milestones placed in it. The project is resolved
   * manage-visible first (Known-trap): an unknown or cross-tenant `projectId`, and a non-member's
   * probe, all earn the same not-found.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<readonly ProjectPhaseView[]> {
    await this.requireManageableProject(context, principal, projectId);

    const { definitions, assignments } = await this.database.read(context, async (runner) => ({
      definitions: await this.phases.listDefinitions(runner, context, projectId),
      assignments: await this.phases.listAssignments(runner, context, projectId),
    }));

    return definitions.map((definition) => toView(definition, assignments));
  }

  /**
   * Define a phase against a project the principal may manage. The project is resolved manage-visible
   * first (Known-trap). A duplicate name in the project is a 409, checked before the insert so the
   * conflict is a clean error rather than a driver-level unique violation.
   */
  async define(
    context: TenantContext,
    principal: Principal,
    input: { readonly projectId: string; readonly name: string; readonly position: number },
  ): Promise<ProjectPhaseView> {
    await this.requireManageableProject(context, principal, input.projectId);

    const clash = await this.database.read(context, (runner) =>
      this.phases.findDefinitionByName(runner, context, input.projectId, input.name),
    );
    if (clash) {
      throw new ApiError(409, 'conflict', 'A phase with that name already exists in this project.');
    }

    const row = await this.database.transaction(context, (tx) =>
      this.phases.createDefinition(tx, context, {
        projectId: input.projectId,
        name: input.name,
        position: input.position,
      }),
    );
    return toView(row, []);
  }

  /**
   * Delete a phase (and its milestone assignments). The phase id is resolved tenant-scoped BEFORE the
   * write (Known-trap): an unknown or cross-tenant `phaseId` is a 404. Then it is relation-gated on
   * its own project with `project.manage` — a non-manager's probe earns the same not-found.
   */
  async deletePhase(context: TenantContext, principal: Principal, phaseId: string): Promise<void> {
    const phase = await this.database.read(context, (runner) =>
      this.phases.findDefinitionById(runner, context, phaseId),
    );
    if (!phase) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'phase_not_visible');
    }
    if (!this.mayManage(principal, phase.organizationId, phase.projectId)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'phase_not_visible');
    }

    await this.database.transaction(context, (tx) =>
      this.phases.deleteDefinition(tx, context, phaseId),
    );
  }

  /**
   * Assign a milestone to a phase, idempotently. Both the phase and the milestone are resolved
   * tenant-scoped BEFORE authorize and the write (Known-trap): an unknown or cross-tenant `phaseId`
   * or `milestoneId` is a 404, never a foreign-key 500, and no row is written. The phase's project
   * gates `project.manage`; the milestone must belong to that same project (else 404, so a caller
   * cannot learn a milestone of another project exists).
   */
  async assign(
    context: TenantContext,
    principal: Principal,
    milestoneId: string,
    phaseId: string,
  ): Promise<MilestonePhaseAssignmentView> {
    const phase = await this.database.read(context, (runner) =>
      this.phases.findDefinitionById(runner, context, phaseId),
    );
    if (!phase) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'phase_not_visible');
    }
    if (!this.mayManage(principal, phase.organizationId, phase.projectId)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'phase_not_visible');
    }

    const milestone = await this.database.read(context, (runner) =>
      this.phases.findMilestoneRef(runner, context, milestoneId),
    );
    if (!milestone || milestone.projectId !== phase.projectId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'milestone_not_visible');
    }

    const row = await this.database.transaction(context, (tx) =>
      this.phases.assignMilestone(tx, context, {
        projectId: phase.projectId,
        milestoneId,
        phaseId,
      }),
    );
    return {
      milestoneId: row.milestoneId as string,
      phaseId: row.phaseId as string,
      projectId: row.projectId,
    };
  }
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). `organization_id`
 * is never echoed. `milestoneIds` is folded in from the project's assignment rows that point at this
 * phase.
 */
function toView(
  definition: ProjectPhaseRow,
  assignments: readonly ProjectPhaseRow[],
): ProjectPhaseView {
  const milestoneIds = assignments
    .filter((assignment) => assignment.phaseId === definition.id && assignment.milestoneId !== null)
    .map((assignment) => assignment.milestoneId as string);
  return {
    id: definition.id,
    projectId: definition.projectId,
    name: definition.name ?? '',
    position: definition.position ?? 0,
    milestoneIds,
    startsOn: definition.startsOn ?? null,
    endsOn: definition.endsOn ?? null,
    colorToken: definition.colorToken ?? null,
  };
}
