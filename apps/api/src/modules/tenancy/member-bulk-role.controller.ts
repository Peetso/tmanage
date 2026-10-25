import { Body, Controller, Inject, Module, Optional, Param, Post } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize, CAPABILITIES, mayGrantCapability } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { MemberBulkRoleRepository } from './member-bulk-role.repository.js';
import { BuiltInRolesController, MemberRoleController } from './member-role.controller.js';
import { MembershipsRepository } from './memberships.repository.js';
import { InvitationsRepository } from './invitations.repository.js';
import { isOwnerPrincipal, isRoleAssigner, requireRoleAssigner } from './role-grant-ceiling.js';

/**
 * Admin bulk role assignment (Administration module 18, x222) — the deeper flow the audit named after
 * x173/x195 gave the roles surface create + clone + edit but left assignment one-at-a-time. One route
 * behind `org.manage` assigns an **existing** tenant custom role to **many** memberships in a single
 * bounded batch, and it re-uses `custom_roles` (x173) and `memberships`: no new table, no
 * `capabilities.ts` edit.
 *
 * ## The escalation boundary, re-run before any write
 *
 * A custom role stores a subset of the fixed `CAPABILITIES` allowlist (`12-PERMISSION-MATRIX` §2) and a
 * bulk assign must never widen privilege past the caller. So — exactly as x173's create and x195's
 * clone/edit do — every capability the role carries is re-checked against the caller with the real
 * `authorize` evaluator against an org-wide internal resource **before the first row is touched**. A
 * capability the caller cannot exercise org-wide is a 403 with no write, so a bulk assign can never hand
 * a group of people a role that grants beyond the admin performing it, even if a more privileged author
 * defined that role.
 *
 * ## Resolve tenant-scoped, report per-id, never leak (the Known trap)
 *
 * `@RequireCapability('org.manage')` is the coarse gate `CapabilityGuard` reads first. The handler then:
 *
 * 1. Resolves the addressed **role** tenant-scoped — a role in another tenant, or none, is a 404 with no
 *    write, decided before the real `org.manage` authorize and the escalation guard. A cross-tenant role
 *    id is indistinguishable from an unknown one.
 * 2. Re-runs the escalation guard on that role's capability subset (403, no write).
 * 3. Assigns per **membership** id, each write scoped by `(organization_id, id)`. A foreign or unknown
 *    membership matches no row: it is reported `not_found` for that id — never applied, never a 500,
 *    never a signal that the id exists in another studio. The batch is per-id, **not** all-or-nothing;
 *    the response is a per-id outcome so a caller sees exactly which assignments landed.
 *
 * The batch is bounded (`MAX_BATCH`); a larger list, an empty list, or a missing role is a 400/404 with
 * no write.
 */

/** One requested membership's outcome: the role landed, or the id resolved to no row in this tenant. */
export interface MemberBulkRoleView {
  /** The custom role that was assigned (echoed for the client that fired the batch). */
  readonly roleId: string;
  /** One entry per distinct requested membership id, in request order. */
  readonly assignments: readonly {
    readonly membershipId: string;
    readonly outcome: 'assigned' | 'not_found';
  }[];
}

/** The request body — the role to assign and the memberships to assign it to, both arriving `unknown`. */
interface BulkRoleBody {
  readonly roleId?: unknown;
  readonly membershipIds?: unknown;
}

/**
 * The largest batch one request may carry. A bounded list keeps a single admin action from turning into
 * an unbounded write set; a larger list is a 400 with no write, so the caller pages rather than the
 * server absorbs an arbitrarily long array.
 */
const MAX_BATCH = 100;

/** The org-wide resource the `org.manage` decision and the escalation guard authorize against. */
function orgWideResource(context: TenantContext) {
  return {
    organizationId: context.organizationId,
    projectId: null,
    audience: 'internal' as const,
    lifecycle: 'active' as const,
  };
}

