import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { attachmentDisposition } from '../files/download-response.js';
import type { HeaderWriter } from '../files/download-response.js';
import type {
  MyPrivacyView,
  PrivacyDownload,
  PrivacyOverviewView,
  PrivacyService,
} from './privacy.service.js';
import { PRIVACY_STEP_UP } from './privacy-step-up.js';
import type { PrivacyRequestLike, PrivacyStepUp } from './privacy-step-up.js';

/** The DI token of the privacy service (esbuild emits no constructor types; every inject is named). */
export const PRIVACY_SERVICE = Symbol.for('tmanage.PrivacyService');

/** The archive's response: forced save, no sniffing, no caching, the scan status beside it. */
export function respondWithArchive(download: PrivacyDownload, reply: HeaderWriter): StreamableFile {
  reply.header('content-type', 'application/gzip');
  reply.header('content-length', String(download.sizeBytes));
  reply.header('content-disposition', attachmentDisposition(download.fileName));
  reply.header('x-content-type-options', 'nosniff');
  reply.header('cache-control', 'private, no-store');
  reply.header('x-scan-status', download.scanStatus);
  return new StreamableFile(download.stream as Readable, {
    type: 'application/gzip',
    length: download.sizeBytes,
  });
}

/**
 * D5 (Figma F5) — Control › Privacy, the company owner's page. `org.manage` is the coarse gate the
 * `CapabilityGuard` reads; the service refuses everyone but an owner (`requireOwner`). S13 / F28: every
 * write and the download refuse a bound token, and the export and deletion requests need step-up
 * (`privacy-step-up.ts`).
 */
@Controller('v1/organizations/:orgSlug/admin/privacy')
export class AdminPrivacyController {
  constructor(
    @Inject(PRIVACY_SERVICE) private readonly privacy: PrivacyService,
    @Inject(PRIVACY_STEP_UP) private readonly guard: PrivacyStepUp,
  ) {}

  @Get()
  @RequireCapability('org.manage')
  overview(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PrivacyOverviewView> {
    return this.privacy.overview(context, principal);
  }

  /** `{ kind: 'company' }` or `{ kind: 'member', membershipId }`. */
  @Post('exports')
  @RequireCapability('org.manage')
  requestExport(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: { readonly kind?: unknown; readonly membershipId?: unknown } | undefined,
    @Req() request: PrivacyRequestLike,
  ): Promise<PrivacyOverviewView> {
    this.guard.stepUp(request);
    return this.privacy.requestOwnerExport(context, principal, body);
  }

  @Get('exports/:exportId/download')
  @RequireCapability('org.manage')
  async download(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('exportId') exportId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
    @Req() request: PrivacyRequestLike,
  ): Promise<StreamableFile> {
    this.guard.person(request);
    const download = await this.privacy.download(context, principal, exportId, 'owner');
    return respondWithArchive(download, reply);
  }

  /** `{ confirmName }` — the company's name, typed. */
  @Post('deletion')
  @RequireCapability('org.manage')
  requestDeletion(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: { readonly confirmName?: unknown } | undefined,
    @Req() request: PrivacyRequestLike,
  ): Promise<PrivacyOverviewView> {
    this.guard.stepUp(request);
    return this.privacy.requestCompanyDeletion(context, principal, body);
  }

  @Post('deletion/cancel')
  @RequireCapability('org.manage')
  cancelDeletion(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Req() request: PrivacyRequestLike,
  ): Promise<PrivacyOverviewView> {
    this.guard.person(request);
    return this.privacy.cancelCompanyDeletion(context, principal);
  }
}

/** D5 (Figma F5 phone) — "My data": every internal member's own export and account deletion. */
@Controller('v1/organizations/:orgSlug/me/privacy')
export class MyPrivacyController {
  constructor(
    @Inject(PRIVACY_SERVICE) private readonly privacy: PrivacyService,
    @Inject(PRIVACY_STEP_UP) private readonly guard: PrivacyStepUp,
  ) {}

  @Get()
  @RequireCapability('work.read')
  mine(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MyPrivacyView> {
    return this.privacy.mine(context, principal);
  }

  @Post('exports')
  @RequireCapability('work.read')
  requestExport(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Req() request: PrivacyRequestLike,
  ): Promise<MyPrivacyView> {
    this.guard.stepUp(request);
    return this.privacy.requestMyExport(context, principal);
  }

  @Get('exports/:exportId/download')
  @RequireCapability('work.read')
  async download(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('exportId') exportId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
    @Req() request: PrivacyRequestLike,
  ): Promise<StreamableFile> {
    this.guard.person(request);
    const download = await this.privacy.download(context, principal, exportId, 'self');
    return respondWithArchive(download, reply);
  }

  @Post('deletion')
  @RequireCapability('work.read')
  requestDeletion(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Req() request: PrivacyRequestLike,
  ): Promise<MyPrivacyView> {
    this.guard.stepUp(request);
    return this.privacy.requestMyDeletion(context, principal);
  }

  @Post('deletion/cancel')
  @RequireCapability('work.read')
  cancelDeletion(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Req() request: PrivacyRequestLike,
  ): Promise<MyPrivacyView> {
    this.guard.person(request);
    return this.privacy.cancelMyDeletion(context, principal);
  }
}
