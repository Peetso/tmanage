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
import type { CompanyRootOptionsView } from '../storage-root/root-owner.js';
import {
  parseConnectReturnTo,
  storageReturnScreen,
} from '../platform-admin/connect-setup/connect-return.js';
import { providerErrorReason } from '../platform-admin/connect-setup/connect-setup.js';
import { tokenVaultFromEnv } from '../connectors/token-vault.js';
import { expireCookie, readCookie, serializeCookie } from '../identity/session-token.js';
import {
  DRIVE_COOKIE_PATH,
  DRIVE_FLOW_COOKIE,
  DRIVE_FLOW_TTL_SECONDS,
  createDriveTransport,
  driveConfigFrom,
  isDriveId,
  isDrivePageToken,
  openDriveFlow,
  sealDriveFlow,
  type DriveTransport,
} from './google-drive.google.js';
import {
  GoogleDriveService,
  type DriveAttachmentView,
  type PickerSessionView,
  type ProjectFilesView,
  type SettingsInput,
  type StorageStatusView,
} from './google-drive.service.js';

/**
 * Google Drive as company storage — the HTTP surface.
 *
 * - `GET    …/integrations/google-drive` — the Storage screen's state (any internal member; the
 *   account email only for people who manage the organization).
 * - `POST   …/integrations/google-drive/connect` — `{url}` for Google's consent screen; sets the
 *   signed flow cookie (state + PKCE verifier) bound to this person and organization.
 * - `GET    /v1/integrations/google-drive/callback` — Google's redirect. It processes nothing: it
 *   forwards `code` and `state` in the URL *fragment* (never sent to a server or a Referer) to the
 *   Storage screen, which completes the connection under the person's own session.
 * - `POST   …/integrations/google-drive/complete` — `{code, state}`: exchange, encrypt, save.
 * - `PUT    …/integrations/google-drive/settings` — storage mode and the Drive location.
 * - `DELETE …/integrations/google-drive` — disconnect (revoke, wipe the token).
 * - `GET    …/integrations/google-drive/picker-session` — how to choose files: the picker token
 *   for an org-wide caller, or `scoped` (no token) for a project-scoped one (NV10).
 * - `GET    …/integrations/google-drive/projects/:projectId/files` — the server-side list of one
 *   of the project's own TManage folders, for a project-scoped caller (NV10).
 * - `…/work-items/:workItemId/google-drive/attachments` — attach, list, detach. (Task files are
 *   uploaded to TManage storage with its checks, never straight into the drive: FIX6.)
 *
 * Managing the connection is `org.manage`. Attaching is `work.update` on the work item (checked
 * against the item's project in the service); listing is `work.read`.
 */

const GOOGLE_DRIVE_SERVICE = Symbol.for('tmanage.GoogleDriveService');
const GOOGLE_DRIVE_OPTIONS = Symbol.for('tmanage.GoogleDriveOptions');

