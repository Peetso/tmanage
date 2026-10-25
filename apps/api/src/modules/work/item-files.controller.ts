import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { WORK_ITEM_FILES_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ItemFileView, WorkItemFilesService } from './item-files.service.js';

/**
 * x205's HTTP surface — a work item's file attachments (Work module 7).
 *
 * A sub-resource of the work item, the way `:workItemId/comments` and `:workItemId/dependencies`
 * are: the parent id is in the path, and the service resolves it — and, for attach, the file id
 * in the body — tenant-scoped before it authorizes or writes. This controller reads no
 * `organizationId` from anywhere: `TenantContextGuard` built the `TenantContext` from a
 * membership row, and there is no field below for a caller to supply one.
 *
 * The capability gate is coarse (`work.read` to list, `work.update` to attach or detach);
 * the row-level decision — may this principal act on *this* item, and does *this* file belong to
 * the same tenant and project — is the service's, against the resolved ends.
 */
interface AttachFileBody {
  readonly fileAssetId?: unknown;
}

@Controller('v1/organizations/:orgSlug/work-items/:workItemId/files')
export class WorkItemFilesController {
  constructor(@Inject(WORK_ITEM_FILES_SERVICE) private readonly files: WorkItemFilesService) {}

  // F25: an internal work surface. `work.read` is internal-only, so CapabilityGuard refuses every
  // client principal here (403), as on every other work route.
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<{ readonly files: readonly ItemFileView[] }> {
    return { files: await this.files.list(context, principal, workItemId) };
  }

  @Post()
  @RequireCapability('work.update')
  @HttpCode(201)
  async attach(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: AttachFileBody,
  ): Promise<ItemFileView> {
    const fileAssetId = requiredId(body?.fileAssetId);
    return this.files.attach(context, principal, workItemId, { fileAssetId });
  }

  @Delete(':linkId')
  @RequireCapability('work.update')
  @HttpCode(204)
  async detach(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('linkId') linkId: string,
  ): Promise<void> {
    await this.files.detach(context, principal, workItemId, linkId);
  }
}

function requiredId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'fileAssetId', message: 'must be a non-empty string' },
    ]);
  }
  return raw.trim();
}
