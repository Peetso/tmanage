import { and, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectFavorites, projects } from '../../common/database/schema.js';
import type { ProjectFavoriteRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * PROJ project favorites (x268) — a membership's private favorites over `projects` rows. It owns the
 * favorite insert, the unstar delete, and the newest-first list of a membership's favorites joined to
 * their live projects. It follows the `doc_bookmarks` repository (x242) / `home_pinned_items` (x144)
 * pattern and honours `25-AUTH` §6 structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` and
 *    the `TenantContext`.
 * 2. **The tenant comes from the context, never the DTO.** {@link AddFavoriteInput} has no
 *    `organizationId`.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the service composes the check-then-insert on one
 * connection inside one transaction `TenantDatabase.transaction()` owns.
 */

/** What the service inserts. No `organizationId` (from the context). */
export interface AddFavoriteInput {
  readonly projectId: string;
  /** The favoriting membership — the service passes `context.membershipId`. */
  readonly membershipId: string;
}

/** One favorite joined to the project it points at, for the caller's switcher list. */
export interface FavoriteProjectRow {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: Date;
}

/** A membership's switcher carries the full project name, so a long list must not be unbounded. */
const MAX_FAVORITES_LISTED = 200;

export class ProjectFavoritesRepository {
  /** Fetch one membership's favorite of one project, scoped to the acting tenant, or null. */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    membershipId: string,
  ): Promise<ProjectFavoriteRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(projectFavorites)
      .where(
        and(
          eq(projectFavorites.organizationId, context.organizationId),
          eq(projectFavorites.projectId, projectId),
          eq(projectFavorites.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Favorite a project for a membership, idempotently. If the favorite already exists it is returned
   * unchanged (a repeated PUT is a no-op, never a second row and never an UPDATE — the grant withholds
   * UPDATE); otherwise a new row is inserted. The `(organization_id, project_id, membership_id)`
   * unique key is the guard: a racing insert that collides is caught and the existing row re-read.
   */
  async add(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AddFavoriteInput,
  ): Promise<ProjectFavoriteRow> {
    const existing = await this.find(runner, context, input.projectId, input.membershipId);
    if (existing) {
      return existing;
    }

    const db = tenantDrizzle(runner);
    const id = uuidv7();
    try {
      await db.insert(projectFavorites).values({
        id,
        organizationId: context.organizationId,
        projectId: input.projectId,
        membershipId: input.membershipId,
        createdAt: sql`current_timestamp(3)`,
      });
    } catch (error) {
      // A concurrent PUT won the unique key first; the favorite now exists, so re-read it and treat
      // this call as the idempotent no-op it is. Any other error is a real failure — rethrow.
      const raced = await this.find(runner, context, input.projectId, input.membershipId);
      if (raced) {
        return raced;
      }
      throw error;
    }

    const inserted = await this.find(runner, context, input.projectId, input.membershipId);
    if (!inserted) throw new Error('project_favorites row vanished immediately after insert');
    return inserted;
  }

  /**
   * Remove a membership's favorite of a project, scoped to the acting tenant. Idempotent (no row →
   * no-op), so a repeated DELETE is still a 204.
   */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    membershipId: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(projectFavorites)
      .where(
        and(
          eq(projectFavorites.organizationId, context.organizationId),
          eq(projectFavorites.projectId, projectId),
          eq(projectFavorites.membershipId, membershipId),
        ),
      );
  }

  /**
   * List one membership's favorites, newest first, joined to the live project. The inner join drops a
   * favorite whose project no longer exists; the service further filters to projects the caller can
   * still read. Bounded.
   */
  async listForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly FavoriteProjectRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select({
        id: projectFavorites.id,
        projectId: projectFavorites.projectId,
        name: projects.name,
        status: projects.status,
        createdAt: projectFavorites.createdAt,
      })
      .from(projectFavorites)
      .innerJoin(
        projects,
        and(
          eq(projects.organizationId, projectFavorites.organizationId),
          eq(projects.id, projectFavorites.projectId),
        ),
      )
      .where(
        and(
          eq(projectFavorites.organizationId, context.organizationId),
          eq(projectFavorites.membershipId, membershipId),
        ),
      )
      .orderBy(desc(projectFavorites.createdAt), desc(projectFavorites.id))
      .limit(MAX_FAVORITES_LISTED);
  }
}
