import { Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { SAVED_SEARCH_SHARES_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  SavedSearchSharesService,
  SharedSavedSearchView,
} from './saved-search-shares.service.js';

/**
 * SRCH saved-search sharing (x272). The HTTP surface over `saved_search_shares` — share one of your
 * own saved searches with the studio, unshare it, and list what the studio has shared.
 *
 * Every route sits behind `@RequireCapability('search.use')` — the SRCH-01 search capability,
 * **reused** so this slice stays off `capabilities.ts` and the role grid; a caller without it is a
 * 403 (the global `CapabilityGuard`'s) before any handler runs. No route reads an `organizationId`
 * or a `userId` from anywhere: the tenant and the acting user are `TenantContextGuard`'s. The
 * service resolves the saved search by `(tenant, id)` **before** it authorizes — an unknown id is a
 * 404, and only the owning member may share/unshare (a non-owner is a 403, with no write).
 */
@Controller('v1/organizations/:orgSlug/search')
export class SavedSearchSharesController {
  constructor(
    @Inject(SAVED_SEARCH_SHARES_SERVICE) private readonly shares: SavedSearchSharesService,
  ) {}

  /** Every saved search the studio has shared, newest share first (200). */
  @Get('shared')
  @RequireCapability('search.use')
  async listShared(
    @Ctx() context: TenantContext,
  ): Promise<{ readonly shared: readonly SharedSavedSearchView[] }> {
    return { shared: await this.shares.listShared(context) };
  }

  /**
   * Share the acting user's own saved search with the studio (200, idempotent). The service resolves
   * the saved search before authorizing (unknown id → 404) and refuses a non-owner (403, no insert).
   * Returns the refreshed shared list.
   */
  @Put('saved/:savedSearchId/share')
  @RequireCapability('search.use')
  @HttpCode(200)
  async share(
    @Ctx() context: TenantContext,
    @Param('savedSearchId') savedSearchId: string,
  ): Promise<{ readonly shared: readonly SharedSavedSearchView[] }> {
    return { shared: await this.shares.share(context, savedSearchId) };
  }

  /**
   * Unshare the acting user's own saved search (204). Resolves before authorizing (unknown id →
   * 404) and refuses a non-owner (403, no delete). Idempotent — the resource ends absent either way.
   */
  @Delete('saved/:savedSearchId/share')
  @RequireCapability('search.use')
  @HttpCode(204)
  async unshare(
    @Ctx() context: TenantContext,
    @Param('savedSearchId') savedSearchId: string,
  ): Promise<void> {
    await this.shares.unshare(context, savedSearchId);
  }
}
