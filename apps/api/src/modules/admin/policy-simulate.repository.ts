import { and, eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, organizations } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The data half of access-policy simulation (x196) — the tenant-scoped reads the simulator computes over.
 *
 * The drizzle handle lives here rather than in the service because `18-REPOSITORY-STRUCTURE` (and the
 * eslint boundary that enforces it) keeps every driver handle inside a repository: feature code takes a
 * `TenantQueryRunner` and asks a repository. Both reads below carry an `organization_id = context
 * .organizationId` predicate, so neither can reach another studio's rows — the tenant boundary the
 * simulator must never cross.
 *
 * The relation set (which projects a member reaches) is *not* read here — it is read by the shared
 * `PrincipalRepository.projectScope`, the same read the live session builder uses, so the simulator's
 * `Principal` is assembled exactly as a real one is.
 */

/** A member's authorization-relevant facts, as read tenant-scoped from `memberships`. */
export interface SimulatedMember {
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  readonly hasOrgWideScope: boolean;
  readonly workspaceScopeId: string | null;
}

/**
 * The tenant-scoped reads the simulator depends on, behind one interface so the service's decision logic
 * can be unit-tested over a fake with the **real** evaluator — exactly as x174's controller test runs the
 * real `authorize` over a faked repository.
 */
export interface PolicySimulateReads {
  organizationExists(runner: TenantQueryRunner, context: TenantContext): Promise<boolean>;
  findMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    memberId: string,
  ): Promise<SimulatedMember | undefined>;
}

export class PolicySimulateRepository implements PolicySimulateReads {
  /** True when the acting organization exists in this tenant. The resolve-before-compute step (404). */
  async organizationExists(runner: TenantQueryRunner, context: TenantContext): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .limit(1);
    return rows.length > 0;
  }

  /** The member's facts, tenant-scoped. Undefined for an unknown or cross-tenant member id (404). */
  async findMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    memberId: string,
  ): Promise<SimulatedMember | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({
        userId: memberships.userId,
        role: memberships.role,
        status: memberships.status,
        hasOrgWideScope: memberships.hasOrgWideScope,
        workspaceScopeId: memberships.workspaceScopeId,
      })
      .from(memberships)
      .where(
        and(eq(memberships.organizationId, context.organizationId), eq(memberships.id, memberId)),
      )
      .limit(1);
    return rows[0];
  }
}