interface DriveHttpOptions {
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

@Controller('v1/organizations/:orgSlug/integrations/google-drive')
export class GoogleDriveStorageController {
  constructor(
    @Inject(GOOGLE_DRIVE_SERVICE) private readonly drive: GoogleDriveService,
    @Inject(GOOGLE_DRIVE_OPTIONS) private readonly options: DriveHttpOptions,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async status(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StorageStatusView> {
    return this.drive.status(context, hasCapability(principal.role, 'org.manage'));
  }

  @Post('connect')
  @RequireCapability('org.manage')
  @HttpCode(200)
  connect(
    @Ctx() context: TenantContext,
    @Param('orgSlug') orgSlug: string,
    @Res({ passthrough: true }) reply: ReplyLike,
    @Body() body?: { readonly returnTo?: unknown },
  ): { readonly url: string } {
    if (!SLUG_PATTERN.test(orgSlug)) throw invalid('orgSlug', 'is not a workspace address');
    const returnTo = parseConnectReturnTo(body?.returnTo);
    if (returnTo === 'invalid') throw invalid('returnTo', 'must be connected-apps');
    const { url, flow } = this.drive.startConnect(context, orgSlug);
    const sealed = sealDriveFlow(
      returnTo ? { ...flow, returnTo } : flow,
      this.options.sessionSecret,
    );
    reply.header(
      'set-cookie',
      serializeCookie(DRIVE_FLOW_COOKIE, sealed, {
        path: DRIVE_COOKIE_PATH,
        maxAgeSeconds: DRIVE_FLOW_TTL_SECONDS,
        // `Lax`: the cookie must survive the top-level return from Google.
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
  ): Promise<StorageStatusView> {
    const flow = openDriveFlow(
      readCookie(cookieHeader(request), DRIVE_FLOW_COOKIE),
      this.options.sessionSecret,
    );
    // The flow is single-use whatever happens next.
    reply.header(
      'set-cookie',
      expireCookie(DRIVE_FLOW_COOKIE, {
        path: DRIVE_COOKIE_PATH,
        sameSite: 'Lax',
        secure: this.options.secureCookies,
      }),
    );
    return this.drive.completeConnect(context, flow, { code: body?.code, state: body?.state });
  }

  @Put('settings')
  @RequireCapability('org.manage')
  async settings(
    @Ctx() context: TenantContext,
    @Body() body: { readonly storageMode?: unknown; readonly location?: unknown },
  ): Promise<StorageStatusView> {
    return this.drive.updateSettings(context, parseSettings(body));
  }

  /** 51-17 slice 2. The Shared Drives the connected account can hold the company's root. */
  @Get('root-options')
  @RequireCapability('org.manage')
  async rootOptions(@Ctx() context: TenantContext): Promise<CompanyRootOptionsView> {
    return this.drive.companyRootOptions(context);
  }

  @Delete()
  @RequireCapability('org.manage')
  async disconnect(@Ctx() context: TenantContext): Promise<StorageStatusView> {
    return this.drive.disconnect(context);
  }

  @Get('picker-session')
  @RequireCapability('work.update')
  async picker(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId?: string,
  ): Promise<PickerSessionView> {
    // NV10. The target project the picked or uploaded files are for; the service checks the
    // caller's relation to it before a token is minted.
    if (projectId !== undefined && (typeof projectId !== 'string' || !isUuid(projectId))) {
      throw invalid('projectId', 'must be a project id');
    }
    return this.drive.pickerSession(context, principal, projectId);
  }

  @Get('projects/:projectId/files')
  @RequireCapability('work.update')
  async projectFiles(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('folderId') folderId?: unknown,
    @Query('pageToken') pageToken?: unknown,
  ): Promise<ProjectFilesView> {
    if (typeof projectId !== 'string' || !isUuid(projectId)) {
      throw invalid('projectId', 'must be a project id');
    }
    // NV10. Only plain Drive ids and Google's own page tokens reach the Drive query.
    if (folderId !== undefined && !isDriveId(folderId)) {
      throw invalid('folderId', 'must be a Drive folder id');
    }
    if (pageToken !== undefined && !isDrivePageToken(pageToken)) {
      throw invalid('pageToken', 'must be a Drive page token');
    }
    return this.drive.projectFiles(context, principal, projectId, {
      ...(folderId === undefined ? {} : { folderId }),
      ...(pageToken === undefined ? {} : { pageToken }),
    });
  }
}

@Controller('v1/organizations/:orgSlug/work-items/:workItemId/google-drive')
export class GoogleDriveAttachmentsController {
  constructor(@Inject(GOOGLE_DRIVE_SERVICE) private readonly drive: GoogleDriveService) {}

  @Get('attachments')
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<{ readonly attachments: readonly DriveAttachmentView[] }> {
    return { attachments: await this.drive.list(context, principal, workItemId) };
  }

  @Post('attachments')
  @RequireCapability('work.update')
  @HttpCode(201)
  async attach(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: { readonly driveFileId?: unknown },
  ): Promise<DriveAttachmentView> {
    if (!isDriveId(body?.driveFileId)) throw invalid('driveFileId', 'must be a Drive file id');
    return this.drive.attach(context, principal, workItemId, body.driveFileId);
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
    await this.drive.detach(context, principal, workItemId, attachmentId);
  }
}

/**
 * Google's redirect after consent. Public and tenant-less because Google, not the app, makes this
 * request; it therefore does nothing but forward. The organization comes from the signed flow
 * cookie, never from the query string, and the code travels on in the fragment.
 */
@Controller('v1/integrations/google-drive')
export class GoogleDriveCallbackController {
  constructor(@Inject(GOOGLE_DRIVE_OPTIONS) private readonly options: DriveHttpOptions) {}

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
      url: callbackTarget(this.options, cookieHeader(request), code, state, error),
      statusCode: 302,
    };
  }
}

/** Where the callback sends the browser. Pure, so the forwarding rule is provable. */
export function callbackTarget(
  options: Pick<DriveHttpOptions, 'sessionSecret' | 'webPublicUrl'>,
  cookies: string | undefined,
  code: unknown,
  state: unknown,
  error?: unknown,
): string {
  const base = options.webPublicUrl.replace(/\/+$/, '');
  const flow = openDriveFlow(readCookie(cookies, DRIVE_FLOW_COOKIE), options.sessionSecret);
  if (!flow || !SLUG_PATTERN.test(flow.organizationSlug)) return `${base}/`;
  const screen = storageReturnScreen(base, flow.organizationSlug, flow.returnTo);
  if (typeof code !== 'string' || typeof state !== 'string' || code.length > 2048) {
    // R37 parity: a provider error we explain travels on as `reason`, so the card can say why.
    const reason = providerErrorReason(error);
    return reason ? `${screen}#drive=error&reason=${reason}` : `${screen}#drive=error`;
  }
  const fragment = new URLSearchParams({ drive: 'complete', code, state });
  return `${screen}#${fragment.toString()}`;
}

export function parseSettings(body: {
  readonly storageMode?: unknown;
  readonly location?: unknown;
}): SettingsInput {
  const out: {
    storageMode?: NonNullable<SettingsInput['storageMode']>;
    location?: NonNullable<SettingsInput['location']>;
  } = {};
  if (body?.storageMode !== undefined) {
    if (body.storageMode !== 'tmanage' && body.storageMode !== 'google_drive') {
      throw invalid('storageMode', 'must be tmanage or google_drive');
    }
    out.storageMode = body.storageMode;
  }
  if (body?.location !== undefined) {
    const location = body.location as {
      kind?: unknown;
      folderId?: unknown;
      driveId?: unknown;
    } | null;
    if (location?.kind === 'my_drive') out.location = { kind: 'my_drive' };
    else if (location?.kind === 'folder' && isDriveId(location.folderId)) {
      out.location = { kind: 'folder', folderId: location.folderId };
    } else if (location?.kind === 'shared_drive' && isDriveId(location.driveId)) {
      out.location = { kind: 'shared_drive', driveId: location.driveId };
    } else throw invalid('location', 'must be my_drive, a picked folder or a Shared Drive');
  }
  if (out.storageMode === undefined && out.location === undefined) {
    throw invalid('storageMode', 'nothing to change');
  }
  return out;
}

/** The service as every module builds it (FIX6 C1: the file import uses it too). */
export function googleDriveServiceFor(
  database: TenantDatabase,
  audit: AuditService,
  config: ApiConfig,
  transport: DriveTransport,
): GoogleDriveService {
  return new GoogleDriveService({
    database,
    audit,
    transport,
    cipher: tokenVaultFromEnv(config.mfaSeedKeys).slot('storage_token'),
    config: driveConfigFrom(process.env),
    apiPublicUrl: config.apiPublicUrl ?? config.webPublicUrl ?? '',
  });
}

/**
 * Always registered: with the Google client missing from the environment the routes still answer,
 * so the Storage screen can say "not configured" instead of failing.
 */
@Module({})
export class GoogleDriveModule {
  static register(transport: DriveTransport = createDriveTransport()): DynamicModule {
    const options: Provider = {
      provide: GOOGLE_DRIVE_OPTIONS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): DriveHttpOptions => ({
        sessionSecret: config.sessionSecret,
        secureCookies: config.secureCookies,
        webPublicUrl: config.webPublicUrl ?? '',
      }),
    };
    const service: Provider = {
      provide: GOOGLE_DRIVE_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, API_CONFIG],
      useFactory: (database: TenantDatabase, audit: AuditService, config: ApiConfig) =>
        googleDriveServiceFor(database, audit, config, transport),
    };
    return {
      module: GoogleDriveModule,
      providers: [options, service],
      controllers: [
        GoogleDriveStorageController,
        GoogleDriveAttachmentsController,
        GoogleDriveCallbackController,
      ],
    };
  }
}
