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
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import type {
  PlatformOrganizationLifecycleService,
  TransferInput,
  TypedSlugInput,
} from './lifecycle.service.js';
import type { PlatformOrganizationSettingsService } from './org-settings.service.js';
import type {
  LimitsInput,
  ListQuery,
  PlanInput,
  PlatformOrganizationsService,
  ProfileInput,
} from './organizations.service.js';
import type { CreateOrganizationInput, PlatformOrganizationProvisioning } from './provisioning.js';

export const PLATFORM_ORGANIZATIONS_SERVICE = Symbol.for('tmanage.PlatformOrganizationsService');
export const PLATFORM_ORG_LIFECYCLE_SERVICE = Symbol.for(
  'tmanage.PlatformOrganizationLifecycleService',
);
export const PLATFORM_ORG_SETTINGS_SERVICE = Symbol.for(
  'tmanage.PlatformOrganizationSettingsService',
);
export const PLATFORM_ORG_PROVISIONING = Symbol.for('tmanage.PlatformOrganizationProvisioning');

interface ReasonInput {
  readonly reason?: unknown;
}

/**
 * `/v1/platform/{overview,search,organizations…}` — Platform admin · Organizations (SPEC §6,
 * PA-07). Reads need `platform.orgs.view`; profile, settings, plan, limits, storage and flags need
 * `platform.orgs.edit`; lifecycle acts need `platform.orgs.lifecycle` (purge: super admin only, in
 * the service). The 0206 `companies…` routes stay for the AI registry and older callers.
 *
 * Static paths (`organizations/deleted`) are declared before `organizations/:organizationId`.
 */
