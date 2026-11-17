import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TimeLockPage, TimeLockView, TimeLocksService } from './locks.service.js';
import { RequireFeature } from '../admin/feature-gate.js';

export const TIME_LOCKS_SERVICE = Symbol.for('tmanage.TimeLocksService');

/**
 * 52-03 — `/v1/organizations/:orgSlug/time/locks`: close and reopen finance periods, and ask to
 * reopen one. Lock and unlock stand on `finance.manage` (the stand-in for the plan's `time.lock`,
 * see `locks-rules.ts`), the list on `finance.view`, the request on `work.read` (the "track own"
 * stand-in of `time-capabilities.ts`); the service refuses client principals. Org-internal: no
 * portal or public route.
 */
@RequireFeature('time_tracking')
@Controller('v1/organizations/:orgSlug/time/locks')
export class TimeLocksController {
  constructor(@Inject(TIME_LOCKS_SERVICE) private readonly service: TimeLocksService) {}

  @Get()
  @RequireCapability('finance.view')
  list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<TimeLockPage> {
    return this.service.list(context, principal, cursor, limit);
  }

  @Post()
  @RequireCapability('finance.manage')
  @HttpCode(201)
  lock(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<TimeLockView> {
    return this.service.lock(context, principal, body);
  }

  @Delete(':lockId')
  @RequireCapability('finance.manage')
  @HttpCode(200)
  unlock(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('lockId') lockId: string,
    @Body() body: unknown,
  ): Promise<TimeLockView> {
    return this.service.unlock(context, principal, lockId, body);
  }

  @Post(':lockId/unlock-request')
  @RequireCapability('work.read')
  @HttpCode(202)
  requestUnlock(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('lockId') lockId: string,
    @Body() body: unknown,
  ): Promise<{ readonly notified: number }> {
    return this.service.requestUnlock(context, principal, lockId, body);
  }
}
