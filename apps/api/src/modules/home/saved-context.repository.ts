import { and, asc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  conversations,
  deliverableVersions,
  fileAssets,
  messages,
  projects,
  savedContext,
  workItems,
} from '../../common/database/schema.js';
import type { SavedContextEntityType, SavedContextRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * HOME-05's data half — a user's saved/pinned references, and the tenant-scoped resolution the
 * pin write depends on.
 *
 * ## Why this lives here and not in each referenced module
 *
 * A pin references four kinds of entity — a message, a deliverable version (doc), a work item, a
 * file — each owned by a different module. As `MyDayRepository` reads `work_items` directly rather
 * than reaching into the work module, this resolves each referenced table directly rather than
 * building four module dynamic modules; it adds nothing to any of them and shares nothing they
 * touch. The resolution proves only *existence within the tenant and project*, never content — the
 * live title/preview each pin resolves to is the deferred read-fan-out follow-up (NEXT-SCOPES-9).
 *
 * ## The resolution is the tenant boundary
 *
 * `entity_id` carries no foreign key (the target table depends on `entity_type`), so a pin's tenant
 * safety is not an FK. It is that {@link entityExistsInProject} and {@link projectExists} run
 * `organization_id = context.organizationId` predicates: an id in another tenant simply does not
 * resolve, so the service turns it into a 404 with no write, and a pin can never cite a row a
 * different studio owns. `07-DATA-MODEL` §5, `25-AUTH-AND-TENANT-ISOLATION` §6.
 */
export class SavedContextRepository {
  /** Whether a project with this id exists in the acting tenant. */
  async projectExists(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.organizationId, context.organizationId), eq(projects.id, projectId)))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Whether the referenced entity exists in the acting tenant *and belongs to the named project*.
   *
   * Binding the entity to the project is deliberate: a pin groups under a project, so pinning an
   * entity beneath a project it is not part of is as meaningless as pinning one that does not
   * exist, and both resolve to the same 404. A message carries no `project_id` of its own — it
   * belongs to a conversation, which belongs to a project — so it is resolved through a
   * tenant-scoped join to `conversations`; the other three carry `project_id` on their own row.
   */
  async entityExistsInProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    entityType: SavedContextEntityType,
    entityId: string,
    projectId: string,
  ): Promise<boolean> {
    const db = tenantDrizzle(runner);
    if (entityType === 'message') {
      const rows = await db
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(
          conversations,
          and(
            eq(conversations.organizationId, messages.organizationId),
            eq(conversations.id, messages.conversationId),
          ),
        )
        .where(
          and(
            eq(messages.organizationId, context.organizationId),
            eq(messages.id, entityId),
            eq(conversations.projectId, projectId),
          ),
        )
        .limit(1);
      return rows.length > 0;
    }

    const table =
      entityType === 'work' ? workItems : entityType === 'doc' ? deliverableVersions : fileAssets;
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.organizationId, context.organizationId),
          eq(table.id, entityId),
          eq(table.projectId, projectId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** The caller's existing pin of this entity, if any — the idempotency probe. */
  async findPin(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
    entityType: SavedContextEntityType,
    entityId: string,
  ): Promise<SavedContextRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(savedContext)
      .where(
        and(
          eq(savedContext.organizationId, context.organizationId),
          eq(savedContext.userId, userId),
          eq(savedContext.entityType, entityType),
          eq(savedContext.entityId, entityId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** Insert one pin for the acting user. The id and tenant come from here, never from input. */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly userId: string;
      readonly entityType: SavedContextEntityType;
      readonly entityId: string;
      readonly projectId: string;
    },
  ): Promise<SavedContextRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(savedContext)
      .values({
        id,
        organizationId: context.organizationId,
        userId: input.userId,
        entityType: input.entityType,
        entityId: input.entityId,
        projectId: input.projectId,
        createdAt: sql`current_timestamp(3)`,
      });
    const row = await this.findPin(runner, context, input.userId, input.entityType, input.entityId);
    if (!row) throw new Error('saved_context row vanished immediately after insert');
    return row;
  }

  /**
   * Delete the caller's own pin by id. Scoped by `user_id = the acting user`, so an id that names
   * another user's pin (or no pin) removes nothing and the service answers 404 — a pin is private.
   */
  async deleteOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
    id: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(savedContext)
      .where(
        and(
          eq(savedContext.organizationId, context.organizationId),
          eq(savedContext.userId, userId),
          eq(savedContext.id, id),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /**
   * Every pin the acting user holds in this tenant, ordered by project then oldest-first then id
   * for a deterministic read. The grouping is applied by {@link import('./home.service.js')}.
   */
  async listForUser(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<readonly SavedContextRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(savedContext)
      .where(
        and(
          eq(savedContext.organizationId, context.organizationId),
          eq(savedContext.userId, userId),
        ),
      )
      .orderBy(asc(savedContext.projectId), asc(savedContext.createdAt), asc(savedContext.id));
  }
}
