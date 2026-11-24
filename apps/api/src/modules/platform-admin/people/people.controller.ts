import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { StreamableFile } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { PeopleQuery, PlatformPeopleService } from './people.service.js';
import { csvDownload, type HeaderWriter } from '../../identity/geo/trail-csv.js';

export const PLATFORM_PEOPLE_SERVICE = Symbol.for('tmanage.PlatformPeopleService');

interface ReasonInput {
  readonly reason?: unknown;
}

/**
 * `/v1/platform/people…` — Platform admin v2 · People (PA-06, SPEC §5.3). Reads need
 * `platform.people.view`, the profile edit `platform.people.edit`, every security action
 * `platform.people.security`. Role changes and overrides use the organization routes (PA-07, PA-04).
 */
@Controller('v1/platform')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformPeopleController {
  constructor(@Inject(PLATFORM_PEOPLE_SERVICE) private readonly service: PlatformPeopleService) {}

  @Get('people')
  @RequirePlatformPermission('platform.people.view')
  people(@Query() query: PeopleQuery, @Req() request: object) {
    return this.service.list(query ?? {}, platformRequestContext(request));
  }

  /** RESENDVERIFY. How many unconfirmed password accounts the bulk send would reach. */
  @Get('people/email-confirmations')
  @RequirePlatformPermission('platform.people.view')
  emailConfirmationBacklog(@Req() request: object) {
    return this.service.emailConfirmationBacklog(platformRequestContext(request));
  }

  /** RESENDVERIFY. Mail the confirmation link to every unconfirmed password account (capped). */
  @Post('people/email-confirmations')
  @RequirePlatformPermission('platform.people.security')
  @HttpCode(202)
  sendEmailConfirmations(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.service.sendEmailConfirmations(actor, body ?? {}, platformRequestContext(request));
  }

  @Get('people/:userId')
  @RequirePlatformPermission('platform.people.view')
  person(@Param('userId') id: string, @Req() request: object) {
    return this.service.detail(id, platformRequestContext(request));
  }

  @Patch('people/:userId')
  @RequirePlatformPermission('platform.people.edit')
  update(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('userId') id: string,
    @Body() body: Readonly<Record<string, unknown>>,
    @Req() request: object,
  ) {
    return this.service.updateProfile(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Get('people/:userId/sessions')
  @RequirePlatformPermission('platform.people.view')
  sessions(@Param('userId') id: string, @Req() request: object) {
    return this.service.sessions(id, platformRequestContext(request));
  }

  /** R12. The person's sign-in trail as a UTC CSV (`?from&to`, default 30 days); audited. */
  @Get('people/:userId/sign-in-trail.csv')
  @RequirePlatformPermission('platform.people.security')
  async signInTrail(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('userId') id: string,
    @Query() query: PeopleQuery,
    @Req() request: object,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const context = platformRequestContext(request);
    const csv = await this.service.signInTrail(actor, id, query ?? {}, context);
    return csvDownload(reply, csv, 'sign-in-trail.csv');
  }

  @Delete('people/:userId/sessions/:sessionId')
  @RequirePlatformPermission('platform.people.security')
  @HttpCode(200)
  endSession(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('userId') id: string,
    @Param('sessionId') sessionId: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.service.endSession(
      actor,
      id,
      sessionId,
      body ?? {},
      platformRequestContext(request),
    );
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

  /** RESENDVERIFY. Mail this person the ordinary confirmation link; `{status}`. */
  @Post('people/:userId/email-confirmation')
  @RequirePlatformPermission('platform.people.security')
  @HttpCode(202)
  emailConfirmation(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('userId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.service.sendEmailConfirmation(
      actor,
      id,
      body ?? {},
      platformRequestContext(request),
    );
  }

  @Post('people/:userId/two-step/reset')
  @RequirePlatformPermission('platform.people.security')
  @HttpCode(200)
  resetTwoStep(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('userId') id: string,
    @Body() body: { readonly reason?: unknown; readonly signOut?: unknown },
    @Req() request: object,
  ) {
    return this.service.resetTwoStep(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Put('people/:userId/two-step/required')
  @RequirePlatformPermission('platform.people.security')
  twoStepRequired(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('userId') id: string,
    @Body() body: { readonly required?: unknown; readonly reason?: unknown },
    @Req() request: object,
  ) {
    return this.service.setTwoStepRequired(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Post('people/:userId/disable')
  @RequirePlatformPermission('platform.people.security')
  @HttpCode(200)
  disable(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('userId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.service.disable(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Post('people/:userId/enable')
  @RequirePlatformPermission('platform.people.security')
  @HttpCode(200)
  enable(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('userId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.service.enable(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Get('people/:userId/organizations')
  @RequirePlatformPermission('platform.people.view')
  organizations(@Param('userId') id: string, @Req() request: object) {
    return this.service.organizations(id, platformRequestContext(request));
  }

  @Get('people/:userId/access')
  @RequirePlatformPermission('platform.people.view')
  access(@Param('userId') id: string, @Query() query: PeopleQuery, @Req() request: object) {
    return this.service.access(id, query ?? {}, platformRequestContext(request));
  }

  @Get('people/:userId/actions')
  @RequirePlatformPermission('platform.people.view')
  actions(@Param('userId') id: string, @Query() query: PeopleQuery, @Req() request: object) {
    return this.service.actions(id, query ?? {}, platformRequestContext(request));
  }
}
