import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Put,
  Query,
  Redirect,
  Req,
  Res,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { hasCapability, isUuid } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import {
  Ctx,
  CurrentPrincipal,
  NoTenant,
  Public,
  RequireCapability,
} from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { API_CONFIG, AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  parseConnectReturnTo,
  storageReturnScreen,
} from '../platform-admin/connect-setup/connect-return.js';
import { providerErrorReason } from '../platform-admin/connect-setup/connect-setup.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import { expireCookie, readCookie, serializeCookie } from '../identity/session-token.js';
import {
  ONEDRIVE_COOKIE_PATH,
  ONEDRIVE_FLOW_COOKIE,
  ONEDRIVE_FLOW_TTL_SECONDS,
  createOneDriveTransport,
  isGraphId,
  isGraphSkipToken,
  oneDriveConfigFrom,
  openOneDriveFlow,
  sealOneDriveFlow,
  type OneDriveTransport,
} from './onedrive.graph.js';
import {
  OneDriveService,
  type OneDriveAttachmentView,
  type OneDriveFolderBrowseView,
  type OneDrivePickerSessionView,
  type OneDriveProjectFilesView,
  type OneDriveSettingsInput,
  type OneDriveStatusView,
} from './onedrive.service.js';

/**
 * OneDrive as company storage — the HTTP surface (0236), the twin of the Google Drive routes.
 *
 * - `GET    …/integrations/onedrive` — the Storage screen's OneDrive state.
 * - `POST   …/integrations/onedrive/connect` — `{url}` for Microsoft's consent screen
 *   (`{libraries: true}` asks for SharePoint libraries too); sets the signed flow cookie.
 * - `GET    /v1/integrations/onedrive/callback` — Microsoft's redirect; forwards `code` and
 *   `state` in the URL fragment to the Storage screen (or Connected apps, R38, when the connect
 *   started there), which completes under its own session; a provider error we explain travels
 *   on as `reason` (R37).
 * - `POST   …/integrations/onedrive/complete` — `{code, state}`: exchange, encrypt, save.
 * - `PUT    …/integrations/onedrive/settings` — storage mode and the root location.
 * - `DELETE …/integrations/onedrive` — disconnect (wipe the token).
 * - `GET    …/integrations/onedrive/folders` — R36 F2: sub-folders for **Change folder** (org.manage).
 * - `GET    …/integrations/onedrive/picker-session` — File Picker v8 token (org-wide callers) or
 *   `scoped` (project-scoped callers, NV10).
 * - `GET    …/integrations/onedrive/projects/:projectId/files` — the server-side project list.
 * - `…/work-items/:workItemId/onedrive/attachments` — attach, list, detach. (Task files are
 *   uploaded to TManage storage with its checks, never straight into the drive: FIX6.)
 */

const ONEDRIVE_SERVICE = Symbol.for('tmanage.OneDriveService');
const ONEDRIVE_OPTIONS = Symbol.for('tmanage.OneDriveOptions');

interface OneDriveHttpOptions {
  readonly sessionSecret: string;
  readonly secureCookies: boolean;
  readonly webPublicUrl: string;
}

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
}

interface ReplyLike {
  header(name: string, value: string | readonly string[]): unknown;
}

