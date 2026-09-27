import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingSeatRow } from '../../common/database/schema.js';
import { BillingSeatsRepository } from './seats.repository.js';

/**
 * Billing seats — Billing module 19 (x178). The service and controller for seat management: assign a
 * seat to a membership, list the active seats and their count, and reclaim (release) a seat.
 *
 * The service is co-located here (with the module that wires it) rather than in a separate file
 * because it is small and the slice adds no other consumer of it — the shape
 * `DocumentTemplateVariablesModule` (x130) uses.
 *
 * ## Resolve the target, tenant-scoped, BEFORE authorizing or writing
 *
 * `POST` names a `membershipId` in its body and `DELETE` a `seatId` in its path. Each is read first,
 * scoped to the acting tenant: a membership or seat from another studio simply does not resolve, and
 * the answer is the same **404** an absent id gives — with **no write**. Only once the row is in hand
 * does the service authorize `org.manage`. That order is the trap x178 was briefed on: a cross-tenant
 * target is a 404 with no write, never a seat created against somebody else's membership.
 *
 * ## `org.manage` is the one gate
 *
 * Seat management is an organization-settings action, so every route is behind `org.manage` — the
 * route guard asks the coarse question (UX/defence), and this service authorizes it again as the
 * authoritative decision (`25-AUTH-AND-TENANT-ISOLATION` §3: route guards are UX only, the API
 * authorizes every action). Reusing `org.manage` — no `capabilities.ts` edit — scopes this to owners,
 * the population an entitlement/billing capability would name if one existed (AUTH-16 pending).
 *
 * ## No money moves
 *
 * A seat is an assignment fact. Enforcing a seat ceiling against a paid plan, and charging for a
 * seat, are Needs-Peter (real payment / card storage is out of scope): this slice inserts and
 * soft-closes rows and counts against nothing paid.
 */

/**
 * What a caller is allowed to see of one billing seat — paired Exact with the web's `BillingSeat` in
 * `e2e/contracts/api-web-shapes.ts`. `organizationId` is deliberately absent: the wire projection
 * never echoes the tenant id.
 */
export interface BillingSeatView {
  readonly id: string;
  readonly membershipId: string;
  readonly assignedAt: string;
  readonly releasedAt: string | null;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: BillingSeatRow): BillingSeatView {
  return {
    id: row.id,
    membershipId: row.membershipId,
    assignedAt: row.assignedAt.toISOString(),
    releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
  };
}

/**
 * The active-seat roster read. Not a `…View` and not a named web interface — it is the endpoint's
 * envelope around the one paired projection ({@link BillingSeatView}), the shape `work-forms`' list
 * read uses inline. The element is what the contracts gate pairs.
 */
export type BillingSeatsList = {
  readonly seats: readonly BillingSeatView[];
  readonly activeCount: number;
};

export class BillingSeatsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly seats: BillingSeatsRepository = new BillingSeatsRepository(),
  ) {}

  /** The tenant's active seats and their count. Behind `org.manage`. */
  async list(context: TenantContext, principal: Principal): Promise<BillingSeatsList> {
    this.requireOrgManage(principal, context, 'billing_seat.list');
    const rows = await this.database.read(context, (runner) =>
      this.seats.listActive(runner, context),
    );
    const seats = rows.map(toView);
    return { seats, activeCount: seats.length };
  }

  /**
   * Assign a seat to a membership. Resolves the membership tenant-scoped (**404**, no write) before
   * it authorizes (`org.manage`, 403); a membership that already holds an active seat is a **409**.
   */
  async assign(
    context: TenantContext,
    principal: Principal,
    membershipId: string,
  ): Promise<BillingSeatView> {
    return this.database.transaction(context, async (tx) => {
      const membership = await this.seats.findMembership(tx, context, membershipId);
      if (!membership) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'membership_not_visible',
        );
      }
      this.requireOrgManage(principal, context, 'billing_seat.assign');

      const active = await this.seats.findActiveForMembership(tx, context, membershipId);
      if (active) {
        throw new ApiError(
          409,
          'conflict',
          'That membership already holds an active seat',
          [{ field: 'membershipId', message: 'already holds an active seat' }],
          'billing_seat_already_active',
        );
      }

      return toView(await this.seats.create(tx, context, membershipId));
    });
  }

  /**
   * Reclaim a seat — a soft close that stamps `released_at`. Resolves the seat tenant-scoped
   * (**404**, no write) before it authorizes (`org.manage`, 403). An already-released seat is the
   * same 404 an absent one gives, so a double-release writes nothing.
   */
  async release(
    context: TenantContext,
    principal: Principal,
    seatId: string,
  ): Promise<BillingSeatView> {
    return this.database.transaction(context, async (tx) => {
      const seat = await this.seats.findById(tx, context, seatId);
      if (!seat || seat.releasedAt !== null) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'seat_not_visible');
      }
      this.requireOrgManage(principal, context, 'billing_seat.release');

      const released = await this.seats.release(tx, context, seatId);
      if (!released) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      return toView(released);
    });
  }

  /** Authorize an org-scoped `org.manage` (projectId null), or throw 403. */
  private requireOrgManage(principal: Principal, context: TenantContext, action: string): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        // Null: an org-level resource (organization settings), no project relation to lean on.
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `${action}:${verdict.code}`,
      );
    }
  }
}

interface AssignSeatBody {
  readonly membershipId?: unknown;
}

/** DI token for the co-located service, so no `tokens.ts` edit is needed for this slice. */
const BILLING_SEATS_SERVICE = Symbol.for('tmanage.BillingSeatsService');

@Controller('v1/organizations/:orgSlug/billing/seats')
export class BillingSeatsController {
  constructor(@Inject(BILLING_SEATS_SERVICE) private readonly seats: BillingSeatsService) {}

  /** List the tenant's active seats and their count. `org.manage`. */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<BillingSeatsList> {
    return this.seats.list(context, principal);
  }

  /** Assign a seat to a membership. `org.manage`. */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async assign(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: AssignSeatBody,
  ): Promise<BillingSeatView> {
    const membershipId = requiredMembershipId(body?.membershipId);
    return this.seats.assign(context, principal, membershipId);
  }

  /** Reclaim (release) a seat, tenant-scoped. `org.manage`. */
  @Delete(':seatId')
  @RequireCapability('org.manage')
  async release(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('seatId') seatId: string,
  ): Promise<BillingSeatView> {
    if (typeof seatId !== 'string' || seatId === '') {
      throw new ApiError(400, 'validation_failed', 'seatId is required', [
        { field: 'seatId', message: 'must be a non-empty string' },
      ]);
    }
    return this.seats.release(context, principal, seatId);
  }
}

/** A `membershipId` is always required and always a non-empty string. */
function requiredMembershipId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'membershipId', message: 'must be a non-empty string' },
    ]);
  }
  return raw.trim();
}

/**
 * Billing module 19 (x178). The module that wires the controller and its co-located service.
 * Registered in `app.module.ts` as a self-contained billing module (none existed at this base), so
 * this slice stays file-disjoint from the sibling billing slices.
 */
@Module({})
export class BillingSeatsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: BILLING_SEATS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new BillingSeatsService(database),
    };

    return {
      module: BillingSeatsModule,
      providers: [service],
      controllers: [BillingSeatsController],
    };
  }
}
