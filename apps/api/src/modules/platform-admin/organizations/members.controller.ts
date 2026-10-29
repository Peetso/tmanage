import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { PlatformOrganizationMembersService } from './members.service.js';

export const PLATFORM_ORG_MEMBERS_SERVICE = Symbol.for(
  'tmanage.PlatformOrganizationMembersService',
);

interface ReasonInput {
  readonly reason?: unknown;
}

/**
 * `/v1/platform/organizations/:organizationId/{members,invitations}` — A6 (SPEC §6, PA-07).
 * Reading needs `platform.orgs.view`; every change needs `platform.people.roles`. Offboarding is on
 * the destructive list (reason required, in the service). Invitations: list and revoke; a resend
 * goes through the organization's own owner (see the slice notes).
 */
@Controller('v1/platform/organizations/:organizationId')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformOrganizationMembersController {
  constructor(
    @Inject(PLATFORM_ORG_MEMBERS_SERVICE)
    private readonly service: PlatformOrganizationMembersService,
  ) {}

  @Get('members')
  @RequirePlatformPermission('platform.orgs.view')
  list(@Param('organizationId') id: string, @Req() request: object) {
    return this.service.list(id, platformRequestContext(request));
  }

  @Post('members')
  @RequirePlatformPermission('platform.people.roles')
  add(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: { readonly email?: unknown; readonly role?: unknown; readonly reason?: unknown },
    @Req() request: object,
  ) {
    return this.service.add(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Put('members/:membershipId/role')
  @RequirePlatformPermission('platform.people.roles')
  changeRole(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Param('membershipId') membershipId: string,
    @Body() body: { readonly role?: unknown; readonly reason?: unknown },
    @Req() request: object,
  ) {
    return this.service.changeRole(
      actor,
      id,
      membershipId,
      body ?? {},
      platformRequestContext(request),
    );
  }

  @Post('members/:membershipId/offboard')
  @RequirePlatformPermission('platform.people.roles')
  @HttpCode(200)
  offboard(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Param('membershipId') membershipId: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.service.offboard(
      actor,
      id,
      membershipId,
      body ?? {},
      platformRequestContext(request),
    );
  }

  @Get('invitations')
  @RequirePlatformPermission('platform.orgs.view')
  invitations(@Param('organizationId') id: string, @Req() request: object) {
    return this.service.list(id, platformRequestContext(request));
  }

  @Post('invitations/:invitationId/revoke')
  @RequirePlatformPermission('platform.people.roles')
  @HttpCode(200)
  revoke(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Param('invitationId') invitationId: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.service.revokeInvitation(
      actor,
      id,
      invitationId,
      body ?? {},
      platformRequestContext(request),
    );
  }
}
