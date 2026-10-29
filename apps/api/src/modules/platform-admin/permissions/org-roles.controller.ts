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
  Req,
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type {
  PlatformOrgRoleDeleteView,
  PlatformOrgRolesView,
  PlatformOrgRoleWriteView,
  PlatformPermissionsService,
} from './permissions.service.js';

export const PLATFORM_PERMISSIONS_SERVICE = Symbol.for('tmanage.PlatformPermissionsService');

/**
 * platform-admin v2 · PA-04 — `/v1/platform/organizations/:organizationId/roles…` (SPEC §5.2,
 * D7 role matrix editor, A6 roles tab).
 *
 * Reads need `platform.orgs.view`; every write needs `platform.permissions.edit`. Built-in roles
 * are listed read-only (their ceilings are code); custom roles are created, edited, cloned and
 * deleted (holders reassigned first) through the same repository the organization side uses.
 */
@Controller('v1/platform/organizations/:organizationId/roles')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformOrgRolesController {
  constructor(
    @Inject(PLATFORM_PERMISSIONS_SERVICE) private readonly service: PlatformPermissionsService,
  ) {}

  @Get()
  @RequirePlatformPermission('platform.orgs.view')
  list(
    @Param('organizationId') organizationId: string,
    @Req() request: object,
  ): Promise<PlatformOrgRolesView> {
    return this.service.listRoles(organizationId, platformRequestContext(request));
  }

  @Post()
  @RequirePlatformPermission('platform.permissions.edit')
  @HttpCode(201)
  create(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') organizationId: string,
    @Body() body: Record<string, unknown>,
    @Req() request: object,
  ): Promise<PlatformOrgRoleWriteView> {
    return this.service.createRole(
      actor,
      organizationId,
      body ?? {},
      platformRequestContext(request),
    );
  }

  @Patch(':roleId')
  @RequirePlatformPermission('platform.permissions.edit')
  update(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') organizationId: string,
    @Param('roleId') roleId: string,
    @Body() body: Record<string, unknown>,
    @Req() request: object,
  ): Promise<PlatformOrgRoleWriteView> {
    return this.service.updateRole(
      actor,
      organizationId,
      roleId,
      body ?? {},
      platformRequestContext(request),
    );
  }

  @Post(':roleId/clone')
  @RequirePlatformPermission('platform.permissions.edit')
  @HttpCode(201)
  clone(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') organizationId: string,
    @Param('roleId') roleId: string,
    @Body() body: Record<string, unknown>,
    @Req() request: object,
  ): Promise<PlatformOrgRoleWriteView> {
    return this.service.cloneRole(
      actor,
      organizationId,
      roleId,
      body ?? {},
      platformRequestContext(request),
    );
  }

  @Delete(':roleId')
  @RequirePlatformPermission('platform.permissions.edit')
  remove(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') organizationId: string,
    @Param('roleId') roleId: string,
    @Body() body: Record<string, unknown>,
    @Req() request: object,
  ): Promise<PlatformOrgRoleDeleteView> {
    return this.service.deleteRole(
      actor,
      organizationId,
      roleId,
      body ?? {},
      platformRequestContext(request),
    );
  }
}
