import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  MEMBERSHIPS_REPOSITORY,
  PERSON_CAPACITY_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PersonCapacityRow } from '../../common/database/schema.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { PersonCapacityRepository } from './capacity.repository.js';

/**
 * People capacity (module 14, x170). Two endpoints on one member's capacity: set the weekly hours
 * (`project.manage`, a staffing write) and read them (`work.read`, an internal read).
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on each route asks the coarse `project.manage` / `work.read` question — does this
 * role's ceiling include the capability at all. This controller adds the authoritative application
 * decision (`25-AUTH` §3 step 2, deny-by-default) that the guard cannot: an org-scoped `authorize()`
 * (`projectId: null`) a suspended membership fails, exactly as the sibling org-scoped controllers do.
 *
 * ## The Known-trap order
 *
 * The member is named by `:membershipId` in the path. That id is resolved **tenant-scoped first**, so
 * an unknown or cross-tenant membership is a 404 with no write, before any application authorize or
 * validation — a cross-tenant probe cannot tell "not allowed" (403) from "does not exist". The weekly
 * hours are then validated in [0,168] (a week has 168 hours); out of range is a 400 with no write. The
 * capacity is only then upserted. A capacity view never echoes `organization_id`.
 */

/** What a caller is allowed to see of one member's capacity. `organizationId` is deliberately absent. */
export interface PersonCapacityView {
  readonly membershipId: string;
  readonly weeklyHours: number;
  /** An ISO-8601 date, `YYYY-MM-DD` — the day the figure takes effect. */
  readonly effectiveFrom: string;
  /** An ISO-8601 instant. */
  readonly updatedAt: string;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: PersonCapacityRow): PersonCapacityView {
  return {
    membershipId: row.membershipId,
    weeklyHours: row.weeklyHours,
    effectiveFrom: row.effectiveFrom,
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface SetCapacityBody {
  readonly weeklyHours?: unknown;
  readonly effectiveFrom?: unknown;
}

const MAX_WEEKLY_HOURS = 168;
// `YYYY-MM-DD`, the shape the `effective_from` DATE column stores.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

@Controller('v1/organizations/:orgSlug/people/:membershipId/capacity')
export class PersonCapacityController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(PERSON_CAPACITY_REPOSITORY) private readonly capacity: PersonCapacityRepository,
    // Stateless; provided under its token in this module scope, used to resolve `:membershipId`
    // tenant-scoped before any write.
    @Inject(MEMBERSHIPS_REPOSITORY) private readonly memberships: MembershipsRepository,
  ) {}

  /**
   * Read one member's current capacity. `work.read`, relation-gated org-scoped. The member is resolved
   * tenant-scoped first (unknown / cross-tenant ⇒ 404); a member with no capacity set yet reads `null`.
   */
  @Get()
  @RequireCapability('work.read')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
  ): Promise<{ readonly capacity: PersonCapacityView | null }> {
    this.requireMembershipId(membershipId);

    const row = await this.database.read(context, async (runner) => {
      // Known-trap: resolve the member tenant-scoped first. Unknown / cross-tenant ⇒ 404.
      const member = await this.memberships.findById(runner, context, membershipId);
      if (!member) return undefined;
      return this.capacity.findByMembership(runner, context, membershipId);
    });

    if (row === undefined) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'member_not_visible');
    }
    if (!this.mayActOrg(principal, context, 'work.read')) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'capacity_read_denied');
    }
    return { capacity: row ? toView(row) : null };
  }

  /**
   * Set (create or replace) one member's capacity. `project.manage`, a staffing write.
   *
   * The member is resolved tenant-scoped BEFORE the application authorize or validation (Known-trap):
   * an unknown or cross-tenant id is a 404 with no write. The weekly hours are then validated in
   * [0,168] — out of range is a 400 with no write — and the row is upserted (one active row per member).
   */
  @Put()
  @RequireCapability('project.manage')
  async set(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Body() body: SetCapacityBody,
  ): Promise<PersonCapacityView> {
    this.requireMembershipId(membershipId);

    const row = await this.database.transaction(context, async (tx) => {
      // Known-trap: resolve the member tenant-scoped first. Unknown / cross-tenant ⇒ 404, no write.
      const member = await this.memberships.findById(tx, context, membershipId);
      if (!member) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'member_not_visible');
      }
      if (!this.mayActOrg(principal, context, 'project.manage')) {
        throw new ApiError(
          403,
          'forbidden',
          MESSAGES.forbidden,
          undefined,
          'capacity_write_denied',
        );
      }

      const weeklyHours = this.validateWeeklyHours(body?.weeklyHours);
      const effectiveFrom = this.validateEffectiveFrom(body?.effectiveFrom);

      return this.capacity.set(tx, context, { membershipId, weeklyHours, effectiveFrom });
    });

    return toView(row);
  }

  private requireMembershipId(membershipId: string): void {
    if (typeof membershipId !== 'string' || membershipId === '') {
      throw new ApiError(400, 'validation_failed', 'membershipId is required', [
        { field: 'membershipId', message: 'must be a non-empty string' },
      ]);
    }
  }

  /** Weekly hours: an integer in [0,168], out of range ⇒ 400 with no write. */
  private validateWeeklyHours(value: unknown): number {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > MAX_WEEKLY_HOURS
    ) {
      throw new ApiError(400, 'validation_failed', 'weeklyHours is invalid', [
        { field: 'weeklyHours', message: `must be an integer between 0 and ${MAX_WEEKLY_HOURS}` },
      ]);
    }
    return value;
  }

  /** Effective-from: a `YYYY-MM-DD` date string. */
  private validateEffectiveFrom(value: unknown): string {
    if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
      throw new ApiError(400, 'validation_failed', 'effectiveFrom is invalid', [
        { field: 'effectiveFrom', message: 'must be an ISO-8601 date (YYYY-MM-DD)' },
      ]);
    }
    return value;
  }

  /** Org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
  private mayActOrg(principal: Principal, context: TenantContext, capability: Capability): boolean {
    return authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}
