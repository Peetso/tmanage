import { and, asc, eq, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { savedViews } from '../../common/database/schema.js';
import type { SavedViewConfig, SavedViewRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * WK-08's storage half (x107) — the saved Work views repository, following the `meetings`
 * (0029) / `documents` (0030) pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * sibling repositories honour it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the
 *    `TenantQueryRunner` for the current unit of work and the `TenantContext`. There is no
 *    overload without a context, so a caller that never established a tenant is a type error.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateSavedViewInput} and
 *    {@link UpdateSavedViewInput} have no `organizationId` field, so a request body cannot choose
 *    the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The owner is likewise never taken from the DTO on a write it must not: `owner_user_id` is set
 * from the input the *service* fills with `context.userId`, and the 0034 trigger pins it (and the
 * tenant) immutable, so a re-owning update is refused at the engine as well as by the service.
 */

export class SavedViewNotFoundError extends Error {
  constructor(readonly savedViewId: string) {
    // No organization id in the message: a not-found returned to a caller must not let a probe
    // for another tenant's saved view tell "does not exist" from "exists elsewhere" (spec §4).
    super(`Saved view ${savedViewId} was not found`);
    this.name = 'SavedViewNotFoundError';
  }
}

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for a
 * request body to populate and no code path that could prefer one over the other.
 */
export interface CreateSavedViewInput {
  /** The person who owns the view — the service passes `context.userId`, never the body. */
  readonly ownerUserId: string;
  /** `null` for an org-wide view; a project id for a project-scoped one. */
  readonly projectId: string | null;
  readonly name: string;
  readonly config: SavedViewConfig;
  readonly shared: boolean;
}

/** The editable fields a save replaces. Identity (`organization_id`, `owner_user_id`) is not here. */
export interface UpdateSavedViewInput {
  readonly projectId: string | null;
  readonly name: string;
  readonly config: SavedViewConfig;
  readonly shared: boolean;
}

export class SavedViewsRepository {
  /**
   * Fetch one saved view by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row, which
   * is why ADR-0001 exists and this signature has no unscoped form.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    savedViewId: string,
  ): Promise<SavedViewRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(savedViews)
      .where(
        and(eq(savedViews.organizationId, context.organizationId), eq(savedViews.id, savedViewId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    savedViewId: string,
  ): Promise<SavedViewRow> {
    const found = await this.findById(runner, context, savedViewId);
    if (!found) throw new SavedViewNotFoundError(savedViewId);
    return found;
  }

  /**
   * The views this person may see: their own, plus every view shared inside the acting studio.
   *
   * Both are tenant-scoped by the `organization_id` predicate; the `owner_user_id = ? OR shared`
   * clause is the visibility rule. Ordered by name then id so the list is deterministic and a
   * duplicate name still has a stable order (id is UUIDv7 ≈ creation order).
   */
  async listForViewer(
    runner: TenantQueryRunner,
    context: TenantContext,
    viewerUserId: string,
  ): Promise<readonly SavedViewRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(savedViews)
      .where(
        and(
          eq(savedViews.organizationId, context.organizationId),
          or(eq(savedViews.ownerUserId, viewerUserId), eq(savedViews.shared, true)),
        ),
      )
      .orderBy(asc(savedViews.name), asc(savedViews.id));
  }

  /**
   * Create a saved view.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`) so a command knows it before the insert
   * commits. `organization_id` comes from the context, never from `input`. When `projectId` is a
   * project id, `fk_saved_views_project_tenant` is a composite foreign key including
   * `organization_id`, so the database refuses a project from another tenant; a `null` `projectId`
   * (org-wide view) skips the check under MATCH SIMPLE. The service resolves an unknown or
   * cross-tenant project to a 404 *before* reaching here, so the foreign key is the belt to that
   * braces rather than the caller-facing error.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateSavedViewInput,
  ): Promise<SavedViewRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(savedViews).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      name: input.name,
      config: input.config,
      shared: input.shared,
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries server-generated timestamps, and
    // returning a hand-assembled object would let the two disagree.
    return this.requireById(runner, context, id);
  }

  /**
   * Replace the editable fields of a saved view the caller owns.
   *
   * Scoped to `(organization_id, id)`; identity (`organization_id`, `owner_user_id`) is not among
   * the columns written and is held immutable by the 0034 trigger besides. The service has already
   * resolved ownership and any named project before calling this.
   */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    savedViewId: string,
    input: UpdateSavedViewInput,
  ): Promise<SavedViewRow> {
    const db = tenantDrizzle(runner);

    await db
      .update(savedViews)
      .set({
        projectId: input.projectId,
        name: input.name,
        config: input.config,
        shared: input.shared,
      })
      .where(
        and(eq(savedViews.organizationId, context.organizationId), eq(savedViews.id, savedViewId)),
      );

    return this.requireById(runner, context, savedViewId);
  }
}
