import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { PlatformKeysService } from './keys.service.js';

export const PLATFORM_KEYS_SERVICE = Symbol.for('tmanage.PlatformKeysService');

/**
 * `/v1/platform/keys…` — 56-02 Settings → Keys. Status only: no route reads, writes or returns a
 * key value. Rotation queues the worker's re-encrypt job (super admin, step-up by the guard).
 */
@Controller('v1/platform/keys')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformKeysController {
  constructor(@Inject(PLATFORM_KEYS_SERVICE) private readonly service: PlatformKeysService) {}

  @Get('status')
  @RequirePlatformPermission('platform.settings.edit')
  status(@Req() request: object) {
    return this.service.status(platformRequestContext(request));
  }

  @Post('rotate')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  rotate(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Readonly<Record<string, unknown>>,
    @Req() request: object,
  ) {
    return this.service.rotate(actor, body ?? {}, platformRequestContext(request));
  }
}
