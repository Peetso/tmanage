import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { isPackRole } from './template-packs.catalog.js';
import { TEMPLATE_PACKS_SERVICE } from './template-packs.service.js';
import type {
  TemplatePackInstallResult,
  TemplatePackView,
  TemplatePacksService,
} from './template-packs.service.js';

/**
 * 54-22. The template-packs gallery: `GET …/projects/templates/packs` lists the built-in packs with
 * this workspace's install state (`?role=` narrows it to one role's starter packs, 55-02); `POST …/projects/templates/packs/:packKey/install` installs one.
 * Gated on `project.manage`, the capability that manages templates. The tenant comes from the
 * context, never from the path or a body.
 */
@Controller('v1/organizations/:orgSlug/projects/templates/packs')
export class TemplatePacksController {
  constructor(@Inject(TEMPLATE_PACKS_SERVICE) private readonly packs: TemplatePacksService) {}

  @Get()
  @RequireCapability('project.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('role') role?: string,
  ): Promise<{ readonly packs: readonly TemplatePackView[] }> {
    if (role !== undefined && role !== '' && !isPackRole(role)) {
      throw new ApiError(400, 'validation_failed', 'Unknown role', undefined, 'template_pack_role');
    }
    return { packs: await this.packs.list(context, principal, role ? role : null) };
  }

  @Post(':packKey/install')
  @RequireCapability('project.manage')
  @HttpCode(201)
  async install(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('packKey') packKey: string,
  ): Promise<TemplatePackInstallResult> {
    return this.packs.install(context, principal, packKey);
  }
}
