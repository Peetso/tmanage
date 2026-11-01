import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { FILE_REVIEW_DECISIONS_SERVICE } from './file-review-decisions.service.js';
import type {
  FileReviewDecisionsService,
  FileReviewDecisionsView,
} from './file-review-decisions.service.js';

/**
 * R4 slice 11 — Approve / Request changes on a plain file's versions, and each version's review
 * state (the viewer's decision card and Versions tab). The capability gates are coarse —
 * `file.download` to read, `approval.decide` to decide — and the service adds the download door's
 * decision on the file, the chain rule, the deliverable refusal (409 `use_deliverable_approval`)
 * and the note rule.
 */
@Controller('v1/organizations/:orgSlug/files/:fileId/review/decisions')
export class FileReviewDecisionsController {
  constructor(
    @Inject(FILE_REVIEW_DECISIONS_SERVICE) private readonly decisions: FileReviewDecisionsService,
  ) {}

  @Get()
  @RequireCapability('file.download')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
  ): Promise<FileReviewDecisionsView> {
    return this.decisions.list(context, principal, 'internal', fileId);
  }

  @Post()
  @HttpCode(201)
  @RequireCapability('approval.decide')
  async record(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
    @Body() body: Record<string, unknown> | undefined,
  ): Promise<FileReviewDecisionsView> {
    return this.decisions.record(context, principal, 'internal', fileId, {
      fileAssetId: body?.['fileAssetId'],
      decision: body?.['decision'],
      note: body?.['note'],
    });
  }
}

/**
 * The client's twin under `/portal`: the same service through the `client` door. A client sees
 * only client decisions and client-visible comments, and decides only where its role's ceiling
 * holds `approval.decide`.
 */
@Controller('v1/organizations/:orgSlug/portal/files/:fileId/review/decisions')
export class PortalFileReviewDecisionsController {
  constructor(
    @Inject(FILE_REVIEW_DECISIONS_SERVICE) private readonly decisions: FileReviewDecisionsService,
  ) {}

  @Get()
  @RequireCapability('file.download')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
  ): Promise<FileReviewDecisionsView> {
    return this.decisions.list(context, principal, 'client', fileId);
  }

  @Post()
  @HttpCode(201)
  @RequireCapability('approval.decide')
  async record(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
    @Body() body: Record<string, unknown> | undefined,
  ): Promise<FileReviewDecisionsView> {
    return this.decisions.record(context, principal, 'client', fileId, {
      fileAssetId: body?.['fileAssetId'],
      decision: body?.['decision'],
      note: body?.['note'],
    });
  }
}
