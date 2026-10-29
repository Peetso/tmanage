import { Body, Controller, Get, Inject, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import type { MemberEffectivePermissionsView } from '../../tenancy/membership-overrides.controller.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import { PLATFORM_PERMISSIONS_SERVICE } from './org-roles.controller.js';
import type {
  PlatformMemberPermissionsView,
  PlatformPermissionsService,
} from './permissions.service.js';

/**
 * platform-admin v2 · PA-04 — `/v1/platform/organizations/:organizationId/members/:membershipId…`
 * permission routes (SPEC §5.2, D8 member overrides + "what can this person do").
 *
 * - `GET  …/permissions` — the person, their overrides (live and expired) and the effective
 *   matrix (`platform.orgs.view`).
 * - `PUT  …/permissions/overrides` `{overrides, reason?}` — replace the overrides
 *   (`platform.permissions.edit`): an owner is a 400, a client contact's internal-only
 *   permission is a 400, a past expiry is a 400.
 * - `GET  …/effective-permissions?projectId=` — the effective matrix alone, optionally simulated
 *   on one project (`platform.orgs.view`).
 */
@Controller('v1/platform/organizations/:organizationId/members/:membershipId')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformMemberPermissionsController {
  constructor(
    @Inject(PLATFORM_PERMISSIONS_SERVICE) private readonly service: PlatformPermissionsService,
  ) {}

  @Get('permissions')
  @RequirePlatformPermission('platform.orgs.view')
  read(
    @Param('organizationId') organizationId: string,
    @Param('membershipId') membershipId: string,
    @Query('projectId') projectId: string | undefined,
    @Req() request: object,
  ): Promise<PlatformMemberPermissionsView> {
    return this.service.memberPermissions(
      organizationId,
      membershipId,
      projectId,
      platformRequestContext(request),
    );
  }

  @Put('permissions/overrides')
  @RequirePlatformPermission('platform.permissions.edit')
  replace(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') organizationId: string,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
    @Req() request: object,
  ): Promise<PlatformMemberPermissionsView> {
    return this.service.replaceOverrides(
      actor,
      organizationId,
      membershipId,
      body ?? {},
      platformRequestContext(request),
    );
  }

  @Get('effective-permissions')
  @RequirePlatformPermission('platform.orgs.view')
  effective(
    @Param('organizationId') organizationId: string,
    @Param('membershipId') membershipId: string,
    @Query('projectId') projectId: string | undefined,
    @Req() request: object,
  ): Promise<MemberEffectivePermissionsView> {
    return this.service.effectivePermissions(
      organizationId,
      membershipId,
      projectId,
      platformRequestContext(request),
    );
  }
}
