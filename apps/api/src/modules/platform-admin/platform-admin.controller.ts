import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { AuthenticationRejectedError } from '../identity/authentication.service.js';
import { PLATFORM_ADMIN_SERVICE } from './platform-admin-core.module.js';
import { platformRequestContext } from './platform-admin.access.js';
import {
  CurrentPlatformAdmin,
  PlatformAdminGuard,
  PlatformStepUpExempt,
} from './platform-admin.guard.js';
import type { PlatformAdminActor } from './platform-admin.guard.js';
import type { PlatformAdminService } from './platform-admin.service.js';

export { PLATFORM_ADMIN_SERVICE } from './platform-admin-core.module.js';

/**
 * `/v1/platform/me` and `/v1/platform/step-up` — the two routes a platform admin may call before
 * stepping up, and the only ones that need no platform permission. Every other route lives in
 * its area's controller (`platform-admin.areas.ts`).
 *
 * `@NoTenant()` on the class: no organization is resolved and no organization role is
 * consulted. `PlatformAdminGuard` is the whole of the authorization. POSTs ride the global CSRF
 * guard like every other cookie-session write.
 */
@Controller('v1/platform')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformAdminController {
  constructor(@Inject(PLATFORM_ADMIN_SERVICE) private readonly service: PlatformAdminService) {}

  @Get('me')
  @PlatformStepUpExempt()
  me(@CurrentPlatformAdmin() actor: PlatformAdminActor, @Req() request: object) {
    return this.service.me(actor, platformRequestContext(request));
  }

  @Post('step-up')
  @PlatformStepUpExempt()
  @HttpCode(200)
  async stepUp(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: { password?: unknown; code?: unknown },
    @Req() request: object,
  ) {
    try {
      return await this.service.stepUp(actor, body ?? {}, platformRequestContext(request));
    } catch (error) {
      if (error instanceof AuthenticationRejectedError) {
        if (error.rejection === 'rate_limited') {
          throw new ApiError(
            429,
            'rate_limited',
            'Too many attempts. Wait a few minutes and try again.',
            undefined,
            error.reason,
          );
        }
        // 400, not 401: the session is fine and must stay; only the confirmation failed.
        throw new ApiError(
          400,
          'validation_failed',
          'That password or code is not right.',
          [{ field: 'password', message: 'not confirmed' }],
          error.reason,
        );
      }
      throw error;
    }
  }
}
