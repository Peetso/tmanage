import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workspaces } from '../../common/database/schema.js';
import type { WorkspaceRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The workspace aggregate — TEN-001.
 *
 * Follows `ProjectsRepository` exactly, and the sameness is the point: `TenantContext` first,
 * no `organizationId` on any input type, keyset pagination on `(organization_id, id)`,
 * optimistic concurrency on update, and not-found rather than conflict for a caller in the
 * wrong tenant. A reviewer who has read one of these files should find nothing novel in the
 * next, because a repository that is shaped differently is the one that gets a predicate
 * wrong.
 */

export class WorkspaceNotFoundError extends Error {
  constructor(readonly workspaceId: string) {
    // No organization id in the message: a caller probing for another tenant's workspace
    // must not learn the difference between "does not exist" and "exists elsewhere".
    super(`Workspace ${workspaceId} was not found`);
    this.name = 'WorkspaceNotFoundError';
  }
}

export class WorkspaceVersionConflictError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly expectedVersion: number,
  ) {
    super(
      `Workspace ${workspaceId} was modified concurrently (expected version ${expectedVersion})`,
    );
    this.name = 'WorkspaceVersionConflictError';
  }
}

/** Note the absent field: `organizationId` comes from the context and has nowhere else to come from. */
export interface CreateWorkspaceInput {
  readonly name: string;
}

export interface UpdateWorkspaceInput {
  readonly name?: string;
}

export interface ListWorkspacesOptions {
  readonly after?: string;
  readonly limit?: number;
  readonly includeArchived?: boolean;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export class WorkspacesRepository {
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListWorkspacesOptions = {},
  ): Promise<readonly WorkspaceRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const predicates = [eq(workspaces.organizationId, context.organizationId)];
    if (!options.includeArchived) predicates.push(isNull(workspaces.archivedAt));
    if (options.after) predicates.push(gt(workspaces.id, options.after));

    return tenantDrizzle(runner)
      .select()
      .from(workspaces)
      .where(and(...predicates))
      .orderBy(asc(workspaces.id))
      .limit(limit);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    workspaceId: string,
  ): Promise<WorkspaceRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workspaces)
      .where(
        and(eq(workspaces.organizationId, context.organizationId), eq(workspaces.id, workspaceId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    workspaceId: string,
  ): Promise<WorkspaceRow> {
    const found = await this.findById(runner, context, workspaceId);
    if (!found) throw new WorkspaceNotFoundError(workspaceId);
    return found;
  }

  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateWorkspaceInput,
  ): Promise<WorkspaceRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(workspaces)
      .values({
        id,
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        name: input.name,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });

    // Read back rather than reconstruct, so the returned row carries the server's
    // timestamps rather than a hand-assembled approximation of them.
    return this.requireById(runner, context, id);
  }

  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    workspaceId: string,
    expectedUpdatedAt: Date,
    input: UpdateWorkspaceInput,
  ): Promise<WorkspaceRow> {
    const changes: Record<string, unknown> = { updatedAt: sql`current_timestamp(3)` };
    if (input.name !== undefined) changes['name'] = input.name;

    const result = await tenantDrizzle(runner)
      .update(workspaces)
      .set(changes)
      .where(
        and(
          eq(workspaces.organizationId, context.organizationId),
          eq(workspaces.id, workspaceId),
          eq(workspaces.updatedAt, expectedUpdatedAt),
        ),
      );

    if (result[0].affectedRows === 0) {
      // Wrong tenant, no such workspace, or a stale token — distinguished by a scoped read
      // so that a caller in the wrong tenant still gets not-found rather than a conflict
      // that would confirm the row exists.
      const current = await this.findById(runner, context, workspaceId);
      if (!current) throw new WorkspaceNotFoundError(workspaceId);
      throw new WorkspaceVersionConflictError(workspaceId, current.updatedAt.getTime());
    }

    return this.requireById(runner, context, workspaceId);
  }

  /**
   * Archive a workspace. There is no hard delete.
   *
   * Projects reference the workspace through a composite foreign key, so a `DELETE` would
   * either be refused or cascade through live work. Archiving is a state the history keeps.
   */
  async archive(
    runner: TenantQueryRunner,
    context: TenantContext,
    workspaceId: string,
  ): Promise<WorkspaceRow> {
    const result = await tenantDrizzle(runner)
      .update(workspaces)
      .set({ archivedAt: sql`current_timestamp(3)`, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(workspaces.organizationId, context.organizationId),
          eq(workspaces.id, workspaceId),
          isNull(workspaces.archivedAt),
        ),
      );

    if (result[0].affectedRows === 0) {
      const current = await this.findById(runner, context, workspaceId);
      if (!current) throw new WorkspaceNotFoundError(workspaceId);
      return current; // Already archived; archiving twice is not an error.
    }

    return this.requireById(runner, context, workspaceId);
  }
}
