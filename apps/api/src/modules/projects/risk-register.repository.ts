import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectInternalRisks } from '../../common/database/schema.js';
import type { ProjectInternalRiskRow } from '../../common/database/schema.js';
import type {
  PROJECT_INTERNAL_RISK_IMPACTS,
  PROJECT_INTERNAL_RISK_LIKELIHOODS,
  PROJECT_INTERNAL_RISK_STATUSES,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The project internal-risk-register repository — PROJ / module 8 (x209), following the
 * `project-objectives` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally: every method's first
 * two parameters are the `TenantQueryRunner` and the `TenantContext` (no unscoped overload), the
 * tenant comes from the context and never the DTO ({@link CreateProjectInternalRiskInput} has no
 * `organizationId`), and the tenant predicate is on every statement.
 */

export type ProjectInternalRiskLikelihood = (typeof PROJECT_INTERNAL_RISK_LIKELIHOODS)[number];
export type ProjectInternalRiskImpact = (typeof PROJECT_INTERNAL_RISK_IMPACTS)[number];
export type ProjectInternalRiskStatus = (typeof PROJECT_INTERNAL_RISK_STATUSES)[number];

export class ProjectInternalRiskNotFoundError extends Error {
  constructor(readonly riskId: string) {
    // No organization id in the message: a not-found must not let a probe for another tenant's risk
    // tell "does not exist" from "exists elsewhere" (spec §4).
    super(`Project internal risk ${riskId} was not found`);
    this.name = 'ProjectInternalRiskNotFoundError';
  }
}

/** Note the absent `organizationId`: it is taken from the context, so no body can populate it. */
export interface CreateProjectInternalRiskInput {
  readonly projectId: string;
  readonly title: string;
  readonly likelihood: ProjectInternalRiskLikelihood;
  readonly impact: ProjectInternalRiskImpact;
  readonly mitigation?: string | null;
  readonly status: ProjectInternalRiskStatus;
  /** The person who logged the risk — the service passes `context.userId`. */
  readonly createdBy: string;
}

/** The mutable substance an update may set. Identity columns are pinned by the 0088 trigger. */
export interface UpdateProjectInternalRiskInput {
  readonly title?: string;
  readonly likelihood?: ProjectInternalRiskLikelihood;
  readonly impact?: ProjectInternalRiskImpact;
  readonly mitigation?: string | null;
  readonly status?: ProjectInternalRiskStatus;
}

export interface ListProjectInternalRisksOptions {
  /** Required: this slice lists one project's register, never a whole tenant's. */
  readonly projectId: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class ProjectRiskRegisterRepository {
  /**
   * List one project's risks, within the acting tenant, in creation order.
   *
   * Both `organization_id` and `project_id` predicates are present. The order is
   * `created_at ASC, id ASC`: the register reads oldest-first, and `id` (UUIDv7) is the deterministic
   * tiebreaker.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListProjectInternalRisksOptions,
  ): Promise<readonly ProjectInternalRiskRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    return db
      .select()
      .from(projectInternalRisks)
      .where(
        and(
          eq(projectInternalRisks.organizationId, context.organizationId),
          eq(projectInternalRisks.projectId, options.projectId),
        ),
      )
      .orderBy(asc(projectInternalRisks.createdAt), asc(projectInternalRisks.id))
      .limit(limit);
  }

  /**
   * Fetch one risk by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    riskId: string,
  ): Promise<ProjectInternalRiskRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(projectInternalRisks)
      .where(
        and(
          eq(projectInternalRisks.organizationId, context.organizationId),
          eq(projectInternalRisks.id, riskId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    riskId: string,
  ): Promise<ProjectInternalRiskRow> {
    const found = await this.findById(runner, context, riskId);
    if (!found) throw new ProjectInternalRiskNotFoundError(riskId);
    return found;
  }

  /**
   * Log a risk.
   *
   * The id is generated here (UUIDv7) so a command knows it before the insert commits.
   * `organization_id` comes from the context, never from `input`. The project is not checked to
   * belong to the tenant here: the composite foreign key `fk_project_internal_risks_project_tenant`
   * includes `organization_id`, so the database refuses a project from another tenant. (The service
   * resolves the project first, to map an unknown id to 404 rather than a foreign-key 500.)
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateProjectInternalRiskInput,
  ): Promise<ProjectInternalRiskRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(projectInternalRisks).values({
      id,
      organizationId: context.organizationId,
      projectId: input.projectId,
      title: input.title,
      likelihood: input.likelihood,
      impact: input.impact,
      mitigation: input.mitigation ?? null,
      status: input.status,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries a server-generated `created_at`.
    return this.requireById(runner, context, id);
  }

  /**
   * Update a risk's mutable substance within the acting tenant, and read it back.
   *
   * The predicate carries both `organization_id` and `id`, so a cross-tenant id updates nothing; the
   * 0088 trigger refuses any identity column, so this can only ever write the substance columns the
   * runtime credential is granted. Only the fields the caller provided are set.
   */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    riskId: string,
    input: UpdateProjectInternalRiskInput,
  ): Promise<ProjectInternalRiskRow> {
    const db = tenantDrizzle(runner);
    const changes: Record<string, unknown> = {};
    if (input.title !== undefined) changes['title'] = input.title;
    if (input.likelihood !== undefined) changes['likelihood'] = input.likelihood;
    if (input.impact !== undefined) changes['impact'] = input.impact;
    if (input.mitigation !== undefined) changes['mitigation'] = input.mitigation;
    if (input.status !== undefined) changes['status'] = input.status;

    if (Object.keys(changes).length > 0) {
      await db
        .update(projectInternalRisks)
        .set(changes)
        .where(
          and(
            eq(projectInternalRisks.organizationId, context.organizationId),
            eq(projectInternalRisks.id, riskId),
          ),
        );
    }
    return this.requireById(runner, context, riskId);
  }
}
