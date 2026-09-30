import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectMilestones, projectPhases } from '../../common/database/schema.js';
import type { ProjectPhaseRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The project-phases repository — PROJ / module 8 (x294), following the `project-objectives` /
 * `risk-register` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally: every method's first
 * two parameters are the `TenantQueryRunner` and the `TenantContext` (no unscoped overload), the
 * tenant comes from the context and never a DTO, and the tenant predicate is on every statement.
 *
 * One table (`project_phases`) carries two row kinds, told apart by `milestone_id`:
 *   * a **definition** (`milestone_id IS NULL`): a named, positioned phase column, and
 *   * an **assignment** (`milestone_id IS NOT NULL`): a milestone placed into a phase.
 * The two kinds are queried with the `isNull` / `isNotNull` predicates below so a definition read
 * never sees an assignment row and vice versa.
 */

/** A phase definition the service resolves and projects. */
export interface CreatePhaseInput {
  readonly projectId: string;
  readonly name: string;
  readonly position: number;
}

/** The tenant-scoped shape of a milestone this slice needs — id and its project. */
export interface MilestoneRef {
  readonly id: string;
  readonly projectId: string;
}

const DEFAULT_PAGE_SIZE = 100;

export class ProjectPhasesRepository {
  /**
   * List a project's phase **definitions** (milestone_id NULL) within the acting tenant, ordered
   * left-to-right by `position`, with `id` (UUIDv7) as the deterministic tiebreaker.
   */
  async listDefinitions(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly ProjectPhaseRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(projectPhases)
      .where(
        and(
          eq(projectPhases.organizationId, context.organizationId),
          eq(projectPhases.projectId, projectId),
          isNull(projectPhases.milestoneId),
        ),
      )
      .orderBy(asc(projectPhases.position), asc(projectPhases.id))
      .limit(DEFAULT_PAGE_SIZE);
  }

  /**
   * List a project's milestone **assignments** (milestone_id NOT NULL) within the acting tenant, so
   * the timeline can render which milestone sits in which phase.
   */
  async listAssignments(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly ProjectPhaseRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(projectPhases)
      .where(
        and(
          eq(projectPhases.organizationId, context.organizationId),
          eq(projectPhases.projectId, projectId),
          isNotNull(projectPhases.milestoneId),
        ),
      )
      .orderBy(asc(projectPhases.id))
      .limit(DEFAULT_PAGE_SIZE);
  }

  /**
   * Fetch one phase **definition** by id, within the acting tenant. Returns null for an unknown or
   * cross-tenant id, or for a row that is an assignment rather than a definition.
   */
  async findDefinitionById(
    runner: TenantQueryRunner,
    context: TenantContext,
    phaseId: string,
  ): Promise<ProjectPhaseRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(projectPhases)
      .where(
        and(
          eq(projectPhases.organizationId, context.organizationId),
          eq(projectPhases.id, phaseId),
          isNull(projectPhases.milestoneId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Find a definition row by its `(project, name)` handle within the tenant — the 409 pre-check. */
  async findDefinitionByName(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    name: string,
  ): Promise<ProjectPhaseRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(projectPhases)
      .where(
        and(
          eq(projectPhases.organizationId, context.organizationId),
          eq(projectPhases.projectId, projectId),
          isNull(projectPhases.milestoneId),
          eq(projectPhases.name, name),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Define a phase. The id is generated here (UUIDv7). `organization_id` comes from the context,
   * never from `input`. The project is not re-checked here: the composite foreign key
   * `fk_project_phases_project_tenant` refuses a project from another tenant. (The service resolves
   * the project first, to map an unknown id to 404 rather than a foreign-key 500.)
   */
  async createDefinition(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreatePhaseInput,
  ): Promise<ProjectPhaseRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(projectPhases).values({
      id,
      organizationId: context.organizationId,
      projectId: input.projectId,
      name: input.name,
      position: input.position,
      milestoneId: null,
      phaseId: null,
      createdAt: sql`current_timestamp(3)`,
    });
    const rows = await db
      .select()
      .from(projectPhases)
      .where(
        and(eq(projectPhases.organizationId, context.organizationId), eq(projectPhases.id, id)),
      )
      .limit(1);
    // The row was just inserted under this tenant; the read-back carries the server `created_at`.
    return rows[0] as ProjectPhaseRow;
  }

  /**
   * Delete a phase definition and any milestone-assignment rows that point at it, within the acting
   * tenant. A cross-tenant id deletes nothing (both predicates carry `organization_id`).
   */
  async deleteDefinition(
    runner: TenantQueryRunner,
    context: TenantContext,
    phaseId: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(projectPhases)
      .where(
        and(
          eq(projectPhases.organizationId, context.organizationId),
          eq(projectPhases.phaseId, phaseId),
        ),
      );
    await db
      .delete(projectPhases)
      .where(
        and(
          eq(projectPhases.organizationId, context.organizationId),
          eq(projectPhases.id, phaseId),
        ),
      );
  }

  /** Fetch the assignment row for a milestone within the tenant, or null. */
  async findAssignmentByMilestone(
    runner: TenantQueryRunner,
    context: TenantContext,
    milestoneId: string,
  ): Promise<ProjectPhaseRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(projectPhases)
      .where(
        and(
          eq(projectPhases.organizationId, context.organizationId),
          eq(projectPhases.milestoneId, milestoneId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Assign a milestone to a phase, idempotently. If the milestone already sits in a phase the row's
   * `phase_id` is rewritten; otherwise a new assignment row is inserted. Returns the assignment row.
   */
  async assignMilestone(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { readonly projectId: string; readonly milestoneId: string; readonly phaseId: string },
  ): Promise<ProjectPhaseRow> {
    const db = tenantDrizzle(runner);
    const existing = await this.findAssignmentByMilestone(runner, context, input.milestoneId);
    if (existing) {
      if (existing.phaseId !== input.phaseId) {
        await db
          .update(projectPhases)
          .set({ phaseId: input.phaseId })
          .where(
            and(
              eq(projectPhases.organizationId, context.organizationId),
              eq(projectPhases.id, existing.id),
            ),
          );
      }
      return { ...existing, phaseId: input.phaseId };
    }
    const id = uuidv7();
    await db.insert(projectPhases).values({
      id,
      organizationId: context.organizationId,
      projectId: input.projectId,
      name: null,
      position: null,
      milestoneId: input.milestoneId,
      phaseId: input.phaseId,
      createdAt: sql`current_timestamp(3)`,
    });
    const rows = await db
      .select()
      .from(projectPhases)
      .where(
        and(eq(projectPhases.organizationId, context.organizationId), eq(projectPhases.id, id)),
      )
      .limit(1);
    return rows[0] as ProjectPhaseRow;
  }

  /**
   * Resolve a milestone to its `(id, project)` within the acting tenant, reading `project_milestones`
   * (0048). Read-only: this slice references milestone ids without editing that table. Returns null
   * for an unknown or cross-tenant milestone id — the service maps that to a 404, no write.
   */
  async findMilestoneRef(
    runner: TenantQueryRunner,
    context: TenantContext,
    milestoneId: string,
  ): Promise<MilestoneRef | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({ id: projectMilestones.id, projectId: projectMilestones.projectId })
      .from(projectMilestones)
      .where(
        and(
          eq(projectMilestones.organizationId, context.organizationId),
          eq(projectMilestones.id, milestoneId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? { id: row.id, projectId: row.projectId } : null;
  }
}
