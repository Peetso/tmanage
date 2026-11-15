import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { FetchedCloudFile } from '../../common/storage/cloud-fetch.js';
import { isDriveId, isDrivePageToken } from '../google-drive/google-drive.google.js';
import { isGraphId, isGraphSkipToken } from '../onedrive/onedrive.graph.js';
import {
  SANDBOX_CSP,
  attachmentDisposition,
  type HeaderWriter,
} from '../files/download-response.js';
import type { CloudFolderPage } from './cloud-folder-drive.js';
import type {
  CloudFolderListInput,
  CloudFolderSource,
  CloudFolderView,
  CloudFoldersService,
} from './cloud-folders.service.js';

/**
 * FIX6 C3 — live drive folders on a work item, and the client's read of them in the portal.
 *
 * Members (`/work-items/:workItemId/cloud-folders`): list (`work.read`), attach a Drive folder
 * `{provider: 'google_drive', folderId}` or a OneDrive folder `{provider: 'onedrive', driveId,
 * itemId}` (`work.update`), remove (`work.update`), list a folder's children live, and open a
 * child. Clients (`/portal/work-items/:workItemId/cloud-folders`, `client_projection.read`): the
 * same reads, only on a client-visible work item.
 *
 * Every id from the browser is checked against the providers' id shapes before anything else; a
 * URL is never accepted. An opened child is sent as a download (`attachment`, octet-stream,
 * `nosniff`, sandboxed, not cached): its bytes come live from the drive and are not TManage's
 * checked copy, so the browser never renders them in TManage's origin.
 */
export const CLOUD_FOLDERS_SERVICE = Symbol.for('tmanage.CloudFoldersService');

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

/** A Drive or Graph item id: the union of the two providers' id shapes. */
function isProviderId(raw: unknown): raw is string {
  return isDriveId(raw) || isGraphId(raw);
}

export function folderSource(
  body: Readonly<Record<string, unknown>> | undefined,
): CloudFolderSource {
  if (body?.['provider'] === 'google_drive') {
    const folderId = body['folderId'];
    if (!isDriveId(folderId)) throw invalid('folderId', 'must be a Drive folder id');
    return { provider: 'google_drive', folderId };
  }
  if (body?.['provider'] === 'onedrive') {
    const driveId = body['driveId'];
    const itemId = body['itemId'];
    if (!isGraphId(driveId)) throw invalid('driveId', 'must be a OneDrive drive id');
    if (!isGraphId(itemId)) throw invalid('itemId', 'must be a OneDrive item id');
    return { provider: 'onedrive', driveId, itemId };
  }
  throw invalid('provider', 'must be google_drive or onedrive');
}

export function listInput(parentId: unknown, pageToken: unknown): CloudFolderListInput {
  if (parentId !== undefined && !isProviderId(parentId)) {
    throw invalid('parentId', 'must be a folder id');
  }
  if (pageToken !== undefined && !isDrivePageToken(pageToken) && !isGraphSkipToken(pageToken)) {
    throw invalid('pageToken', 'must be a page token');
  }
  return { parentId: parentId ?? null, pageToken: pageToken ?? null };
}

function childId(raw: unknown): string {
  if (!isProviderId(raw)) throw invalid('itemId', 'must be an item id');
  return raw;
}

/** The live bytes as a forced download; the drive's own type is not trusted. */
export function sendFolderFile(file: FetchedCloudFile, reply: HeaderWriter): StreamableFile {
  reply.header('content-type', 'application/octet-stream');
  reply.header('content-length', String(file.bytes.length));
  reply.header('content-disposition', attachmentDisposition(file.name));
  reply.header('x-content-type-options', 'nosniff');
  reply.header('content-security-policy', SANDBOX_CSP);
  reply.header('cache-control', 'private, no-store');
  return new StreamableFile(file.bytes, { type: 'application/octet-stream' });
}

@Controller('v1/organizations/:orgSlug/work-items/:workItemId/cloud-folders')
export class WorkItemCloudFoldersController {
  constructor(@Inject(CLOUD_FOLDERS_SERVICE) private readonly folders: CloudFoldersService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<{ readonly folders: readonly CloudFolderView[] }> {
    return { folders: await this.folders.list(context, principal, workItemId) };
  }

  @Post()
  @HttpCode(201)
  @RequireCapability('work.update')
  async attach(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: Readonly<Record<string, unknown>> | undefined,
  ): Promise<{ readonly folder: CloudFolderView }> {
    return {
      folder: await this.folders.attach(context, principal, workItemId, folderSource(body)),
    };
  }

  @Delete(':cloudFolderId')
  @HttpCode(204)
  @RequireCapability('work.update')
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('cloudFolderId') cloudFolderId: string,
  ): Promise<void> {
    await this.folders.remove(context, principal, workItemId, cloudFolderId);
  }

  @Get(':cloudFolderId/children')
  @RequireCapability('work.read')
  async children(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('cloudFolderId') cloudFolderId: string,
    @Query('parentId') parentId?: unknown,
    @Query('pageToken') pageToken?: unknown,
  ): Promise<CloudFolderPage> {
    return this.folders.children(
      context,
      principal,
      workItemId,
      cloudFolderId,
      listInput(parentId, pageToken),
    );
  }

  @Get(':cloudFolderId/items/:itemId/content')
  @RequireCapability('work.read')
  async open(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('cloudFolderId') cloudFolderId: string,
    @Param('itemId') itemId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const file = await this.folders.open(
      context,
      principal,
      workItemId,
      cloudFolderId,
      childId(itemId),
    );
    return sendFolderFile(file, reply);
  }
}

@Controller('v1/organizations/:orgSlug/portal/work-items/:workItemId/cloud-folders')
export class PortalCloudFoldersController {
  constructor(@Inject(CLOUD_FOLDERS_SERVICE) private readonly folders: CloudFoldersService) {}

  @Get()
  @RequireCapability('client_projection.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<{ readonly folders: readonly CloudFolderView[] }> {
    return { folders: await this.folders.portalList(context, principal, workItemId) };
  }

  @Get(':cloudFolderId/children')
  @RequireCapability('client_projection.read')
  async children(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('cloudFolderId') cloudFolderId: string,
    @Query('parentId') parentId?: unknown,
    @Query('pageToken') pageToken?: unknown,
  ): Promise<CloudFolderPage> {
    return this.folders.portalChildren(
      context,
      principal,
      workItemId,
      cloudFolderId,
      listInput(parentId, pageToken),
    );
  }

  @Get(':cloudFolderId/items/:itemId/content')
  @RequireCapability('client_projection.read')
  async open(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('cloudFolderId') cloudFolderId: string,
    @Param('itemId') itemId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const file = await this.folders.portalOpen(
      context,
      principal,
      workItemId,
      cloudFolderId,
      childId(itemId),
    );
    return sendFolderFile(file, reply);
  }
}
