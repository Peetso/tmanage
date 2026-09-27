import { Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { INBOX_FLAG_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { InboxFlagService, InboxFlagView, InboxFlaggedView } from './inbox-flag.service.js';

/**
 * INBOX-001 IN-01 "Important inbox" (x260) — the HTTP surface for flagging an inbox bundle.
 *
 * ## The capability the inbox already requires, and the gate that matters
 *
 * All three routes sit behind **`work.read`** — the capability `InboxController` itself requires, the
 * one every internal role holds and no client role does. No capability is invented (pass-24 forbids
 * editing `capabilities.ts`). The coarse guard is the outer half; the control that matters is the
 * service's, which resolves the bundle's ownership against the caller's own notification rows BEFORE it
 * writes, so flagging another member's bundle is the same 404 the list hides a bundle behind — the
 * ownership gate runs before authorize, never after.
 *
 * The subject is always the authenticated `principal`'s membership: the request has no path or query
 * that could name another membership, so a caller flags, unflags and lists only their own.
 */
@Controller('v1/organizations/:orgSlug/inbox')
export class InboxFlagController {
  constructor(@Inject(INBOX_FLAG_SERVICE) private readonly flags: InboxFlagService) {}

  /** The caller's flagged bundles, newest first. Declared before the `:bundleId` routes it never shadows. */
  @Get('flagged')
  @RequireCapability('work.read')
  async listFlagged(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<InboxFlaggedView> {
    return this.flags.listFlagged(context, principal);
  }

  /** Flag a bundle as important. Ownership is re-checked first; a bundle not the caller's is a 404. */
  @Put(':bundleId/flag')
  @RequireCapability('work.read')
  @HttpCode(200)
  async flag(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('bundleId') bundleId: string,
  ): Promise<InboxFlagView> {
    return this.flags.flag(context, principal, bundleId);
  }

  /** Unflag a bundle. Scoped to the caller's membership and idempotent — always 204. */
  @Delete(':bundleId/flag')
  @RequireCapability('work.read')
  @HttpCode(204)
  async unflag(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('bundleId') bundleId: string,
  ): Promise<void> {
    await this.flags.unflag(context, principal, bundleId);
  }
}
