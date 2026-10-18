import { Body, Controller, Get, HttpCode, Inject, Optional, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import { RECENT_ITEM_OBJECT_TYPES } from '../../common/database/schema.js';
import type { RecentItemObjectType } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { RecentItemsService } from './recent-items.service.js';
import type { RecentItemsView } from './recent-items.service.js';

/** The record-a-view request body — every field arrives as `unknown` and is validated in the route. */
interface RecordViewBody {
  readonly objectType?: unknown;
  readonly objectId?: unknown;
}

function isRecentItemObjectType(value: unknown): value is RecentItemObjectType {
  return (
    typeof value === 'string' && (RECENT_ITEM_OBJECT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * HOME recents (x324) — the Home "Recently viewed" rail's two routes, distinct from x144's explicit
 * `home_pinned_items` (deliberate pins) and x110's `saved_context` (saved references). As a member
 * opens an entity the client records a view; Home reads the member's recents, newest first.
 *
 * Both routes are behind `work.read` — the capability every Home read uses, reused rather than a new
 * `home.*` so this slice stays off `capabilities.ts` and the role grid. A caller without `work.read`
 * (a client principal) is refused by `CapabilityGuard` with a 403 before any handler runs, so no
 * view is ever recorded for, or read by, a principal that lacks it. Neither route reads an
 * `organizationId` or a `membershipId` from anywhere: the tenant and the acting membership are
 * `TenantContextGuard`'s, and a recent is always the acting member's own — the self-scope substance
 * a controller test proves directly (a recorded view and a read never cross memberships).
 *
 * A recent is reference-only: the route stores the caller-supplied `object_type` + `object_id`
 * verbatim and resolves no title, so it can disclose nothing about a target the caller could not
 * already reach — an `object_type` off {@link RECENT_ITEM_OBJECT_TYPES} is a 400 with no upsert.
 */
@Controller('v1/organizations/:orgSlug/home/recent-items')
export class RecentItemsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(RecentItemsService)
    private readonly service: RecentItemsService = new RecentItemsService(database),
  ) {}

  /** The acting membership's recents, newest first, bounded to the fixed cap (200). */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
  ): Promise<RecentItemsView> {
    return this.service.list(context);
  }

  /**
   * Record that the acting member viewed an object, then return their recents (200 — the upsert
   * refreshes an existing row's time in place, creating nothing new; a repeat is idempotent). An
   * `object_type` off the allowlist, or a missing `object_id`, is a 400 with no upsert.
   */
  @Put()
  @RequireCapability('work.read')
  @HttpCode(200)
  async record(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Body() body: RecordViewBody,
  ): Promise<RecentItemsView> {
    const details: { field: string; message: string }[] = [];
    if (!isRecentItemObjectType(body?.objectType)) {
      details.push({
        field: 'objectType',
        message: `must be one of ${RECENT_ITEM_OBJECT_TYPES.join(', ')}`,
      });
    }
    const objectId = typeof body?.objectId === 'string' ? body.objectId : undefined;
    if (!objectId) details.push({ field: 'objectId', message: 'must be a string' });

    if (details.length > 0 || !isRecentItemObjectType(body?.objectType) || !objectId) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.service.recordView(context, { objectType: body.objectType, objectId });
  }
}
