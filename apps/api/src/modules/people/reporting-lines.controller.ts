import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  MEMBERSHIPS_REPOSITORY,
  REPORTING_LINES_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { ReportingLinesRepository } from './reporting-lines.repository.js';

/**
 * People reporting lines / org chart (module 14, x217). Three endpoints over a member's *manager*:
 * set/clear it (`org.manage`, a people-structure write), read one member's line, and read the tenant's
 * whole reporting tree (`work.read`, internal reads).
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on each route asks the coarse `org.manage` / `work.read` question — does this
 * role's ceiling include the capability at all. This controller adds the authoritative application
 * decision (`25-AUTH` §3 step 2, deny-by-default) the guard cannot: an org-scoped `authorize()`
 * (`projectId: null`) a suspended membership fails, exactly as the sibling org-scoped controllers do.
 *
 * ## The Known-trap order, and acyclicity
 *
 * A member is named by `:membershipId`; the manager by the body. Both are resolved **tenant-scoped
 * first**, so an unknown or cross-tenant membership is a 404 with no write, before any application
 * authorize — a cross-tenant probe cannot tell "not allowed" (403) from "does not exist". A member is
 * never their own manager (400), and a longer cycle (A→B→…→A) is refused by walking the proposed
 * manager's chain upward within the tenant, bounded, before the write (400, no write). The reporting
 * tree the org chart draws is therefore always a forest.
 */

/**
 * One member's reporting line — the member and who they report to. `managerMembershipId` is `null` when
 * the member has no manager (a root of the tree). `organizationId` is deliberately absent — the wire
 * never echoes the tenant. This is the org chart's edge; a list of these is the whole tree.
 */
export interface ReportingLineView {
  readonly membershipId: string;
  readonly managerMembershipId: string | null;
}

interface SetManagerBody {
  readonly managerMembershipId?: unknown;
}

// A pre-existing corrupt cycle would make the upward walk loop forever; this bounds it. Writes reject
// cycles, so a healthy dataset is a forest and the walk terminates at a root well within this.
const MAX_CHAIN_WALK = 100_000;