@Controller('v1/platform')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformOrganizationsController {
  constructor(
    @Inject(PLATFORM_ORGANIZATIONS_SERVICE) private readonly service: PlatformOrganizationsService,
    @Inject(PLATFORM_ORG_LIFECYCLE_SERVICE)
    private readonly lifecycle: PlatformOrganizationLifecycleService,
    @Inject(PLATFORM_ORG_SETTINGS_SERVICE)
    private readonly settings: PlatformOrganizationSettingsService,
    @Inject(PLATFORM_ORG_PROVISIONING)
    private readonly provisioning: PlatformOrganizationProvisioning,
  ) {}

  @Get('overview')
  @RequirePlatformPermission('platform.orgs.view')
  overview(@Req() request: object) {
    return this.service.overview(platformRequestContext(request));
  }

  @Get('search')
  @RequirePlatformPermission('platform.orgs.view')
  search(@Query('q') q: unknown, @Req() request: object) {
    return this.service.search(q, platformRequestContext(request));
  }

  // ── A2 list, create, A9 deleted ──────────────────────────────────────────

  @Get('organizations')
  @RequirePlatformPermission('platform.orgs.view')
  list(@Query() query: ListQuery, @Req() request: object) {
    return this.service.list(query ?? {}, platformRequestContext(request));
  }

  @Post('organizations')
  @RequirePlatformPermission('platform.orgs.edit')
  create(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: CreateOrganizationInput,
    @Req() request: object,
  ) {
    return this.provisioning.create(actor, body ?? {}, platformRequestContext(request));
  }

  @Get('organizations/deleted')
  @RequirePlatformPermission('platform.orgs.view')
  deleted(@Req() request: object) {
    return this.service.deleted(platformRequestContext(request));
  }

  // ── A3 detail ────────────────────────────────────────────────────────────

  @Get('organizations/:organizationId')
  @RequirePlatformPermission('platform.orgs.view')
  detail(@Param('organizationId') id: string, @Req() request: object) {
    return this.service.detail(id, platformRequestContext(request));
  }

  @Get('organizations/:organizationId/audit')
  @RequirePlatformPermission('platform.orgs.view')
  audit(@Param('organizationId') id: string, @Req() request: object) {
    return this.service.auditLog(id, platformRequestContext(request));
  }

  // ── A4 profile, logo, settings, policies, flags ──────────────────────────

  @Patch('organizations/:organizationId/profile')
  @RequirePlatformPermission('platform.orgs.edit')
  profile(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: ProfileInput,
    @Req() request: object,
  ) {
    return this.service.updateProfile(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Put('organizations/:organizationId/logo')
  @RequirePlatformPermission('platform.orgs.edit')
  putLogo(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body()
    body: {
      readonly mimeType?: unknown;
      readonly contentBase64?: unknown;
      readonly reason?: unknown;
    },
    @Req() request: object,
  ) {
    return this.settings.setLogo(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Delete('organizations/:organizationId/logo')
  @RequirePlatformPermission('platform.orgs.edit')
  deleteLogo(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Req() request: object,
  ) {
    return this.settings.setLogo(actor, id, null, platformRequestContext(request));
  }

  @Get('organizations/:organizationId/settings')
  @RequirePlatformPermission('platform.orgs.view')
  getSettings(@Param('organizationId') id: string, @Req() request: object) {
    return this.settings.view(id, platformRequestContext(request));
  }

  @Put('organizations/:organizationId/settings/:key')
  @RequirePlatformPermission('platform.orgs.edit')
  putSetting(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Param('key') key: string,
    @Body() body: { readonly value?: unknown; readonly reason?: unknown },
    @Req() request: object,
  ) {
    return this.settings.setSetting(actor, id, key, body ?? {}, platformRequestContext(request));
  }

  @Get('organizations/:organizationId/policies')
  @RequirePlatformPermission('platform.orgs.view')
  getPolicies(@Param('organizationId') id: string, @Req() request: object) {
    return this.settings.view(id, platformRequestContext(request));
  }

  @Put('organizations/:organizationId/policies')
  @RequirePlatformPermission('platform.orgs.edit')
  putPolicies(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: Record<string, unknown>,
    @Req() request: object,
  ) {
    return this.settings.setPolicy(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Get('organizations/:organizationId/flags')
  @RequirePlatformPermission('platform.orgs.view')
  getFlags(@Param('organizationId') id: string, @Req() request: object) {
    return this.settings.view(id, platformRequestContext(request));
  }

  @Put('organizations/:organizationId/flags/:flagKey')
  @RequirePlatformPermission('platform.orgs.edit')
  putFlag(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Param('flagKey') flagKey: string,
    @Body() body: { readonly enabled?: unknown; readonly reason?: unknown },
    @Req() request: object,
  ) {
    return this.settings.setFlag(actor, id, flagKey, body ?? {}, platformRequestContext(request));
  }

  // ── A5 plan, limits, storage ─────────────────────────────────────────────

  @Get('organizations/:organizationId/plan')
  @RequirePlatformPermission('platform.orgs.view')
  plan(@Param('organizationId') id: string, @Req() request: object) {
    return this.service.plan(id, platformRequestContext(request));
  }

  @Put('organizations/:organizationId/plan')
  @RequirePlatformPermission('platform.orgs.edit')
  setPlan(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: PlanInput,
    @Req() request: object,
  ) {
    return this.service.setPlan(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Put('organizations/:organizationId/limits')
  @RequirePlatformPermission('platform.orgs.edit')
  setLimits(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: LimitsInput,
    @Req() request: object,
  ) {
    return this.service.setLimits(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Get('organizations/:organizationId/storage')
  @RequirePlatformPermission('platform.orgs.view')
  storage(@Param('organizationId') id: string, @Req() request: object) {
    return this.service.storage(id, platformRequestContext(request));
  }

  @Post('organizations/:organizationId/storage/recount')
  @RequirePlatformPermission('platform.orgs.edit')
  @HttpCode(200)
  recount(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.service.recountStorage(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Delete('organizations/:organizationId/storage/connections/:connectionId')
  @RequirePlatformPermission('platform.orgs.edit')
  disconnect(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Param('connectionId') connectionId: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.service.disconnectStorage(
      actor,
      id,
      connectionId,
      body ?? {},
      platformRequestContext(request),
    );
  }

  // ── A7 lifecycle ─────────────────────────────────────────────────────────

  @Post('organizations/:organizationId/suspension')
  @RequirePlatformPermission('platform.orgs.lifecycle')
  @HttpCode(200)
  suspendOrg(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.lifecycle.suspend(actor, id, true, body ?? {}, platformRequestContext(request));
  }

  @Post('organizations/:organizationId/reactivation')
  @RequirePlatformPermission('platform.orgs.lifecycle')
  @HttpCode(200)
  reactivateOrg(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.lifecycle.suspend(actor, id, false, body ?? {}, platformRequestContext(request));
  }

  @Post('organizations/:organizationId/ownership-transfer')
  @RequirePlatformPermission('platform.orgs.lifecycle')
  @HttpCode(200)
  transfer(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: TransferInput,
    @Req() request: object,
  ) {
    return this.lifecycle.transfer(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Post('organizations/:organizationId/deletion')
  @RequirePlatformPermission('platform.orgs.lifecycle')
  @HttpCode(200)
  remove(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: TypedSlugInput,
    @Req() request: object,
  ) {
    return this.lifecycle.remove(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Post('organizations/:organizationId/restore')
  @RequirePlatformPermission('platform.orgs.lifecycle')
  @HttpCode(200)
  restore(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.lifecycle.restore(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Post('organizations/:organizationId/purge')
  @RequirePlatformPermission('platform.orgs.lifecycle')
  @HttpCode(200)
  purge(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: TypedSlugInput,
    @Req() request: object,
  ) {
    return this.lifecycle.purge(actor, id, body ?? {}, platformRequestContext(request));
  }

  @Post('organizations/:organizationId/archive')
  @RequirePlatformPermission('platform.orgs.lifecycle')
  @HttpCode(200)
  archive(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.lifecycle.archive(actor, id, true, body ?? {}, platformRequestContext(request));
  }

  @Post('organizations/:organizationId/unarchive')
  @RequirePlatformPermission('platform.orgs.lifecycle')
  @HttpCode(200)
  unarchive(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.lifecycle.archive(actor, id, false, body ?? {}, platformRequestContext(request));
  }

  @Post('organizations/:organizationId/policy-refresh')
  @RequirePlatformPermission('platform.orgs.lifecycle')
  @HttpCode(200)
  policyRefresh(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.lifecycle.policyRefresh(actor, id, body ?? {}, platformRequestContext(request));
  }

  // ── 0206 routes, kept ────────────────────────────────────────────────────

  @Get('companies')
  @RequirePlatformPermission('platform.orgs.view')
  companies(@Query('q') search: unknown, @Req() request: object) {
    return this.service.companies(search, platformRequestContext(request));
  }

  @Get('companies/:organizationId')
  @RequirePlatformPermission('platform.orgs.view')
  company(@Param('organizationId') id: string, @Req() request: object) {
    return this.service.company(id, platformRequestContext(request));
  }

  @Post('companies/:organizationId/suspension')
  @RequirePlatformPermission('platform.orgs.lifecycle')
  @HttpCode(200)
  suspend(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.service.setSuspended(actor, id, true, body ?? {}, platformRequestContext(request));
  }

  @Post('companies/:organizationId/reactivation')
  @RequirePlatformPermission('platform.orgs.lifecycle')
  @HttpCode(200)
  reactivate(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('organizationId') id: string,
    @Body() body: ReasonInput,
    @Req() request: object,
  ) {
    return this.service.setSuspended(actor, id, false, body ?? {}, platformRequestContext(request));
  }
}
