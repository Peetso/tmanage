import { and, asc, eq, gt } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { integrationConnections } from '../../common/database/schema.js';
import type {
  IntegrationConnectionConfig,
  IntegrationConnectionRow,
  IntegrationConnectionStatus,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The Automations directory repository — org-scoped app/integration connections (x165), following the
 * `work_forms` pattern (0052).
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * work-forms repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateConnectionInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 */

/**
 * What the controller creates. No `organizationId` (from the context), so a request body cannot choose
 * the tenant it writes into. `config` has already been validated by the controller (bounded,
 * non-secret) before it reaches here.
 */
export interface CreateConnectionInput {
  readonly appId: string;
  readonly label: string;
  readonly status: IntegrationConnectionStatus;
  readonly config: IntegrationConnectionConfig;
  /** The person creating the connection — the controller passes `context.userId`. */
  readonly createdBy: string;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class IntegrationConnectionsRepository {
  /**
   * List a tenant's connections, app-id ascending then id, within the acting tenant. Both the tenant
   * predicate and a deterministic order are present, and the walk is bounded to `MAX_PAGE_SIZE`.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: { readonly after?: string; readonly limit?: number } = {},
  ): Promise<readonly IntegrationConnectionRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [eq(integrationConnections.organizationId, context.organizationId)];
    if (options.after) predicates.push(gt(integrationConnections.id, options.after));

    return db
      .select()
      .from(integrationConnections)
      .where(and(...predicates))
      .orderBy(asc(integrationConnections.appId), asc(integrationConnections.id))
      .limit(limit);
  }

  /**
   * Fetch one connection by id, within the acting tenant. A cross-tenant id resolves to null here —
   * there is no `findById(id)` without a context, which on MySQL would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    connectionId: string,
  ): Promise<IntegrationConnectionRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.organizationId, context.organizationId),
          eq(integrationConnections.id, connectionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a connection.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`). `organization_id` comes from the context,
   * never from `input`. The row is read back so the server-generated `created_at` is the one returned
   * rather than a hand-assembled guess.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateConnectionInput,
  ): Promise<IntegrationConnectionRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(integrationConnections).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      appId: input.appId,
      label: input.label,
      status: input.status,
      configJson: input.config,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, id);
    if (!created) {
      // Unreachable: we just inserted this id in this unit of work. A guard for the type, not a case.
      throw new Error(`integration connection ${id} vanished after insert`);
    }
    return created;
  }
}
