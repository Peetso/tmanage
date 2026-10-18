import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
} from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import { HOME_PIN_TARGET_KINDS } from '../../common/database/schema.js';
import type { HomePinTargetKind } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { HomePinsRepository } from './home-pins.repository.js';

/**
 * HOME-05's follow-up (x144) — the membership-scoped Home pin surface, distinct from x110's older
 * per-user `saved_context`. A member pins a work item, a project or a document to their Home; the
 * three routes list, add and remove those pins.
 *
 * ## Response projection
 *
 * `HomePinView` is the one CONTRACT-001 response projection: the caller's pins, each row inlined
 * rather than a second `*View`, so the API↔web pairing is this single shape (as `MyDayView` inlines
 * its entry). Dates are ISO strings, the shape `JSON.stringify` emits on the wire.
 */
export interface HomePinView {
  readonly pins: readonly {
    readonly id: string;
    readonly targetKind: HomePinTargetKind;
    readonly targetId: string;
    readonly createdAt: string;
  }[];
}

/** The pin request body — every field arrives as `unknown` and is validated in the route. */
interface CreatePinBody {
  readonly targetKind?: unknown;
  readonly targetId?: unknown;
}

function isHomePinTargetKind(value: unknown): value is HomePinTargetKind {
  return typeof value === 'string' && (HOME_PIN_TARGET_KINDS as readonly string[]).includes(value);
}

/**
 * The three routes are behind `work.read` — the capability every Home read uses, reused rather than
 * a new `home.read` so this slice stays off `capabilities.ts` and the role grid. A caller without
 * `work.read` (a client principal) is refused by `CapabilityGuard` with a 403 before any handler
 * runs. None of the routes reads an `organizationId` or a `membershipId` from anywhere: the tenant
 * and the acting membership are `TenantContextGuard`'s, and a pin is always the acting member's own.
 *
 * The orchestration lives here rather than in a service because it is small and the safety is two
 * rules a controller test proves directly with the real `authorize`: the target is resolved
 * tenant-scoped BEFORE the relation check (an unknown or cross-tenant id is a 404 with no write, the
 * Known trap), and a pin is private to its membership (an off-member unpin is a 404).
 */
@Controller('v1/organizations/:orgSlug/home/pins')
export class HomePinsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(HomePinsRepository)
    private readonly pins: HomePinsRepository = new HomePinsRepository(),
  ) {}

  /** List the acting membership's pins, newest first (200). */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
  ): Promise<HomePinView> {
    return this.listOwn(context);
  }

  /**
   * Pin a target. Returns the caller's pins after the pin (201). The service resolves `targetId`
   * tenant-scoped before the relation check, so an unknown or cross-tenant id is a 404 (Known trap),
   * never a 500. A duplicate of an existing pin is a 409 (the unique key made concrete).
   */
  @Post()
  @RequireCapability('work.read')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreatePinBody,
  ): Promise<HomePinView> {
    const details: { field: string; message: string }[] = [];
    if (!isHomePinTargetKind(body?.targetKind)) {
      details.push({
        field: 'targetKind',
        message: `must be one of ${HOME_PIN_TARGET_KINDS.join(', ')}`,
      });
    }
    const targetId = typeof body?.targetId === 'string' ? body.targetId : undefined;
    if (!targetId) details.push({ field: 'targetId', message: 'must be a string' });

    if (details.length > 0 || !isHomePinTargetKind(body?.targetKind) || !targetId) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    const targetKind = body.targetKind;

    await this.database.transaction(context, async (tx) => {
      // 1. Resolve tenant-scoped, BEFORE authorize (Known trap): unknown/cross-tenant → 404.
      const target = await this.pins.resolveTarget(tx, context, targetKind, targetId);
      if (!target) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      // 2. The relation gate — reused `work.read` against the resolved project, existence-hiding on
      // denial (404, not 403), so a target the caller cannot reach is indistinguishable from absent.
      if (!this.mayReadProject(principal, target.projectId)) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }

      // 3. Own-membership write; a duplicate is a 409, not a second row.
      const existing = await this.pins.findPin(
        tx,
        context,
        context.membershipId,
        targetKind,
        targetId,
      );
      if (existing) {
        throw new ApiError(409, 'conflict', 'That item is already pinned to your Home');
      }
      await this.pins.insert(tx, context, {
        membershipId: context.membershipId,
        targetKind,
        targetId,
      });
    });

    return this.listOwn(context);
  }

  /**
   * Unpin by the pin's id (200 — nothing new was created). Own-membership: the delete is scoped by
   * `membership_id = the acting membership`, so an id that names another member's pin (or no pin)
   * removes nothing and answers 404 — a pin is private, so this hides the existence of one that is
   * not the caller's rather than distinguishing it from absent (the Known trap on the id route).
   */
  @Delete(':pinId')
  @RequireCapability('work.read')
  @HttpCode(200)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Param('pinId') pinId: string,
  ): Promise<HomePinView> {
    const removed = await this.database.transaction(context, (tx) =>
      this.pins.deleteOwn(tx, context, context.membershipId, pinId),
    );
    if (!removed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return this.listOwn(context);
  }

  /** The acting membership's pins, projected. */
  private async listOwn(context: TenantContext): Promise<HomePinView> {
    const rows = await this.database.read(context, (runner) =>
      this.pins.listForMembership(runner, context, context.membershipId),
    );
    return {
      pins: rows.map((row) => ({
        id: row.id,
        targetKind: row.targetKind,
        targetId: row.targetId,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * The reused `work.read` relation gate against a project — the same `authorize()` the Home reads
   * apply. `audience: 'internal'`: this is an internal Home feature. An org-wide role passes the
   * relation by scope, a project member by membership, anyone else is denied.
   */
  private mayReadProject(principal: Principal, projectId: string): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: principal.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}
