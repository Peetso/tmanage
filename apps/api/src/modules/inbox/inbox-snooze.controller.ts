import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { INBOX_SNOOZE_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { InboxSnoozeService, InboxSnoozeView } from './inbox-snooze.service.js';

/** The snooze request body — `until` arrives as `unknown` and is validated in the service. */
interface SnoozeBody {
  readonly until?: unknown;
}

/**
 * IN-01/IN-02's HTTP surface (x259) — snooze an inbox bundle until a chosen time, un-snooze it, and
 * list the caller's snoozes.
 *
 * ## The capability, reused
 *
 * All three routes sit behind `work.read` — the very capability `InboxController` already requires,
 * reused rather than a new `inbox.snooze` so this slice stays off `capabilities.ts` and the role
 * grid. A client principal (without `work.read`) is refused 403 by `CapabilityGuard` before any
 * handler runs. None of the routes reads an `organizationId` or a `membershipId` from anywhere: the
 * tenant and the acting membership are `TenantContextGuard`'s, and a snooze is always the acting
 * member's own. The two safety rules — bundle ownership resolved BEFORE authorize (404), and a valid
 * future `until` (400) with no upsert — live in the service, proven by the controller test with the
 * real `authorize`.
 */
@Controller('v1/organizations/:orgSlug/inbox')
export class InboxSnoozeController {
  constructor(@Inject(INBOX_SNOOZE_SERVICE) private readonly snoozes: InboxSnoozeService) {}

  /** The acting membership's snoozes (200). */
  @Get('snoozed')
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
  ): Promise<InboxSnoozeView> {
    return this.snoozes.list(context);
  }

  /**
   * Snooze a bundle until `body.until` (200 — an upsert, nothing new is created for a re-snooze). The
   * service resolves the bundle tenant-scoped and relation-checks BEFORE the write (404 for an
   * unknown/cross-tenant/unreachable bundle), then requires a valid future `until` (400, no upsert).
   */
  @Put(':bundleId/snooze')
  @RequireCapability('work.read')
  @HttpCode(200)
  async snooze(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('bundleId') bundleId: string,
    @Body() body: SnoozeBody,
  ): Promise<InboxSnoozeView> {
    return this.snoozes.snooze(context, principal, bundleId, body?.until);
  }

  /** Un-snooze a bundle (200). Own-membership: an id that is not the caller's snooze is a 404. */
  @Delete(':bundleId/snooze')
  @RequireCapability('work.read')
  @HttpCode(200)
  async unsnooze(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Param('bundleId') bundleId: string,
  ): Promise<InboxSnoozeView> {
    return this.snoozes.unsnooze(context, bundleId);
  }
}
