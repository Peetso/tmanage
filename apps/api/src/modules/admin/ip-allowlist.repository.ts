import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { orgIpAllowlist } from '../../common/database/schema.js';
import type { OrgIpAllowlistRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { IpAllowlistInput, IpAllowlistStore } from './ip-allowlist.service.js';

/**
 * Organization IP allowlist — x277's storage half (Administration module 18). The one place that holds
 * a driver handle (the `no-restricted-imports` boundary, `25-AUTH-AND-TENANT-ISOLATION` §6): the
 * service takes a {@link TenantQueryRunner} from `TenantDatabase` and hands it here.
 *
 * Every read and write is bound to `organization_id` from the context — a caller in the wrong tenant
 * sees nothing rather than a leak — and the insert takes its `organization_id` from the context, never
 * from the input, so a request body cannot choose the tenant it writes into. The composite
 * `(organization_id, id)` key of migration 0146 makes a cross-tenant id a non-existent row, and
 * `(organization_id, cidr)` is the unique the duplicate check leans on.
 */
export class AdminIpAllowlistRepository implements IpAllowlistStore {
  /** The tenant's entries, oldest first, bounded to one page. */
  async listAll(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly OrgIpAllowlistRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(orgIpAllowlist)
      .where(eq(orgIpAllowlist.organizationId, context.organizationId))
      .orderBy(asc(orgIpAllowlist.createdAt), asc(orgIpAllowlist.id))
      .limit(MAX_ALLOWLIST_PAGE);
  }

  /** One entry by id, scoped to the tenant; `null` if absent or cross-tenant. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    entryId: string,
  ): Promise<OrgIpAllowlistRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(orgIpAllowlist)
      .where(
        and(
          eq(orgIpAllowlist.organizationId, context.organizationId),
          eq(orgIpAllowlist.id, entryId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** One entry by canonical cidr, scoped to the tenant; `null` if absent. The duplicate check. */
  async findByCidr(
    runner: TenantQueryRunner,
    context: TenantContext,
    cidr: string,
  ): Promise<OrgIpAllowlistRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(orgIpAllowlist)
      .where(
        and(
          eq(orgIpAllowlist.organizationId, context.organizationId),
          eq(orgIpAllowlist.cidr, cidr),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Insert one entry, its `organization_id` from the context. Reads the row back. */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: IpAllowlistInput,
  ): Promise<OrgIpAllowlistRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(orgIpAllowlist)
      .values({
        id,
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        cidr: input.cidr,
        label: input.label,
        createdAt: sql`current_timestamp(3)`,
      });
    const created = await this.findById(runner, context, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('ip allowlist entry vanished immediately after insert');
    }
    return created;
  }

  /** Delete one entry, tenant-scoped. Idempotent: a scoped DELETE of an absent id removes nothing. */
  async remove(runner: TenantQueryRunner, context: TenantContext, entryId: string): Promise<void> {
    await tenantDrizzle(runner)
      .delete(orgIpAllowlist)
      .where(
        and(
          eq(orgIpAllowlist.organizationId, context.organizationId),
          eq(orgIpAllowlist.id, entryId),
        ),
      );
  }
}

/** The largest allowlist a single read returns; mirrors the bounded reads elsewhere. */
const MAX_ALLOWLIST_PAGE = 500;
