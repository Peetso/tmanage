import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { PlatformPeopleService } from './people.service.js';

export const PLATFORM_PEOPLE_SERVICE = Symbol.for('tmanage.PlatformPeopleService');

interface ReasonInput {
  readonly reason?: unknown;
}

/** `/v1/platform/people…` — Platform admin · People. Moved here unchanged by the PA-02 split. */
@Controller('v1/platform')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformPeopleController {
  constructor(@Inject(PLATFORM_PEOPLE_SERVICE) private readonly service: PlatformPeopleService) {}

  @Get('people')
  @RequirePlatformPermission('platform.people.view')
  people(@Query('email') email: unknown, @Req() request: object) {
    return this.service.people(email, platformRequestContext(request));
  }

  @Post('people/:userId/sign-out')
  @RequirePlatformPermission('platform.people.security')
  @HttpCode(200)
  signOut(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('userId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.service.signOutEverywhere(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Post('people/:userId/password-reset')
  @RequirePlatformPermission('platform.people.security')
  @HttpCode(202)
  passwordReset(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('userId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.service.sendPasswordReset(actor, id, body ?? {}, platformRequestContext(request));
  }
}
