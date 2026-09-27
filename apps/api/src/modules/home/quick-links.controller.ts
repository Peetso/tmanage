import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { HOME_QUICK_LINKS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { HomeQuickLinksService, HomeQuickLinksView } from './quick-links.service.js';

/**
 * Home quick links (module 4 Home / My Day, HOME-05 "Saved/pinned context", x273) — a member's own
 * small, ordered list of personal shortcuts on My Day: a human label and a relative in-app path they
 * add, reorder and remove.
 *
 * Distinct from x144 Home pins (which pin *objects* — a work item / project / document by id) and
 * x243 Home widget prefs (which order the *fixed* Home widgets): this is free-form personal
 * shortcuts the member typed.
 *
 * ## Own-principal, and the capability reused rather than invented
 *
 * None of the four routes reads an `organizationId` or a `membershipId` from anywhere: the tenant and
 * the acting membership are `TenantContextGuard`'s, and a quick link is always the acting member's
 * own (`context.membershipId`, never a body value). The capability is **`work.read`**, the same
 * choice x243's widget prefs and x144's Home pins made: `12-PERMISSION-MATRIX` names no Home-prefs
 * capability, `work.read` is the one every internal role holds and no client role does, and adding a
 * quick-links capability would put a word in the ceiling table the matrix does not have (the pass
 * forbids editing `capabilities.ts`). A client principal without `work.read` is refused 403 by
 * `CapabilityGuard` before any handler runs.
 *
 * The orchestration and the safety (open-redirect path guard, count cap, reorder allowlist) live in
 * {@link HomeQuickLinksService}, which the controller test drives directly.
 */
@Controller('v1/organizations/:orgSlug/home/quick-links')
export class HomeQuickLinksController {
  constructor(@Inject(HOME_QUICK_LINKS_SERVICE) private readonly service: HomeQuickLinksService) {}

  /** List the acting membership's quick links, in position order (200). */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
  ): Promise<HomeQuickLinksView> {
    return this.service.list(context, context.membershipId);
  }

  /**
   * Add a quick link (201). The body's `label` must be non-empty and `path` must be a relative
   * in-app path (leading "/", no scheme or host) — an absolute URL is a 400 with no write. A member
   * at the cap gets a 409.
   */
  @Post()
  @RequireCapability('work.read')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Body() body: unknown,
  ): Promise<HomeQuickLinksView> {
    return this.service.create(context, context.membershipId, body);
  }

  /**
   * Reorder the caller's quick links (200). The body's `ids` must be a permutation of the caller's
   * current link ids — an unknown id, duplicate or omission is a 400 with no write.
   */
  @Put('order')
  @RequireCapability('work.read')
  @HttpCode(200)
  async reorder(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Body() body: unknown,
  ): Promise<HomeQuickLinksView> {
    return this.service.reorder(context, context.membershipId, body);
  }

  /**
   * Remove the caller's quick link by id (200). Own-membership: an id that names another member's
   * link (or no link) removes nothing and answers 404.
   */
  @Delete(':linkId')
  @RequireCapability('work.read')
  @HttpCode(200)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Param('linkId') linkId: string,
  ): Promise<HomeQuickLinksView> {
    return this.service.remove(context, context.membershipId, linkId);
  }
}
