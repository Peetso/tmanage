import { and, desc, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectMilestones, projectUpdates, users } from '../../common/database/schema.js';
import type { ProjectUpdateRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The project-updates repository — CLIENT-003 (x125), following the `meetings` (0029) and
 * `documents` (0030) pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * sibling repositories honour it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the
 *    `TenantQueryRunner` for the current unit of work and the `TenantContext`. There is no
 *    overload without a context, so a caller that never established a tenant is a type error.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateProjectUpdateInput} has
 *    no `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through
 *    the guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for
 * a request body to populate and no code path that could prefer one over the other.
 */
export interface CreateProjectUpdateInput {
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  /** Whether the update is client-visible at insert time. This slice sets it here and never edits it. */
  readonly published: boolean;
  /** The person posting the update — the service passes `context.userId`. */
  readonly createdByUserId: string;
  /** A10 (0223). The milestone this update reports on — already resolved to this project. */
  readonly milestoneId?: string | null;
}

/**
 * Edit one existing update — x201. Both `title` and `body` are optional so a partial edit writes
 * only the field the caller changed; the tenant and the owning project are identity, not content,
 * and neither is a field a request body could populate.
 */
export interface EditProjectUpdateInput {
  readonly updateId: string;
  readonly projectId: string;
  readonly title?: string;
  readonly body?: string;
  /** A10 (0223). `null` clears the link; absent leaves it. */
  readonly milestoneId?: string | null;
}

/**
 * A10 — one update as the internal updates list reads it: the row, its author's display name and
 * the linked milestone (null when none is linked or it no longer exists in this tenant).
 */
export interface ManagedProjectUpdateRow {
  readonly update: ProjectUpdateRow;
  readonly authorName: string;
  readonly milestone: {
    readonly id: string;
    readonly title: string;
    readonly dueOn: string | null;
  } | null;
}

/** Set one update's client-visibility flag — x201's unpublish flips it to `false`. */
export interface SetProjectUpdatePublishedInput {
  readonly updateId: string;
  readonly projectId: string;
  readonly published: boolean;
}

export interface ListProjectUpdatesOptions {
  /** Required: this reads one project's updates, never a whole tenant's. */
  readonly projectId: string;
  /**
   * When true, only `published = 1` rows are selected — the client-visibility gate, applied in
   * the **query** so an unpublished row is never in the result set to be careless with. The
   * client read passes `true`; an internal read (if one ever ships) passes `false`.
   */
  readonly publishedOnly: boolean;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class ProjectUpdatesRepository {
  /**
   * List one project's updates, within the acting tenant, newest first.
   *
   * Both `organization_id` and `project_id` predicates are present, and — for a client read —
   * so is `published = 1`. The order is `created_at DESC, id DESC`: the timeline the portal
   * shows, deterministic even when two updates share a millisecond (UUIDv7 ids break the tie in
   * creation order). The `(organization_id, project_id, created_at)` index (0041) serves it.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListProjectUpdatesOptions,
  ): Promise<readonly ProjectUpdateRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [
      eq(projectUpdates.organizationId, context.organizationId),
      eq(projectUpdates.projectId, options.projectId),
    ];
    if (options.publishedOnly) predicates.push(eq(projectUpdates.published, true));

    return db
      .select()
      .from(projectUpdates)
      .where(and(...predicates))
      .orderBy(desc(projectUpdates.createdAt), desc(projectUpdates.id))
      .limit(limit);
  }

  /**
   * A10 — one project's updates for the internal updates list, drafts included, newest first.
   *
   * Tenant- and project-scoped like {@link list}. The author's display name comes from `users`
   * (the internal surface may name staff; the client projection never does), and the milestone is
   * a tenant-scoped LEFT JOIN, so a link whose milestone has gone reads as no milestone.
   */
  async listManaged(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: { readonly projectId: string; readonly limit?: number },
  ): Promise<readonly ManagedProjectUpdateRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({
        update: projectUpdates,
        authorName: users.displayName,
        milestoneId: projectMilestones.id,
        milestoneTitle: projectMilestones.title,
        milestoneDueOn: projectMilestones.dueOn,
      })
      .from(projectUpdates)
      .innerJoin(users, eq(users.id, projectUpdates.createdByUserId))
      .leftJoin(
        projectMilestones,
        and(
          eq(projectMilestones.organizationId, projectUpdates.organizationId),
          eq(projectMilestones.id, projectUpdates.milestoneId),
        ),
      )
      .where(
        and(
          eq(projectUpdates.organizationId, context.organizationId),
          eq(projectUpdates.projectId, options.projectId),
        ),
      )
      .orderBy(desc(projectUpdates.createdAt), desc(projectUpdates.id))
      .limit(limit);

    return rows.map((row) => ({
      update: row.update,
      authorName: row.authorName,
      milestone:
        row.milestoneId !== null && row.milestoneTitle !== null
          ? { id: row.milestoneId, title: row.milestoneTitle, dueOn: row.milestoneDueOn ?? null }
          : null,
    }));
  }

  /**
   * Fetch one update by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row,
   * which is why ADR-0001 exists and this signature has no unscoped form.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    updateId: string,
  ): Promise<ProjectUpdateRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(projectUpdates)
      .where(
        and(
          eq(projectUpdates.organizationId, context.organizationId),
          eq(projectUpdates.id, updateId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a project update.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`) so a command knows it before the insert
   * commits. `organization_id` comes from the context, never from `input`. The project is *not*
   * checked to belong to the tenant here: `fk_project_updates_project_tenant` is a composite
   * foreign key including `organization_id`, so the database refuses a project from another
   * tenant — a service-layer check would duplicate a guarantee that cannot be bypassed. (The
   * service still resolves the project tenant-scoped first, so a missing/cross-tenant id is a
   * 404 rather than the 500 that foreign key would otherwise surface.)
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateProjectUpdateInput,
  ): Promise<ProjectUpdateRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(projectUpdates).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      projectId: input.projectId,
      title: input.title,
      body: input.body,
      published: input.published,
      milestoneId: input.milestoneId ?? null,
      createdByUserId: input.createdByUserId,
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries server-generated timestamps.
    const row = await this.findById(runner, context, id);
    if (!row) throw new Error(`project update ${id} vanished immediately after insert`);
    return row;
  }

  /**
   * Edit one update's client-facing text — x201.
   *
   * The `WHERE` carries **all three** of `organization_id`, `project_id` and `id`: the tenant
   * predicate is spec §6, and the `project_id` predicate makes the row's ownership by the named
   * project part of the statement rather than a check the caller must remember — a `:id` that
   * belongs to a different project in the same tenant matches nothing and updates nothing. Only
   * the fields present in `input` are written, so an edit of the body alone leaves the title
   * untouched; `updated_at` is always advanced. `published` is never touched here — the
   * publish/unpublish lifecycle is {@link setPublished}. The service has already resolved the
   * row tenant-scoped and authorized the write; this returns the row read back so the caller
   * sees the server-advanced `updated_at`.
   */
  async updateContent(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: EditProjectUpdateInput,
  ): Promise<ProjectUpdateRow | null> {
    const db = tenantDrizzle(runner);
    const values: { title?: string; body?: string; milestoneId?: string | null; updatedAt: SQL } = {
      updatedAt: sql`current_timestamp(3)`,
    };
    if (input.title !== undefined) values.title = input.title;
    if (input.body !== undefined) values.body = input.body;
    if (input.milestoneId !== undefined) values.milestoneId = input.milestoneId;

    await db
      .update(projectUpdates)
      .set(values)
      .where(
        and(
          eq(projectUpdates.organizationId, context.organizationId),
          eq(projectUpdates.projectId, input.projectId),
          eq(projectUpdates.id, input.updateId),
        ),
      );

    return this.findById(runner, context, input.updateId);
  }

  /**
   * Set one update's client-visibility flag — x201's unpublish.
   *
   * The same three-part tenant-and-project-scoped `WHERE` as {@link updateContent}. Flipping
   * `published` to `false` is what removes the row from the client projection: the client read
   * ({@link ProjectUpdatesRepository.list} with `publishedOnly`) has `published = 1` as a query
   * predicate, so a drafted row is never in that result set — the gate is in the SQL, not a
   * filter the read must remember. `updated_at` is advanced so the change is dated.
   */
  async setPublished(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: SetProjectUpdatePublishedInput,
  ): Promise<ProjectUpdateRow | null> {
    const db = tenantDrizzle(runner);

    await db
      .update(projectUpdates)
      .set({ published: input.published, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(projectUpdates.organizationId, context.organizationId),
          eq(projectUpdates.projectId, input.projectId),
          eq(projectUpdates.id, input.updateId),
        ),
      );

    return this.findById(runner, context, input.updateId);
  }
}
