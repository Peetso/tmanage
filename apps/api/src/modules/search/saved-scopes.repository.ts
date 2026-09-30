import { and, asc, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { searchScopes } from '../../common/database/schema.js';
import type { SearchScopeFilters, SearchScopeRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * SRCH saved scopes (x334) — the data half. One stateless repository over `search_scopes`.
 *
 * ## Every operation is scoped to one member in one studio
 *
 * A saved scope is private: the owner is the only reader, editor and deleter. So every method here
 * carries both `organization_id = context.organizationId` AND `member_user_id = context.userId`
 * predicates — the tenant boundary and the owner boundary together. A cross-tenant id, or another
 * member's id, simply does not match, so the service turns it into a 404 with no disclosure that a
 * row exists. The name uniqueness within an owner is the `(organization_id, member_user_id, name)`
 * unique key; a duplicate surfaces as a driver error the service maps to a 409.
 */
export class SearchScopesRepository {
  /** Insert one scope owned by the acting member. The id and tenant come from here. */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { readonly name: string; readonly filters: SearchScopeFilters },
  ): Promise<SearchScopeRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(searchScopes)
      .values({
        id,
        organizationId: context.organizationId,
        memberUserId: context.userId,
        name: input.name,
        filters: input.filters,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });
    const row = await this.findOwned(runner, context, id);
    if (!row) throw new Error('search_scopes row vanished immediately after insert');
    return row;
  }

  /** One of the acting member's scopes by id, tenant- and owner-scoped, or undefined. */
  async findOwned(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<SearchScopeRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(searchScopes)
      .where(
        and(
          eq(searchScopes.organizationId, context.organizationId),
          eq(searchScopes.memberUserId, context.userId),
          eq(searchScopes.id, id),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** One of the acting member's scopes by exact name, tenant- and owner-scoped, or undefined. */
  async findOwnedByName(
    runner: TenantQueryRunner,
    context: TenantContext,
    name: string,
  ): Promise<SearchScopeRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(searchScopes)
      .where(
        and(
          eq(searchScopes.organizationId, context.organizationId),
          eq(searchScopes.memberUserId, context.userId),
          eq(searchScopes.name, name),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** The acting member's scopes, newest first with id breaking ties (a total order). */
  async listOwned(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly SearchScopeRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(searchScopes)
      .where(
        and(
          eq(searchScopes.organizationId, context.organizationId),
          eq(searchScopes.memberUserId, context.userId),
        ),
      )
      .orderBy(desc(searchScopes.createdAt), asc(searchScopes.id));
  }

  /**
   * Replace one of the acting member's scopes in place (idempotent PUT). Scoped by tenant and owner,
   * so an id that names another member's row or nothing updates nothing and returns undefined — the
   * service answers 404. Returns the refreshed row on success.
   */
  async updateOwned(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    input: { readonly name: string; readonly filters: SearchScopeFilters },
  ): Promise<SearchScopeRow | undefined> {
    const result = await tenantDrizzle(runner)
      .update(searchScopes)
      .set({
        name: input.name,
        filters: input.filters,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(searchScopes.organizationId, context.organizationId),
          eq(searchScopes.memberUserId, context.userId),
          eq(searchScopes.id, id),
        ),
      );
    if (result[0].affectedRows === 0) return undefined;
    return this.findOwned(runner, context, id);
  }

  /**
   * Delete one of the acting member's scopes by id. Scoped by tenant and owner, so an id that names
   * another member's row or nothing removes nothing and the service answers 404 — a scope is private,
   * so its existence is never disclosed to anyone but its owner.
   */
  async deleteOwned(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(searchScopes)
      .where(
        and(
          eq(searchScopes.organizationId, context.organizationId),
          eq(searchScopes.memberUserId, context.userId),
          eq(searchScopes.id, id),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