@Controller('v1/organizations/:orgSlug/admin/members')
export class MemberBulkRoleController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(MemberBulkRoleRepository)
    private readonly repository: MemberBulkRoleRepository = new MemberBulkRoleRepository(),
    @Optional() @Inject(AUDIT_SERVICE) private readonly audit?: AuditService,
    @Optional()
    @Inject(MembershipsRepository)
    private readonly memberships: MembershipsRepository = new MembershipsRepository(),
    /** F06: a member who loses `org.manage` here loses the invitations they issued. */
    @Optional()
    @Inject(InvitationsRepository)
    private readonly invitations: InvitationsRepository = new InvitationsRepository(),
  ) {}

  /**
   * Assign one custom role to a batch of memberships (200 — the per-id outcome). Ordering is the same as
   * x195's write paths: resolve the role tenant-scoped first (unknown/cross-tenant → 404 no write), the
   * real `org.manage` authorize, then the escalation guard on the role's caps (403 no write), and only
   * then the per-membership writes — each tenant-scoped, foreign ids reported not-found.
   */
  @Post('bulk-role')
  @RequireCapability('org.manage')
  async assign(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('orgSlug') _orgSlug: string,
    @Body() body: BulkRoleBody,
  ): Promise<MemberBulkRoleView> {
    // Validate the shape before any query: a role id string, and a bounded, non-empty list of
    // membership id strings. Duplicates collapse so the batch does one write per person.
    const roleId = validateRoleId(body?.roleId);
    const membershipIds = validateMembershipIds(body?.membershipIds);

    const assignments = await this.database.transaction(context, async (tx) => {
      // 1. Resolve the addressed role tenant-scoped, BEFORE authorize/guard/write (Known trap).
      const role = await this.repository.findRoleById(tx, context, roleId);
      if (!role) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      // 2. The real org-wide `org.manage` decision (the decorator is the coarse HTTP gate).
      this.requireOrgManage(principal, context);
      // F30: the single-member route's assigner rule — only an owner or organization admin
      // assigns roles (`12-PERMISSION-MATRIX` §2), so a delegated `org.manage` custom role cannot
      // re-role anyone in bulk. Refused before any membership is read or written.
      requireRoleAssigner(principal, 'member_bulk_role');

      // 3. Re-run the escalation guard on the role's capability subset: a bulk assign may never grant a
      //    capability the caller cannot itself exercise org-wide (403, no write).
      const capabilities = parseCapabilities(role.capabilitiesJson);
      assertCallerHolds(principal, context, capabilities);

      // 4. Assign per membership id, each write tenant-scoped; a foreign/unknown id writes no row and is
      //    reported not-found. Per-id, not all-or-nothing. Only an owner may change an owner's seat:
      //    since the organization admin also holds `org.manage` (ADM-03), an admin could otherwise
      //    demote every owner and keep the organization. Each landed change is audited (ADM-11).
      const keepOwners = !isOwnerPrincipal(principal);
      if (!keepOwners) await this.requireAnOwnerRemains(tx, context, membershipIds);
      // Every target is validated before the first write: an organization admin seat is changed
      // only by an owner or organization admin (defence in depth behind the assigner rule).
      const targets = new Map<string, Awaited<ReturnType<MembershipsRepository['findById']>>>();
      for (const membershipId of membershipIds) {
        const target = await this.memberships.findById(tx, context, membershipId);
        if (target?.role === 'org_admin' && !isRoleAssigner(principal)) {
          throw new ApiError(
            403,
            'forbidden',
            MESSAGES.forbidden,
            undefined,
            'member_bulk_role.admin_seat',
          );
        }
        targets.set(membershipId, target);
      }
      const removesOrgManage = !capabilities.includes('org.manage');
      const outcomes: MemberBulkRoleView['assignments'][number][] = [];
      for (const membershipId of membershipIds) {
        const applied = await this.repository.assignRole(tx, context, membershipId, roleId, {
          keepOwners,
        });
        outcomes.push({ membershipId, outcome: applied ? 'assigned' : 'not_found' });
        if (applied) {
          // F06: the new role lacks `org.manage`, so this member's pending invitations go too.
          const target = targets.get(membershipId);
          const invitationsRevoked =
            removesOrgManage && target
              ? await this.invitations.revokePendingIssuedBy(tx, context, target.userId)
              : 0;
          await this.audit?.record(tx, context, {
            action: 'membership.role_changed',
            objectId: membershipId,
            result: 'allowed',
            metadata: {
              custom_role_id: roleId,
              ...(invitationsRevoked > 0
                ? { invitations_revoked: String(invitationsRevoked) }
                : {}),
            },
          });
        }
      }
      return outcomes;
    });

    return { roleId, assignments };
  }

  /**
   * ADM-01: an owner's batch may not demote every active owner (409, no write) — an organization
   * nobody owns cannot be recovered from inside. Counts the active owners outside the batch.
   */
  private async requireAnOwnerRemains(
    tx: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
  ): Promise<void> {
    const ownersInBatch: string[] = [];
    for (const id of membershipIds) {
      const row = await this.memberships.findById(tx, context, id);
      if (row?.role === 'owner' && row.status === 'active') ownersInBatch.push(row.id);
    }
    if (ownersInBatch.length === 0) return;
    const allOwners = await this.memberships.countActiveHoldersOfRoles(tx, context, ['owner']);
    if (allOwners - ownersInBatch.length <= 0) {
      throw new ApiError(
        409,
        'conflict',
        'Make someone else an owner before changing the last owner’s role.',
      );
    }
  }

  /**
   * The real `org.manage` decision — org-wide (`projectId: null`, internal audience), the shape the roles
   * surface uses for the same capability. A denial is a 403 with the machine-readable code.
   */
  private requireOrgManage(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: orgWideResource(context),
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `member_bulk_role.manage:${verdict.code}`,
      );
    }
  }
}

