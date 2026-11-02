import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import {
  CAPABILITIES,
  customRoleKey,
  effectiveCapabilitySet,
  isCustomRoleId,
  isRole,
  parseCustomRoleCapabilities,
} from '@tmanage/domain';
import type { Principal, PrincipalRole } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  customRoles,
  memberships,
  organizations,
  workItemRecurrence,
  workItemRecurrenceInstances,
} from '../../common/database/schema.js';
import type {
  WorkItemRecurrenceInstanceRow,
  WorkItemRecurrenceRow,
} from '../../common/database/schema.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { MembershipOverridesRepository } from '../tenancy/membership-overrides.repository.js';
import { PrincipalRepository } from '../tenancy/principal.repository.js';

/**
 * 53-09 — the recurrence spawner's storage half.
 *
 * One cross-organization read, through `bootstrapRead` with its own reason: which organizations
 * hold an active, materialised rule (ids only). Every other statement here runs on an ordinary
 * tenant runner under a service context naming that organization, and predicates on
 * `organization_id` like every repository (the budget sweep's rule).
 *
 * {@link principalOfUser} rebuilds the rule owner's principal from stored facts — the membership,
 * its custom role and live overrides, and the project scope — the same facts the request-time
 * resolver loads, so `authorize()` answers for the owner exactly as it would in a request. An owner
 * who is no longer an active member resolves to `null`, which the spawner treats as "lost
 * `work.create`" (fail closed).
 */

export const RECURRENCE_SPAWNER_SCAN_REASON = 'recurrence-spawner: organizations with active rules';
/** The policy version the owner contexts carry: a literal no resolved request context produces. */
export const RECURRENCE_SPAWNER_POLICY_VERSION = 'recurrence-spawner';

export interface OwnerIdentity {
  readonly principal: Principal;
  readonly context: TenantContext;
}

export class RecurrenceSpawnerRepository {
  constructor(
    private readonly overrides: MembershipOverridesRepository = new MembershipOverridesRepository(),
    private readonly principals: PrincipalRepository = new PrincipalRepository(),
  ) {}

