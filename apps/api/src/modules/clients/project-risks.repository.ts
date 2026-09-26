import { and, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectRisks } from '../../common/database/schema.js';
import type { ProjectRiskRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The project-risks repository — SEC / Portal risks (x140), following the `project_updates` (0041)
 * and `project_milestones` (0048) pattern exactly.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * sibling repositories honour it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the
 *    `TenantQueryRunner` for the current unit of work and the `TenantContext`. There is no
 *    overload without a context, so a caller that never established a tenant is a type error.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateProjectRiskInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

export type ProjectRiskSeverity = ProjectRiskRow['severity'];
export type ProjectRiskStatus = ProjectRiskRow['status'];

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for a
 * request body to populate and no code path that could prefer one over the other.
 */
export interface CreateProjectRiskInput {
  readonly projectId: string;
  /** The internal handle for the risk — staff-facing, never projected to a client. */
  readonly title: string;
  readonly severity: ProjectRiskSeverity;
  readonly status: ProjectRiskStatus;
  /** The internal-only substance — the detail the client must never be shown. Nullable. */
  readonly internalNote: string | null;
  /** The client-facing description — the one field of a risk a client is ever shown. */
  readonly clientSummary: string;
  /** Whether the risk is client-visible at insert time. This slice sets it here and never edits it. */
  readonly published: boolean;
  /** The person recording the risk — the service passes `context.userId`. */
  readonly createdByUserId: string;
}

export interface ListProjectRisksOptions {
  /** Required: this reads one project's risks, never a whole tenant's. */
  readonly projectId: string;
  /**
   * When true, only `published = 1` rows are selected — the client-visibility gate, applied in the
   * **query** so an unpublished row is never in the result set to be careless with. The client read
   * passes `true`; the internal read passes `false`.
   */
  readonly publishedOnly: boolean;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class ProjectRisksRepository {
  /**
   * List one project's risks, within the acting tenant, newest first.
   *
   * Both `organization_id` and `project_id` predicates are present, and — for a client read — so is
   * `published = 1`. The order is `created_at DESC, id DESC`: the register the portal shows,
   * deterministic even when two risks share a millisecond (UUIDv7 ids break the tie in creation
   * order). The `(organization_id, project_id, created_at)` index (0049) serves it.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListProjectRisksOptions,
  ): Promise<readonly ProjectRiskRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [
      eq(projectRisks.organizationId, context.organizationId),
      eq(projectRisks.projectId, options.projectId),
    ];
    if (options.publishedOnly) predicates.push(eq(projectRisks.published, true));

    return db
      .select()
      .from(projectRisks)
      .where(and(...predicates))
      .orderBy(desc(projectRisks.createdAt), desc(projectRisks.id))
      .limit(limit);
  }

  /**
   * Fetch one risk by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row, which
   * is why ADR-0001 exists and this signature has no unscoped form.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    riskId: string,
  ): Promise<ProjectRiskRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(projectRisks)
      .where(
        and(eq(projectRisks.organizationId, context.organizationId), eq(projectRisks.id, riskId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a project risk.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`) so a command knows it before the insert
   * commits. `organization_id` comes from the context, never from `input`. The project is *not*
   * checked to belong to the tenant here: `fk_project_risks_project_tenant` is a composite foreign
   * key including `organization_id`, so the database refuses a project from another tenant. (The
   * service still resolves the project tenant-scoped first, so a missing/cross-tenant id is a 404
   * rather than the 500 that foreign key would otherwise surface.)
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateProjectRiskInput,
  ): Promise<ProjectRiskRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(projectRisks).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      projectId: input.projectId,
      title: input.title,
      severity: input.severity,
      status: input.status,
      internalNote: input.internalNote,
      clientSummary: input.clientSummary,
      published: input.published,
      createdByUserId: input.createdByUserId,
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries server-generated timestamps.
    const row = await this.findById(runner, context, id);
    if (!row) throw new Error(`project risk ${id} vanished immediately after insert`);
    return row;
  }
}
