import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { AuthenticationRejectedError } from '../identity/authentication.service.js';
import {
  CurrentPlatformAdmin,
  PlatformAdminGuard,
  PlatformStepUpExempt,
} from './platform-admin.guard.js';
import type { PlatformAdminActor } from './platform-admin.guard.js';
import type { PlatformAdminService, RequestContext } from './platform-admin.service.js';

export const PLATFORM_ADMIN_SERVICE = Symbol.for('tmanage.PlatformAdminService');

interface RequestLike {
  readonly ip?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

interface ReasonInput {
  readonly reason?: unknown;
}

/**
 * `/v1/platform/*` — the TManage operator's surface (see `platform-admin.access.ts`).
 *
 * `@NoTenant()` on the class: no organization is resolved and no organization role is
 * consulted. `PlatformAdminGuard` is the whole of the authorization, and it runs on every
 * route here. POSTs and PUTs ride the global CSRF guard like every other cookie-session write.
 */
@Controller('v1/platform')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformAdminController {
  constructor(@Inject(PLATFORM_ADMIN_SERVICE) private readonly service: PlatformAdminService) {}

  @Get('me')
  @PlatformStepUpExempt()
  me(@CurrentPlatformAdmin() actor: PlatformAdminActor) {
    return this.service.me(actor);
  }

  @Post('step-up')
  @PlatformStepUpExempt()
  @HttpCode(200)
  async stepUp(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: { password?: unknown; code?: unknown },
    @Req() request: RequestLike,
  ) {
    try {
      return await this.service.stepUp(actor, body ?? {}, contextOf(request));
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

  @Get('overview')
  overview(@Req() request: RequestLike) {
    return this.service.overview(contextOf(request));
  }

  @Get('companies')
  companies(@Query('q') search: unknown, @Req() request: RequestLike) {
    return this.service.companies(search, contextOf(request));
  }

  @Get('companies/:organizationId')
  company(@Param('organizationId') id: string, @Req() request: RequestLike) {
    return this.service.company(id, contextOf(request));
  }

  @Post('companies/:organizationId/suspension')
  @HttpCode(200)
  suspend(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: ReasonInput,
    @Req() request: RequestLike,
  ) {
    return this.service.setSuspended(actor, id, true, body ?? {}, contextOf(request));
  }

  @Post('companies/:organizationId/reactivation')
  @HttpCode(200)
  reactivate(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: ReasonInput,
    @Req() request: RequestLike,
  ) {
    return this.service.setSuspended(actor, id, false, body ?? {}, contextOf(request));
  }

  @Get('people')
  people(@Query('email') email: unknown, @Req() request: RequestLike) {
    return this.service.people(email, contextOf(request));
  }

  @Post('people/:userId/sign-out')
  @HttpCode(200)
  signOut(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('userId') id: string,
    @Body() body: ReasonInput,
    @Req() request: RequestLike,
  ) {
    return this.service.signOutEverywhere(actor, id, body ?? {}, contextOf(request));
  }

  @Post('people/:userId/password-reset')
  @HttpCode(202)
  passwordReset(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('userId') id: string,
    @Body() body: ReasonInput,
    @Req() request: RequestLike,
  ) {
    return this.service.sendPasswordReset(actor, id, body ?? {}, contextOf(request));
  }

  @Get('settings')
  settings(@Req() request: RequestLike) {
    return this.service.settings(contextOf(request));
  }

  @Put('settings/public-signup')
  setPublicSignup(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: { open?: unknown; reason?: unknown },
    @Req() request: RequestLike,
  ) {
    return this.service.setPublicSignup(actor, body ?? {}, contextOf(request));
  }

  /** S11: the platform AI kill switch — `/mcp` and the OAuth endpoints answer 503 while off. */
  @Put('settings/ai-access')
  setAiAccess(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: { on?: unknown; reason?: unknown },
    @Req() request: RequestLike,
  ) {
    return this.service.setAiAccess(actor, body ?? {}, contextOf(request));
  }

  @Get('audit')
  audit(@Req() request: RequestLike) {
    return this.service.auditLog(contextOf(request));
  }
}

function contextOf(request: RequestLike): RequestContext {
  const state = requireRequestState(request);
  const userAgent = request.headers['user-agent'];
  return {
    correlationId: state.correlationId,
    ip: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
  };
}
