import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  StorageMoveLatest,
  StorageMoveService,
  StorageMoveView,
} from './storage-move.service.js';

export const STORAGE_MOVE_SERVICE = Symbol.for('tmanage.StorageMoveService');

/**
 * 57-13b. "Move to Drive", beside the other company storage routes:
 *
 * - `POST …/integrations/storage/migration-jobs` — `{provider}`: start moving the files TManage
 *   still holds into that connected provider (or answer the job already running).
 * - `GET  …/integrations/storage/migration-jobs` — the latest job, for the storage card.
 * - `GET  …/integrations/storage/migration-jobs/:jobId` — one job's progress and counts.
 *
 * All behind `org.security.manage` (Owner, Org Admin); the service authorizes again. Never an AI
 * action (`ai-actions/registry/never.ts`).
 */
@Controller('v1/organizations/:orgSlug/integrations/storage/migration-jobs')
export class StorageMoveController {
  constructor(@Inject(STORAGE_MOVE_SERVICE) private readonly moves: StorageMoveService) {}

  @Post()
  @RequireCapability('org.security.manage')
  @HttpCode(202)
  async start(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<StorageMoveView> {
    return this.moves.start(context, principal, body);
  }

  @Get()
  @RequireCapability('org.security.manage')
  async latest(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StorageMoveLatest> {
    return this.moves.latest(context, principal);
  }

  @Get(':jobId')
  @RequireCapability('org.security.manage')
  async status(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('jobId') jobId: string,
  ): Promise<StorageMoveView> {
    return this.moves.status(context, principal, jobId);
  }
}