function cookieHeader(request: RequestLike): string | undefined {
  const raw = request.headers['cookie'];
  return Array.isArray(raw) ? raw.join('; ') : raw;
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

@Controller('v1/organizations/:orgSlug/integrations/onedrive')
export class OneDriveStorageController {
  constructor(
    @Inject(ONEDRIVE_SERVICE) private readonly onedrive: OneDriveService,
    @Inject(ONEDRIVE_OPTIONS) private readonly options: OneDriveHttpOptions,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async status(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OneDriveStatusView> {
    return this.onedrive.status(context, hasCapability(principal.role, 'org.manage'));
  }

  @Post('connect')
  @RequireCapability('org.manage')
  @HttpCode(200)
  connect(
    @Ctx() context: TenantContext,
    @Param('orgSlug') orgSlug: string,
    @Body() body: { readonly libraries?: unknown; readonly returnTo?: unknown } | undefined,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): { readonly url: string } {
    if (!SLUG_PATTERN.test(orgSlug)) throw invalid('orgSlug', 'is not a workspace address');
    if (body?.libraries !== undefined && typeof body.libraries !== 'boolean') {
      throw invalid('libraries', 'must be true or false');
    }
    const returnTo = parseConnectReturnTo(body?.returnTo);
    if (returnTo === 'invalid') throw invalid('returnTo', 'must be connected-apps');
    const { url, flow } = this.onedrive.startConnect(context, orgSlug, {
      libraries: body?.libraries === true,
    });
    const sealed = sealOneDriveFlow(
      returnTo ? { ...flow, returnTo } : flow,
      this.options.sessionSecret,
    );
    reply.header(
      'set-cookie',
      serializeCookie(ONEDRIVE_FLOW_COOKIE, sealed, {
        path: ONEDRIVE_COOKIE_PATH,
        maxAgeSeconds: ONEDRIVE_FLOW_TTL_SECONDS,
        // `Lax`: the cookie must survive the top-level return from Microsoft.
        sameSite: 'Lax',
        secure: this.options.secureCookies,
      }),
    );
    return { url };
  }

  @Post('complete')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async complete(
    @Ctx() context: TenantContext,
    @Body() body: { readonly code?: unknown; readonly state?: unknown },
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<OneDriveStatusView> {
    const flow = openOneDriveFlow(
      readCookie(cookieHeader(request), ONEDRIVE_FLOW_COOKIE),
      this.options.sessionSecret,
    );
    // The flow is single-use whatever happens next.
    reply.header(
      'set-cookie',
      expireCookie(ONEDRIVE_FLOW_COOKIE, {
        path: ONEDRIVE_COOKIE_PATH,
        sameSite: 'Lax',
        secure: this.options.secureCookies,
      }),
    );
    return this.onedrive.completeConnect(context, flow, { code: body?.code, state: body?.state });
  }

  @Put('settings')
  @RequireCapability('org.manage')
  async settings(
    @Ctx() context: TenantContext,
    @Body() body: { readonly storageMode?: unknown; readonly location?: unknown },
  ): Promise<OneDriveStatusView> {
    return this.onedrive.updateSettings(context, parseOneDriveSettings(body));
  }

  @Delete()
  @RequireCapability('org.manage')
  async disconnect(@Ctx() context: TenantContext): Promise<OneDriveStatusView> {
    return this.onedrive.disconnect(context);
  }

  /** R36 F2. Change folder browses the connected drive here, with no second Microsoft consent. */
  @Get('folders')
  @RequireCapability('org.manage')
  async folders(
    @Ctx() context: TenantContext,
    @Query('folderId') folderId?: unknown,
    @Query('pageToken') pageToken?: unknown,
  ): Promise<OneDriveFolderBrowseView> {
    if (folderId !== undefined && !isGraphId(folderId)) {
      throw invalid('folderId', 'must be a OneDrive folder id');
    }
    if (pageToken !== undefined && !isGraphSkipToken(pageToken)) {
      throw invalid('pageToken', 'must be a OneDrive page token');
    }
    return this.onedrive.browseFolders(context, {
      ...(folderId === undefined ? {} : { folderId }),
      ...(pageToken === undefined ? {} : { pageToken }),
    });
  }

  @Get('picker-session')
  @RequireCapability('work.update')
  async picker(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId?: unknown,
    @Query('resource') resource?: unknown,
  ): Promise<OneDrivePickerSessionView> {
    if (projectId !== undefined && (typeof projectId !== 'string' || !isUuid(projectId))) {
      throw invalid('projectId', 'must be a project id');
    }
    if (resource !== undefined && (typeof resource !== 'string' || resource.length > 200)) {
      throw invalid('resource', 'must be a OneDrive address');
    }
    return this.onedrive.pickerSession(context, principal, projectId, resource);
  }

  @Get('projects/:projectId/files')
  @RequireCapability('work.update')
  async projectFiles(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('folderId') folderId?: unknown,
    @Query('pageToken') pageToken?: unknown,
  ): Promise<OneDriveProjectFilesView> {
    if (typeof projectId !== 'string' || !isUuid(projectId)) {
      throw invalid('projectId', 'must be a project id');
    }
    if (folderId !== undefined && !isGraphId(folderId)) {
      throw invalid('folderId', 'must be a OneDrive folder id');
    }
    if (pageToken !== undefined && !isGraphSkipToken(pageToken)) {
      throw invalid('pageToken', 'must be a OneDrive page token');
    }
    return this.onedrive.projectFiles(context, principal, projectId, {
      ...(folderId === undefined ? {} : { folderId }),
      ...(pageToken === undefined ? {} : { pageToken }),
    });
  }
}

@Controller('v1/organizations/:orgSlug/work-items/:workItemId/onedrive')
export class OneDriveAttachmentsController {
  constructor(@Inject(ONEDRIVE_SERVICE) private readonly onedrive: OneDriveService) {}

  @Get('attachments')
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<{ readonly attachments: readonly OneDriveAttachmentView[] }> {
    return { attachments: await this.onedrive.list(context, principal, workItemId) };
  }

  @Post('attachments')
  @RequireCapability('work.update')
  @HttpCode(201)
  async attach(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: { readonly driveId?: unknown; readonly itemId?: unknown },
  ): Promise<OneDriveAttachmentView> {
    if (!isGraphId(body?.driveId)) throw invalid('driveId', 'must be a OneDrive drive id');
    if (!isGraphId(body.itemId)) throw invalid('itemId', 'must be a OneDrive item id');
    return this.onedrive.attach(context, principal, workItemId, {
      driveId: body.driveId,
      itemId: body.itemId,
    });
  }

  @Delete('attachments/:attachmentId')
  @RequireCapability('work.update')
  @HttpCode(204)
  async detach(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('attachmentId') attachmentId: string,
  ): Promise<void> {
    await this.onedrive.detach(context, principal, workItemId, attachmentId);
  }
}

/**
 * Microsoft's redirect after consent. Public and tenant-less because Microsoft, not the app, makes
 * this request; it only forwards. The organization comes from the signed flow cookie.
 */
@Controller('v1/integrations/onedrive')
export class OneDriveCallbackController {
  constructor(@Inject(ONEDRIVE_OPTIONS) private readonly options: OneDriveHttpOptions) {}

  @Get('callback')
  @Public()
  @NoTenant()
  @Redirect()
  callback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Req() request: RequestLike,
    @Query('error') error?: unknown,
  ): { readonly url: string; readonly statusCode: number } {
    return {
      url: oneDriveCallbackTarget(this.options, cookieHeader(request), code, state, error),
      statusCode: 302,
    };
  }
}

/** Where the callback sends the browser. Pure, so the forwarding rule is provable. */
export function oneDriveCallbackTarget(
  options: Pick<OneDriveHttpOptions, 'sessionSecret' | 'webPublicUrl'>,
  cookies: string | undefined,
  code: unknown,
  state: unknown,
  error?: unknown,
): string {
  const base = options.webPublicUrl.replace(/\/+$/, '');
  const flow = openOneDriveFlow(readCookie(cookies, ONEDRIVE_FLOW_COOKIE), options.sessionSecret);
  if (!flow || !SLUG_PATTERN.test(flow.organizationSlug)) return `${base}/`;
  const screen = storageReturnScreen(base, flow.organizationSlug, flow.returnTo);
  if (typeof code !== 'string' || typeof state !== 'string' || code.length > 4096) {
    // R37 parity: a provider error we explain travels on as `reason`, so the card can say why.
    const reason = providerErrorReason(error);
    return reason ? `${screen}#onedrive=error&reason=${reason}` : `${screen}#onedrive=error`;
  }
  const fragment = new URLSearchParams({ onedrive: 'complete', code, state });
  return `${screen}#${fragment.toString()}`;
}

export function parseOneDriveSettings(body: {
  readonly storageMode?: unknown;
  readonly location?: unknown;
}): OneDriveSettingsInput {
  const out: {
    storageMode?: NonNullable<OneDriveSettingsInput['storageMode']>;
    location?: NonNullable<OneDriveSettingsInput['location']>;
  } = {};
  if (body?.storageMode !== undefined) {
    if (body.storageMode !== 'tmanage' && body.storageMode !== 'onedrive') {
      throw invalid('storageMode', 'must be tmanage or onedrive');
    }
    out.storageMode = body.storageMode;
  }
  if (body?.location !== undefined) {
    const location = body.location as { kind?: unknown; driveId?: unknown; itemId?: unknown };
    if (location?.kind === 'my_files') out.location = { kind: 'my_files' };
    else if (
      location?.kind === 'folder' &&
      isGraphId(location.driveId) &&
      isGraphId(location.itemId)
    ) {
      out.location = { kind: 'folder', driveId: location.driveId, itemId: location.itemId };
    } else if (location?.kind === 'library' && isGraphId(location.driveId)) {
      out.location = { kind: 'library', driveId: location.driveId };
    } else throw invalid('location', 'must be my_files, a picked folder or a library');
  }
  if (out.storageMode === undefined && out.location === undefined) {
    throw invalid('storageMode', 'nothing to change');
  }
  return out;
}

/**
 * Always registered: without MICROSOFT_CLIENT_ID/SECRET the routes still answer, so the Storage
 * screen can say "not configured" instead of failing.
 */
@Module({})
export class OneDriveModule {
  static register(transport: OneDriveTransport = createOneDriveTransport()): DynamicModule {
    const options: Provider = {
      provide: ONEDRIVE_OPTIONS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): OneDriveHttpOptions => ({
        sessionSecret: config.sessionSecret,
        secureCookies: config.secureCookies,
        webPublicUrl: config.webPublicUrl ?? '',
      }),
    };
    const service: Provider = {
      provide: ONEDRIVE_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, API_CONFIG],
      useFactory: (database: TenantDatabase, audit: AuditService, config: ApiConfig) =>
        new OneDriveService({
          database,
          audit,
          transport,
          cipher: createSeedCipher(config.mfaSeedKeys),
          config: oneDriveConfigFrom(process.env),
          apiPublicUrl: config.apiPublicUrl ?? config.webPublicUrl ?? '',
        }),
    };
    return {
      module: OneDriveModule,
      providers: [options, service],
      controllers: [
        OneDriveStorageController,
        OneDriveAttachmentsController,
        OneDriveCallbackController,
      ],
    };
  }
}