/** Validate the role id: a trimmed, non-empty string. Throws 400 with no write otherwise. */
function validateRoleId(value: unknown): string {
  const roleId = typeof value === 'string' ? value.trim() : '';
  if (roleId.length === 0) {
    throw new ApiError(400, 'validation_failed', 'A role is required.', [
      { field: 'roleId', message: 'Choose a role to assign.' },
    ]);
  }
  return roleId;
}

/**
 * Validate the membership id list: a non-empty array of non-empty strings, no larger than `MAX_BATCH`,
 * de-duplicated with order preserved. Anything else is a 400 with no write.
 */
function validateMembershipIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError(400, 'validation_failed', 'Choose at least one member.', [
      { field: 'membershipIds', message: 'Select one or more members to assign the role to.' },
    ]);
  }
  if (value.length > MAX_BATCH) {
    throw new ApiError(400, 'validation_failed', 'That is too many members for one request.', [
      { field: 'membershipIds', message: `Assign to at most ${MAX_BATCH} members at a time.` },
    ]);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id.length === 0) {
      throw new ApiError(400, 'validation_failed', 'A member id is not valid.', [
        { field: 'membershipIds', message: 'One or more member ids are not valid.' },
      ]);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The privilege-escalation guard: every capability the role carries must be one the caller can exercise
 * org-wide right now (the real evaluator), so a bulk assign can never widen a role past the caller. A
 * capability the caller cannot exercise is a 403 with no write.
 */
function assertCallerHolds(
  principal: Principal,
  context: TenantContext,
  capabilities: readonly Capability[],
): void {
  for (const cap of capabilities) {
    const verdict = mayGrantCapability(principal, cap, context.organizationId);
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        'You can only assign a role whose capabilities you hold yourself.',
        undefined,
        `member_bulk_role.escalation:${verdict.code}`,
      );
    }
  }
}

/** Parse the stored JSON capability array defensively, keeping only allowlisted strings. */
function parseCapabilities(json: string): Capability[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is Capability => typeof c === 'string' && isCapability(c));
  } catch {
    return [];
  }
}

/** Whether a string is one of the fixed allowlisted capabilities. */
function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * x222's wiring — a self-contained module registered from `app.module.ts` (the shared append point),
 * file-disjoint from the members directory and the roles surface. The repository is a stateless
 * collection of tenant-scoped queries; the controller injects it and the `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class MemberBulkRoleModule {
  static register(): DynamicModule {
    return {
      module: MemberBulkRoleModule,
      providers: [
        { provide: MemberBulkRoleRepository, useFactory: () => new MemberBulkRoleRepository() },
      ],
      // ADM-01: the single role change and the built-in role catalogue share this module.
      controllers: [MemberBulkRoleController, MemberRoleController, BuiltInRolesController],
    };
  }
}
