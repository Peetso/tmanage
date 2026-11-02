import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { HeaderWriter } from '../files/download-response.js';
import type { UnfurlCard } from './unfurl-meta.js';
import type { UnfurlService } from './unfurl.service.js';

/** Nest token for the unfurl service (kept in this module, not the shared token file). */
export const UNFURL_SERVICE = Symbol('tmanage.unfurl.service');

/**
 * R20-a (54-09 Phase 0) — `GET /v1/organizations/:orgSlug/unfurl?url=`: a preview card for an
 * allow-listed link (Figma, GitHub, Google Docs, OneDrive).
 *
 * ## Deviation from the plan, stated
 *
 * 54-09 sketches an unauthenticated `GET /v1/unfurl`. That would be an open fetch oracle for anyone
 * on the internet, so the route sits under the organization instead: `CapabilityGuard` asks
 * `work.read` and the service adds the org-scoped `authorize()` (deny-by-default) — a signed-in
 * internal member only; a client principal is 403. Nothing else changes: no auth, cookie or token
 * is ever forwarded to the target. Capability: `work.read` (no capabilities.ts edit).
 *
 * The answer is `Cache-Control: private, max-age=300` — the browser may keep a card for five
 * minutes, a shared cache never.
 */
@Controller('v1/organizations/:orgSlug/unfurl')
export class UnfurlController {
  constructor(@Inject(UNFURL_SERVICE) private readonly service: UnfurlService) {}

  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) reply: HeaderWriter,
    @Query('url') url?: string,
  ): Promise<UnfurlCard> {
    if (typeof url !== 'string' || url.trim() === '') {
      throw new ApiError(400, 'validation_failed', 'The link is not a valid URL', [
        { field: 'url', message: 'invalid_url' },
      ]);
    }
    const card = await this.service.unfurl(context, principal, url);
    reply.header('Cache-Control', 'private, max-age=300');
    return card;
  }
}
