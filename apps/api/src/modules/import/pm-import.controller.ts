import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { isPmSource } from './pm-sources.js';
import type { PmBoard, PmSource } from './pm-sources.js';
import { PM_IMPORT_SERVICE } from './pm-import.service.js';
import type {
  PmDiscoverView,
  PmImportService,
  PmJobView,
  PmPreviewView,
} from './pm-import.service.js';

type Body = Readonly<Record<string, unknown>> | undefined;

function source(value: string): PmSource {
  if (!isPmSource(value)) {
    throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'pm_source_unknown');
  }
  return value;
}

/**
 * R45 L3 (54-25) — Trello / Asana import with the owner's own token. `org.manage` on every route
 * (import sits under Admin), re-checked in the service. `:source` is `trello` or `asana`.
 *
 * - `POST   …/imports/pm/:source/connect`    — check the token, keep it in the vault; the boards.
 * - `DELETE …/imports/pm/:source/connection` — forget the token now.
 * - `POST   …/imports/pm/:source/discover`   — lists / sections, people, suggested mapping.
 * - `POST   …/imports/pm/:source/preview`    — counts, including cards already imported.
 * - `POST   …/imports/pm/:source/jobs`       — start the background import (202).
 * - `GET    …/imports/pm/:source/jobs/:jobId` — the job's state.
 *
 * The token routes carry a credential and steer egress: never AI tools (`never.ts`).
 */
@Controller('v1/organizations/:orgSlug/imports/pm')
export class PmImportController {
  constructor(@Inject(PM_IMPORT_SERVICE) private readonly imports: PmImportService) {}

  @Post(':source/connect')
  @RequireCapability('org.manage')
  @HttpCode(200)
  connect(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('source') raw: string,
    @Body() body: Body,
  ): Promise<{ readonly boards: readonly PmBoard[] }> {
    return this.imports.connect(context, principal, source(raw), body);
  }

  @Delete(':source/connection')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async disconnect(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('source') raw: string,
  ): Promise<void> {
    await this.imports.disconnect(context, principal, source(raw));
  }

  @Post(':source/discover')
  @RequireCapability('org.manage')
  @HttpCode(200)
  discover(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('source') raw: string,
    @Body() body: Body,
  ): Promise<PmDiscoverView> {
    return this.imports.discover(context, principal, source(raw), body);
  }

  @Post(':source/preview')
  @RequireCapability('org.manage')
  @HttpCode(200)
  preview(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('source') raw: string,
    @Body() body: Body,
  ): Promise<PmPreviewView> {
    return this.imports.preview(context, principal, source(raw), body);
  }

  @Post(':source/jobs')
  @RequireCapability('org.manage')
  @HttpCode(202)
  start(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('source') raw: string,
    @Body() body: Body,
  ): Promise<PmJobView> {
    return this.imports.start(context, principal, source(raw), body);
  }

  @Get(':source/jobs/:jobId')
  @RequireCapability('org.manage')
  job(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('source') raw: string,
    @Param('jobId') jobId: string,
  ): Promise<PmJobView> {
    return this.imports.job(context, principal, source(raw), jobId);
  }
}
