import { Body, Controller, Delete, Get, HttpCode, Inject, Put } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  INBOX_SOURCE_MUTES_SERVICE,
  type InboxSourceMutesService,
  type InboxSourceMutesView,
} from './source-mutes.service.js';

/** The mute/un-mute request body — `objectType`/`objectId` arrive as `unknown`, validated in the service. */
interface SourceMuteBody {
  readonly objectType?: unknown;
  readonly objectId?: unknown;
}

/**
 * x318's HTTP surface — mute a specific inbox source object so its bundle is filtered out of the
 * caller's inbox, un-mute it, and list the caller's mutes.
 *
 * ## The capability, reused
 *
 * All three routes sit behind `work.read` — the very capability `InboxController` already requires,
 * reused rather than a new `inbox.mute` so this slice stays off `capabilities.ts` and the role grid.
 * A client principal (without `work.read`) is refused 403 by `CapabilityGuard` before any handler
 * runs, so a mute is never inserted for a caller who cannot read the inbox (the required refusal).
 * None of the routes reads an `organizationId` or a `userId` from anywhere: the tenant and the acting
 * member are `TenantContextGuard`'s, and a mute is always the acting member's own. The allowlist and
 * shape checks (an off-allowlist object_type or malformed id → 400, no write) live in the service.
 */
@Controller('v1/organizations/:orgSlug/inbox')
export class InboxSourceMutesController {
  constructor(
    @Inject(INBOX_SOURCE_MUTES_SERVICE) private readonly mutes: InboxSourceMutesService,
  ) {}

  /** The acting member's muted sources (200). */
  @Get('source-mutes')
  @RequireCapability('work.read')
  async list(@Ctx() context: TenantContext): Promise<InboxSourceMutesView> {
    return this.mutes.list(context);
  }

  /**
   * Mute a source (200 — idempotent; re-muting the same source creates nothing new). The service
   * validates the object_type against the inbox allowlist and the object_id (400, no insert), then
   * inserts if the caller has not already muted it, scoped to the acting member.
   */
  @Put('source-mutes')
  @RequireCapability('work.read')
  @HttpCode(200)
  async mute(
    @Ctx() context: TenantContext,
    @Body() body: SourceMuteBody,
  ): Promise<InboxSourceMutesView> {
    return this.mutes.mute(context, body?.objectType, body?.objectId);
  }

  /**
   * Un-mute a source (204). Own-scoped and idempotent: a source the caller has not muted removes
   * nothing and still answers 204. The object_type/object_id are validated the same way (400).
   */
  @Delete('source-mutes')
  @RequireCapability('work.read')
  @HttpCode(204)
  async unmute(@Ctx() context: TenantContext, @Body() body: SourceMuteBody): Promise<void> {
    await this.mutes.unmute(context, body?.objectType, body?.objectId);
  }
}
