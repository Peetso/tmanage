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
  Req,
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type { PlatformTeamService } from './team.service.js';

export const PLATFORM_TEAM_SERVICE = Symbol.for('tmanage.PlatformTeamService');

/**
 * `/v1/platform/team…` — the platform admin team and its permission presets (SPEC §5.1, D5/D6).
 *
 * Reading and changing both need `platform.team.manage`, which only the super admin preset
 * carries: who holds platform access is itself something only a super admin should see.
 */
@Controller('v1/platform/team')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformTeamController {
  constructor(@Inject(PLATFORM_TEAM_SERVICE) private readonly service: PlatformTeamService) {}

  @Get()
  @RequirePlatformPermission('platform.team.manage')
  list(@CurrentPlatformAdmin() actor: PlatformAdminActor, @Req() request: object) {
    return this.service.list(actor, platformRequestContext(request));
  }

  @Post()
  @RequirePlatformPermission('platform.team.manage')
  @HttpCode(201)
  add(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: Record<string, unknown>,
    @Req() request: object,
  ) {
    return this.service.add(actor, body ?? {}, platformRequestContext(request));
  }

  @Get('presets')
  @RequirePlatformPermission('platform.team.manage')
  presets(@CurrentPlatformAdmin() actor: PlatformAdminActor, @Req() request: object) {
    return this.service.presetsView(actor, platformRequestContext(request));
  }

  @Put('presets/:preset')
  @RequirePlatformPermission('platform.team.manage')
  writePreset(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('preset') preset: string,
    @Body() body: { permissions?: unknown; reason?: unknown },
    @Req() request: object,
  ) {
    return this.service.writePreset(actor, preset, body ?? {}, platformRequestContext(request));
  }

  @Patch(':adminId')
  @RequirePlatformPermission('platform.team.manage')
  update(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('adminId') adminId: string,
    @Body() body: Record<string, unknown>,
    @Req() request: object,
  ) {
    return this.service.update(actor, adminId, body ?? {}, platformRequestContext(request));
  }

  @Delete(':adminId')
  @RequirePlatformPermission('platform.team.manage')
  remove(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('adminId') adminId: string,
    @Body() body: { reason?: unknown },
    @Req() request: object,
  ) {
    return this.service.remove(actor, adminId, body ?? {}, platformRequestContext(request));
  }
}
