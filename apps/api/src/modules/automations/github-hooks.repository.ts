import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  githubDeliveries,
  githubRepoHooks,
  integrationConnections,
} from '../../common/database/schema.js';
import type { GithubRepoHookRow, IntegrationConnectionRow } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * R16-e (54-10 Phase 0) — storage for `github_repo_hooks` and `github_deliveries` (0294). Every
 * statement but {@link GithubHooksRepository.findHookOrganization} carries the `organization_id`
 * from the caller's context. That one is the public route's pre-context read: it runs on
 * `bootstrapRead(['github_repo_hooks'])`, returns only `(organization_id, id)`, and the caller
 * re-reads the hook under a service context for that organization.
 */

export interface NewRepoHook {
  readonly id: string;
  readonly connectionId: string;
  readonly repoFullName: string;
  readonly secretEnc: string;
  readonly projectIds: readonly string[];
  readonly createdBy: string;
}

const MAX_HOOKS_LISTED = 200;

export class GithubHooksRepository {
  /** The org's `github` connection row, oldest first. */
  async findConnection(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<IntegrationConnectionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.organizationId, context.organizationId),
          eq(integrationConnections.appId, 'github'),
        ),
      )
      .orderBy(asc(integrationConnections.id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findHookOrganization(
    runner: BootstrapQueryRunner,
    hookId: string,
  ): Promise<{ readonly organizationId: string; readonly id: string } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ organizationId: githubRepoHooks.organizationId, id: githubRepoHooks.id })
      .from(githubRepoHooks)
      .where(eq(githubRepoHooks.id, hookId))
      .limit(1);
    return rows[0] ?? null;
  }

  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly GithubRepoHookRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(githubRepoHooks)
      .where(eq(githubRepoHooks.organizationId, context.organizationId))
      .orderBy(desc(githubRepoHooks.id))
      .limit(MAX_HOOKS_LISTED);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    forUpdate = false,
  ): Promise<GithubRepoHookRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(githubRepoHooks)
      .where(
        and(eq(githubRepoHooks.organizationId, context.organizationId), eq(githubRepoHooks.id, id)),
      )
      .limit(1);
    const rows = forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async findByRepo(
    runner: TenantQueryRunner,
    context: TenantContext,
    repoFullName: string,
  ): Promise<GithubRepoHookRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(githubRepoHooks)
      .where(
        and(
          eq(githubRepoHooks.organizationId, context.organizationId),
          eq(githubRepoHooks.repoFullName, repoFullName),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: NewRepoHook,
    at: Date,
  ): Promise<GithubRepoHookRow> {
    await tenantDrizzle(runner)
      .insert(githubRepoHooks)
      .values({
        id: input.id,
        organizationId: context.organizationId,
        connectionId: input.connectionId,
        repoFullName: input.repoFullName,
        secretEnc: input.secretEnc,
        projectIdsJson: JSON.stringify(input.projectIds),
        status: 'active',
        eventsHourCount: 0,
        createdBy: input.createdBy,
        createdAt: at,
      });
    const row = await this.findById(runner, context, input.id);
    if (!row) throw new Error(`github hook ${input.id} vanished after insert`);
    return row;
  }

  async remove(runner: TenantQueryRunner, context: TenantContext, id: string): Promise<void> {
    await tenantDrizzle(runner)
      .delete(githubRepoHooks)
      .where(
        and(eq(githubRepoHooks.organizationId, context.organizationId), eq(githubRepoHooks.id, id)),
      );
  }

  async updateSecret(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    secretEnc: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(githubRepoHooks)
      .set({ secretEnc })
      .where(
        and(eq(githubRepoHooks.organizationId, context.organizationId), eq(githubRepoHooks.id, id)),
      );
  }

  /** Record one accepted event against the hour budget. */
  async recordEvent(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    budget: { readonly hourStartedAt: Date; readonly count: number },
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(githubRepoHooks)
      .set({
        eventsHourStartedAt: budget.hourStartedAt,
        eventsHourCount: budget.count,
        lastEventAt: at,
      })
      .where(
        and(eq(githubRepoHooks.organizationId, context.organizationId), eq(githubRepoHooks.id, id)),
      );
  }

  async deliverySeen(
    runner: TenantQueryRunner,
    context: TenantContext,
    hookId: string,
    deliveryId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: githubDeliveries.id })
      .from(githubDeliveries)
      .where(
        and(
          eq(githubDeliveries.organizationId, context.organizationId),
          eq(githubDeliveries.hookId, hookId),
          eq(githubDeliveries.deliveryId, deliveryId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Record the delivery id and drop this hook's ids older than `purgeBefore`. */
  async recordDelivery(
    runner: TenantQueryRunner,
    context: TenantContext,
    hookId: string,
    deliveryId: string,
    at: Date,
    purgeBefore: Date,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(githubDeliveries)
      .where(
        and(
          eq(githubDeliveries.organizationId, context.organizationId),
          eq(githubDeliveries.hookId, hookId),
          lt(githubDeliveries.receivedAt, purgeBefore),
        ),
      );
    await db.insert(githubDeliveries).values({
      id: uuidv7(),
      organizationId: context.organizationId,
      hookId,
      deliveryId,
      receivedAt: at,
    });
  }
}