@Controller('v1/organizations/:orgSlug/people')
export class ReportingLinesController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(REPORTING_LINES_REPOSITORY) private readonly reportingLines: ReportingLinesRepository,
    // Stateless; provided under its token in this module scope, used to resolve the member and the
    // manager tenant-scoped before any write.
    @Inject(MEMBERSHIPS_REPOSITORY) private readonly memberships: MembershipsRepository,
  ) {}

  /**
   * Read the whole tenant reporting tree — every reporting line, as edges. `work.read`, org-scoped.
   *
   * Declared before the `:membershipId/manager` routes so `org-chart` is never captured as a member id
   * (it is a single path segment; the manager routes are two).
   */
  @Get('org-chart')
  @RequireCapability('work.read')
  async orgChart(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly lines: readonly ReportingLineView[] }> {
    if (!this.mayActOrg(principal, context, 'work.read')) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'org_chart_read_denied');
    }
    const rows = await this.database.read(context, (runner) =>
      this.reportingLines.listAll(runner, context),
    );
    return {
      lines: rows.map((row) => ({
        membershipId: row.memberId,
        managerMembershipId: row.managerMemberId,
      })),
    };
  }

  /**
   * Read one member's reporting line. `work.read`, org-scoped. The member is resolved tenant-scoped
   * first (unknown / cross-tenant ⇒ 404); a member with no manager reads `managerMembershipId: null`.
   */
  @Get(':membershipId/manager')
  @RequireCapability('work.read')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
  ): Promise<{ readonly reportingLine: ReportingLineView }> {
    this.requireMembershipId(membershipId);

    const resolved = await this.database.read(context, async (runner) => {
      const member = await this.memberships.findById(runner, context, membershipId);
      if (!member) return undefined;
      return this.reportingLines.findByMember(runner, context, membershipId);
    });

    if (resolved === undefined) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'member_not_visible');
    }
    if (!this.mayActOrg(principal, context, 'work.read')) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'reporting_read_denied');
    }
    return {
      reportingLine: {
        membershipId,
        managerMembershipId: resolved ? resolved.managerMemberId : null,
      },
    };
  }

  /**
   * Set or clear one member's manager. `org.manage`, a people-structure write.
   *
   * The body's `managerMembershipId` is a string (set) or `null` (clear). Both the member and, when
   * setting, the manager are resolved tenant-scoped BEFORE the application authorize (Known-trap): an
   * unknown or cross-tenant id is a 404 with no write. A self-manager is a 400; a cycle is a 400 —
   * both with no write. The row is then upserted, or the line deleted.
   */
  @Put(':membershipId/manager')
  @RequireCapability('org.manage')
  async set(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Body() body: SetManagerBody,
  ): Promise<ReportingLineView> {
    this.requireMembershipId(membershipId);
    const managerMembershipId = this.parseManager(body?.managerMembershipId);

    return this.database.transaction(context, async (tx) => {
      // Known-trap: resolve the member tenant-scoped first. Unknown / cross-tenant ⇒ 404, no write.
      const member = await this.memberships.findById(tx, context, membershipId);
      if (!member) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'member_not_visible');
      }

      if (managerMembershipId === null) {
        if (!this.mayActOrg(principal, context, 'org.manage')) {
          throw new ApiError(
            403,
            'forbidden',
            MESSAGES.forbidden,
            undefined,
            'reporting_write_denied',
          );
        }
        await this.reportingLines.clear(tx, context, membershipId);
        return { membershipId, managerMembershipId: null };
      }

      // A member is never their own manager — a 400 with no write.
      if (managerMembershipId === membershipId) {
        throw new ApiError(400, 'validation_failed', 'A member cannot be their own manager', [
          { field: 'managerMembershipId', message: 'must differ from the member' },
        ]);
      }

      // Known-trap: resolve the manager tenant-scoped too. Unknown / cross-tenant ⇒ 404, no write.
      const manager = await this.memberships.findById(tx, context, managerMembershipId);
      if (!manager) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'manager_not_visible');
      }

      if (!this.mayActOrg(principal, context, 'org.manage')) {
        throw new ApiError(
          403,
          'forbidden',
          MESSAGES.forbidden,
          undefined,
          'reporting_write_denied',
        );
      }
      // 60-09: the org chart is people only; an AI employee neither reports nor manages.
      if (member.kind !== 'human' || manager.kind !== 'human') {
        throw new ApiError(
          422,
          'validation_failed',
          'An AI employee is not counted as a person here.',
          [
            {
              field: member.kind !== 'human' ? 'membershipId' : 'managerMembershipId',
              message: 'An AI employee is not counted as a person here.',
            },
          ],
          'reporting_line.ai_employee',
        );
      }

      // A cycle is a 400 with no write: walk the proposed manager's chain upward within the tenant; if
      // it reaches this member, the new edge would close a loop.
      const lines = await this.reportingLines.listAll(tx, context);
      if (this.wouldCycle(lines, membershipId, managerMembershipId)) {
        throw new ApiError(400, 'validation_failed', 'A reporting line cannot form a cycle', [
          { field: 'managerMembershipId', message: 'the chosen manager reports to this member' },
        ]);
      }

      const row = await this.reportingLines.set(tx, context, {
        memberId: membershipId,
        managerMemberId: managerMembershipId,
      });
      return { membershipId: row.memberId, managerMembershipId: row.managerMemberId };
    });
  }

  private requireMembershipId(membershipId: string): void {
    if (typeof membershipId !== 'string' || membershipId === '') {
      throw new ApiError(400, 'validation_failed', 'membershipId is required', [
        { field: 'membershipId', message: 'must be a non-empty string' },
      ]);
    }
  }

  /** The manager id: a non-empty string (set) or `null` (clear). Anything else is a 400. */
  private parseManager(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== 'string' || value === '') {
      throw new ApiError(400, 'validation_failed', 'managerMembershipId is invalid', [
        { field: 'managerMembershipId', message: 'must be a non-empty string, or null to clear' },
      ]);
    }
    return value;
  }

  /**
   * Would setting `member`'s manager to `manager` close a cycle? Follow `manager`'s existing chain
   * upward through the current edge set; a cycle exists if it reaches `member`. Bounded so a
   * pre-existing corrupt cycle cannot loop forever.
   */
  private wouldCycle(
    lines: readonly { readonly memberId: string; readonly managerMemberId: string }[],
    member: string,
    manager: string,
  ): boolean {
    const managerOf = new Map<string, string>();
    for (const line of lines) managerOf.set(line.memberId, line.managerMemberId);

    let current: string | undefined = manager;
    let steps = 0;
    while (current !== undefined && steps < MAX_CHAIN_WALK) {
      if (current === member) return true;
      current = managerOf.get(current);
      steps += 1;
    }
    return false;
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