  /** Cross-org, ids only: organizations (live, not suspended) with an active materialised rule. */
  async organizationsWithActiveRules(runner: BootstrapQueryRunner): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ organizationId: workItemRecurrence.organizationId })
      .from(workItemRecurrence)
      .innerJoin(organizations, eq(organizations.id, workItemRecurrence.organizationId))
      .where(
        and(
          eq(workItemRecurrence.status, 'active'),
          isNotNull(workItemRecurrence.rrule),
          isNull(organizations.archivedAt),
          isNull(organizations.suspendedAt),
        ),
      )
      .orderBy(asc(workItemRecurrence.organizationId));
    return rows.map((row) => row.organizationId);
  }

  async activeRules(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit = 1000,
  ): Promise<readonly WorkItemRecurrenceRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemRecurrence)
      .where(
        and(
          eq(workItemRecurrence.organizationId, context.organizationId),
          eq(workItemRecurrence.status, 'active'),
          isNotNull(workItemRecurrence.rrule),
        ),
      )
      .orderBy(asc(workItemRecurrence.id))
      .limit(limit);
  }

  /** The series' newest spawned instance (with its item), or null. */
  async lastCreatedInstance(
    runner: TenantQueryRunner,
    context: TenantContext,
    recurrenceId: string,
  ): Promise<WorkItemRecurrenceInstanceRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemRecurrenceInstances)
      .where(
        and(
          eq(workItemRecurrenceInstances.organizationId, context.organizationId),
          eq(workItemRecurrenceInstances.recurrenceId, recurrenceId),
          eq(workItemRecurrenceInstances.status, 'created'),
          isNotNull(workItemRecurrenceInstances.workItemId),
        ),
      )
      .orderBy(desc(workItemRecurrenceInstances.occurrenceKey))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Store the spawned item on its claim. */
  async completeInstance(
    runner: TenantQueryRunner,
    context: TenantContext,
    instanceId: string,
    workItemId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(workItemRecurrenceInstances)
      .set({ workItemId })
      .where(
        and(
          eq(workItemRecurrenceInstances.organizationId, context.organizationId),
          eq(workItemRecurrenceInstances.id, instanceId),
          isNull(workItemRecurrenceInstances.workItemId),
        ),
      );
  }

  /** Give a claim back (the create failed), so the next pass retries the occurrence. */
  async releaseInstance(
    runner: TenantQueryRunner,
    context: TenantContext,
    instanceId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(workItemRecurrenceInstances)
      .where(
        and(
          eq(workItemRecurrenceInstances.organizationId, context.organizationId),
          eq(workItemRecurrenceInstances.id, instanceId),
          isNull(workItemRecurrenceInstances.workItemId),
        ),
      );
  }

  /** Move `last_occurrence_key` forward only (keys are ISO dates, so string order is date order). */
  async advanceLastOccurrence(
    runner: TenantQueryRunner,
    context: TenantContext,
    recurrenceId: string,
    key: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(workItemRecurrence)
      .set({ lastOccurrenceKey: key, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(workItemRecurrence.organizationId, context.organizationId),
          eq(workItemRecurrence.id, recurrenceId),
          or(
            isNull(workItemRecurrence.lastOccurrenceKey),
            lt(workItemRecurrence.lastOccurrenceKey, key),
          ),
        ),
      );
  }

  /** Spawned instances of this organization since `since` (the 500-a-day cap). */
  async countSpawnedSince(
    runner: TenantQueryRunner,
    context: TenantContext,
    since: Date,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ n: count() })
      .from(workItemRecurrenceInstances)
      .where(
        and(
          eq(workItemRecurrenceInstances.organizationId, context.organizationId),
          eq(workItemRecurrenceInstances.status, 'created'),
          gte(workItemRecurrenceInstances.createdAt, since),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  /** Active owners and org admins — who gets the daily-cap notice. */
  async adminUserIds(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
          inArray(memberships.role, ['owner', 'org_admin']),
        ),
      )
      .orderBy(asc(memberships.userId))
      .limit(20);
    return rows.map((row) => row.userId);
  }

  /**
   * The owner's principal and a context acting as them, from stored facts; `null` when they are not
   * an active internal member or hold an unknown role.
   */
  async principalOfUser(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<OwnerIdentity | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        membershipId: memberships.id,
        role: memberships.role,
        hasOrgWideScope: memberships.hasOrgWideScope,
        workspaceScopeId: memberships.workspaceScopeId,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    const member = rows[0];
    if (!member) return null;

    let role: PrincipalRole;
    if (isRole(member.role)) {
      role = member.role;
    } else {
      const id = member.role.toLowerCase();
      if (!isCustomRoleId(id)) return null;
      const found = await tenantDrizzle(runner)
        .select({ id: customRoles.id, capabilitiesJson: customRoles.capabilitiesJson })
        .from(customRoles)
        .where(and(eq(customRoles.organizationId, context.organizationId), eq(customRoles.id, id)))
        .limit(1);
      if (!found[0]) return null;
      role = customRoleKey(found[0].id, parseCustomRoleCapabilities(found[0].capabilitiesJson));
    }

    const overrides = await this.overrides.liveOverrides(
      runner,
      context,
      member.membershipId,
      'internal',
    );
    const held = effectiveCapabilitySet({ role, overrides });
    const ownerContext = createTenantContext({
      organizationId: context.organizationId,
      userId,
      principalKind: 'internal',
      membershipId: member.membershipId,
      capabilities: CAPABILITIES.filter((capability) => held.has(capability)),
      policyVersion: RECURRENCE_SPAWNER_POLICY_VERSION,
      correlationId: context.correlationId,
    });
    const projectIds = await this.principals.projectScope(runner, ownerContext, {
      context: ownerContext,
      role,
      clientOrganizationId: null,
      hasOrgWideScope: member.hasOrgWideScope,
      workspaceScopeId: member.workspaceScopeId,
      overrides,
    });
    return {
      context: ownerContext,
      principal: {
        userId,
        organizationId: context.organizationId,
        kind: 'internal',
        role,
        membershipId: member.membershipId,
        membershipStatus: 'active',
        clientOrganizationId: null,
        projectIds,
        hasOrgWideScope: member.hasOrgWideScope,
        overrides,
      },
    };
  }
}
