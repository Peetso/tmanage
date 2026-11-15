import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  cloudFileGone,
  cloudNoAccess,
  rethrowTooLarge,
  type FetchedCloudFile,
} from '../../common/storage/cloud-fetch.js';
import {
  isInsideFolder,
  type CloudFolderDrive,
  type CloudFolderPage,
  type CloudFolderRef,
} from '../cloud-folders/cloud-folder-drive.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type {
  OneDriveAttachmentRow,
  StorageConnectionRow,
  WorkItemRow,
} from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { SeedCipher } from '../identity/seed-cipher.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import {
  databaseStorageModes,
  type StorageMode,
  type StorageModeStore,
} from '../google-drive/storage-mode.repository.js';
import {
  ONEDRIVE_BASE_SCOPES,
  ONEDRIVE_CALLBACK_PATH,
  ONEDRIVE_LIBRARY_SCOPES,
  ONEDRIVE_ROOT_FOLDER_NAME,
  OneDriveConsentRequiredError,
  OneDriveGrantRevokedError,
  OneDriveItemNotFoundError,
  OneDriveNoAccessError,
  OneDriveUnavailableError,
  PERSONAL_PICKER_BASE_URL,
  PERSONAL_PICKER_SCOPE,
  newOneDriveFlow,
  oneDriveAuthorizationUrl,
  oneDriveFolderName,
  oneDriveStateMatches,
  type OneDriveConfig,
  type OneDriveFlow,
  type OneDriveItem,
  type OneDriveTransport,
} from './onedrive.graph.js';
import {
  OneDriveRepository,
  type AttachedItem,
  type ConnectionPatch,
} from './onedrive.repository.js';

/**
 * OneDrive as company storage — the application service (0236). It mirrors
 * `GoogleDriveService`: Microsoft is never called inside a database transaction, every change to
 * where company files live or to a work item's links is audited in the same transaction as the
 * change, and the refresh token is decrypted only in {@link OneDriveService.token}.
 *
 * Two Microsoft differences: the refresh token **rotates** on every refresh (the new one is
 * re-encrypted and stored at once), and there is **no revoke endpoint** (a disconnect wipes the
 * stored token; the owner can also remove TManage under account.microsoft.com > Privacy > Apps).
 */

export interface OneDriveStatusView {
  /** False when the Microsoft client is not set in the environment: the feature is off. */
  readonly configured: boolean;
  readonly pickerAvailable: boolean;
  /** The company's one effective storage, across providers. */
  readonly storageMode: StorageMode;
  readonly oneDrive: {
    readonly status: 'not_connected' | 'connected' | 'error';
    /** Shown to people who manage the organization only. */
    readonly accountEmail: string | null;
    readonly folderPath: string | null;
    /** The drive the root lives in (the account's OneDrive, or a SharePoint library's name). */
    readonly driveName: string | null;
    /** Whether the grant includes SharePoint document libraries (`Files.ReadWrite.All`). */
    readonly librariesEnabled: boolean;
  };
}

export interface OneDriveAttachmentView {
  readonly id: string;
  readonly workItemId: string;
  readonly driveId: string;
  readonly itemId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
  readonly webUrl: string | null;
  readonly createdAt: string;
}

/**
 * NV10. `onedrive`: File Picker v8 with a resource token minted from the company connection,
 * only for a caller who can read every project. `scoped`: no token; the browser lists the
 * project's own TManage folders through {@link OneDriveService.projectFiles}.
 */
export interface OneDriveFilePickerSessionView {
  readonly mode: 'onedrive';
  readonly accessToken: string;
  /** `personal` (onedrive.live.com picker) or `business` (the SharePoint FilePicker.aspx). */
  readonly accountType: 'personal' | 'business';
  readonly baseUrl: string;
  readonly rootDriveId: string;
  readonly rootItemId: string;
  readonly librariesEnabled: boolean;
}

export interface OneDriveScopedPickerSessionView {
  readonly mode: 'scoped';
  readonly projectId: string;
}

export type OneDrivePickerSessionView =
  OneDriveFilePickerSessionView | OneDriveScopedPickerSessionView;

export interface OneDriveProjectFilesView {
  /** The drive every listed file lives in (the connection's root drive); attach needs it. */
  readonly driveId: string;
  readonly folderId: string | null;
  readonly files: readonly {
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
    readonly size: number | null;
    readonly modifiedTime: string | null;
    readonly isFolder: boolean;
  }[];
  readonly folders: readonly {
    readonly id: string;
    readonly kind: string;
    readonly name: string;
  }[];
  readonly nextPageToken: string | null;
}

/**
 * R36 F2. One folder of the connected drive, for **Change folder** on the Storage screen: its
 * sub-folders only (never files, never a token). Browsed with the connection's own Graph token, so
 * it needs no second Microsoft consent, unlike File Picker v8.
 */
export interface OneDriveFolderBrowseView {
  readonly driveId: string;
  /** The folder listed; at the drive's top, its real id and `isDriveRoot: true`. */
  readonly folder: { readonly id: string; readonly name: string; readonly isDriveRoot: boolean };
  readonly folders: readonly { readonly id: string; readonly name: string }[];
  readonly nextPageToken: string | null;
}

export type OneDriveLocation =
  | { readonly kind: 'my_files' }
  | { readonly kind: 'folder'; readonly driveId: string; readonly itemId: string }
  | { readonly kind: 'library'; readonly driveId: string };

export interface OneDriveSettingsInput {
  readonly storageMode?: 'tmanage' | 'onedrive';
  readonly location?: OneDriveLocation;
}

/** How far up the attach check follows a file's unknown parents before it refuses (M04 mirror). */
export const ORIGIN_MAX_HOPS = 8;
/** `storage_connections.root_folder_id` is VARCHAR(128). */
const ROOT_ID_MAX = 128;

export interface OneDriveServiceDeps {
  readonly database: TenantDatabase;
  readonly audit: AuditService;
  readonly transport: OneDriveTransport;
  readonly cipher: SeedCipher;
  readonly config: OneDriveConfig | null;
  /** The OAuth redirect is `${apiPublicUrl}/v1/integrations/onedrive/callback`. */
  readonly apiPublicUrl: string;
  readonly repository?: OneDriveRepository;
  readonly workItems?: Pick<WorkItemsRepository, 'findById'>;
  readonly projects?: Pick<ProjectsRepository, 'findById'>;
  readonly storageModes?: StorageModeStore;
}

type LiveConnection = StorageConnectionRow & {
  refreshTokenEnc: string;
  rootFolderId: string;
  onedriveDriveId: string;
};

/** The additional data binding a stored refresh token to its organization and provider. */
export function tokenBinding(organizationId: string): { userId: string } {
  return { userId: `storage:${organizationId}:onedrive` };
}

type ConflictReason = 'not_configured' | 'not_connected' | 'unreachable' | 'consent_required';

function conflict(detail: ConflictReason): ApiError {
  const messages = {
    not_configured: 'OneDrive is not set up for TManage yet',
    not_connected: 'OneDrive is not connected',
    unreachable: 'OneDrive is not reachable. Reconnect it in Storage',
    consent_required: 'OneDrive needs your permission for this. Reconnect it in Storage',
  } as const;
  return new ApiError(409, 'conflict', messages[detail], [{ field: 'storage', message: detail }]);
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

const notFound = () => new ApiError(404, 'not_found', MESSAGES.notFound);

/** FIX6 C1. On the import path an item Graph no longer shows is "gone", not a bare 404. */
function goneOrRethrow(error: unknown): never {
  if (error instanceof OneDriveItemNotFoundError) throw cloudFileGone();
  throw error;
}

/** Whether the grant holds SharePoint libraries; Microsoft may prefix scopes with the Graph URL. */
export function grantsLibraries(grantedScopes: string | null | undefined): boolean {
  return /(^|[\s/])Files\.ReadWrite\.All(\s|$)/.test(grantedScopes ?? '');
}

/** The Graph scopes a refresh asks for: the same set the grant was made with. */
function graphScopes(row: StorageConnectionRow): string {
  return grantsLibraries(row.grantedScopes) ? ONEDRIVE_LIBRARY_SCOPES : ONEDRIVE_BASE_SCOPES;
}

export class OneDriveService implements CloudFolderDrive {
  private readonly repository: OneDriveRepository;
  private readonly workItems: Pick<WorkItemsRepository, 'findById'>;
  private readonly projects: Pick<ProjectsRepository, 'findById'>;
  private readonly modes: StorageModeStore;

  constructor(private readonly deps: OneDriveServiceDeps) {
    this.repository = deps.repository ?? new OneDriveRepository();
    this.workItems = deps.workItems ?? new WorkItemsRepository();
    this.projects = deps.projects ?? new ProjectsRepository();
    this.modes = deps.storageModes ?? databaseStorageModes;
  }

  get redirectUri(): string {
    return `${this.deps.apiPublicUrl.replace(/\/+$/, '')}${ONEDRIVE_CALLBACK_PATH}`;
  }

  // ── Status and settings ───────────────────────────────────────────────────

  async status(context: TenantContext, canManage: boolean): Promise<OneDriveStatusView> {
    const { row, mode } = await this.deps.database.read(context, async (runner) => ({
      row: await this.repository.findConnection(runner, context),
      mode: await this.modes.effective(runner, context),
    }));
    return toOneDriveStatusView(this.deps.config, row, canManage, mode);
  }

  /** Begin connecting: the Microsoft consent URL and the flow to seal into the cookie. */
  startConnect(
    context: TenantContext,
    organizationSlug: string,
    options: { readonly libraries: boolean },
  ): { readonly url: string; readonly flow: OneDriveFlow } {
    const config = this.requireConfig();
    const flow = newOneDriveFlow({
      organizationId: context.organizationId,
      organizationSlug,
      userId: context.userId,
      libraries: options.libraries,
    });
    return {
      url: oneDriveAuthorizationUrl({ config, redirectUri: this.redirectUri, flow }),
      flow,
    };
  }

  /**
   * Finish connecting. The flow must have been started by this person in this organization and
   * the returned `state` must equal the cookie's; anything else is refused before Microsoft is
   * called. The root starts at `TManage/` in the account's own OneDrive.
   */
  async completeConnect(
    context: TenantContext,
    flow: OneDriveFlow | undefined,
    input: { code: unknown; state: unknown },
  ): Promise<OneDriveStatusView> {
    const config = this.requireConfig();
    if (
      !flow ||
      flow.organizationId !== context.organizationId ||
      flow.userId !== context.userId ||
      !oneDriveStateMatches(flow, input.state) ||
      typeof input.code !== 'string' ||
      input.code === '' ||
      input.code.length > 4096
    ) {
      throw new ApiError(400, 'validation_failed', 'The Microsoft sign-in could not be completed');
    }
    const scope = flow.libraries ? ONEDRIVE_LIBRARY_SCOPES : ONEDRIVE_BASE_SCOPES;
    const tokens = await this.graph(() =>
      this.deps.transport.exchangeCode({
        config,
        code: input.code as string,
        redirectUri: this.redirectUri,
        verifier: flow.verifier,
        scope,
      }),
    );
    if (!tokens.refreshToken) throw conflict('unreachable');
    const drive = await this.graph(() => this.deps.transport.myDrive(tokens.accessToken));
    const rootItemId = await this.ensureRoot(tokens.accessToken, drive.id, 'root');
    const refreshTokenEnc = this.deps.cipher.encrypt(
      tokens.refreshToken,
      tokenBinding(context.organizationId),
    );
    const { row, mode } = await this.deps.database.transaction(context, async (tx) => {
      await this.repository.saveConnected(tx, context, {
        accountEmail: tokens.email,
        refreshTokenEnc,
        driveId: drive.id,
        driveName: drive.name,
        rootItemId,
        grantedScopes: (tokens.scope ?? scope).slice(0, 512),
        connectedByUserId: context.userId,
      });
      const saved = await this.repository.findConnection(tx, context);
      await this.deps.audit.record(tx, context, {
        action: 'storage_connection.connected',
        result: 'allowed',
        objectId: saved?.id ?? null,
        metadata: { provider: 'onedrive', uses_library: flow.libraries },
      });
      return { row: saved, mode: await this.modes.effective(tx, context) };
    });
    return toOneDriveStatusView(this.deps.config, row, true, mode);
  }

  async updateSettings(
    context: TenantContext,
    input: OneDriveSettingsInput,
  ): Promise<OneDriveStatusView> {
    const connection = await this.readConnection(context);
    const patch: ConnectionPatch = {};

    if (input.location) {
      const live = this.requireLive(connection);
      const accessToken = await this.token(context, live);
      const location = input.location;
      if (location.kind === 'my_files') {
        const drive = await this.graph(() => this.deps.transport.myDrive(accessToken));
        patch.rootFolderId = await this.ensureRoot(accessToken, drive.id, 'root');
        patch.onedriveDriveId = drive.id;
        patch.onedriveDriveName = drive.name;
      } else if (location.kind === 'library') {
        if (!grantsLibraries(live.grantedScopes)) throw conflict('consent_required');
        const drive = await this.graph(() =>
          this.deps.transport.getDrive(accessToken, location.driveId),
        );
        patch.rootFolderId = await this.ensureRoot(accessToken, drive.id, 'root');
        patch.onedriveDriveId = drive.id;
        patch.onedriveDriveName = oneDriveFolderName(drive.name, 'SharePoint library');
      } else {
        const folder = await this.graph(() =>
          this.deps.transport.getItem(accessToken, {
            driveId: location.driveId,
            itemId: location.itemId,
          }),
        );
        if (!folder.isFolder) throw invalid('location', 'must be a folder');
        patch.rootFolderId = await this.ensureRoot(accessToken, folder.driveId, folder.id);
        patch.onedriveDriveId = folder.driveId;
        // R36 F2. The drive's own top has no parent and is called `root`; show the drive's name.
        const placeName =
          folder.parentId === null
            ? (await this.graph(() => this.deps.transport.getDrive(accessToken, folder.driveId)))
                .name
            : folder.name;
        patch.onedriveDriveName = oneDriveFolderName(placeName, 'OneDrive');
      }
    }
    if (input.storageMode === 'onedrive') this.requireLive(connection);
    if (!connection) {
      // Nothing to change: with no connection the company is not on OneDrive already.
      if (input.storageMode === 'tmanage' && !input.location) return this.status(context, true);
      throw conflict('not_connected');
    }

    const { row, mode } = await this.deps.database.transaction(context, async (tx) => {
      await this.repository.update(tx, context, connection.id, patch);
      if (input.storageMode !== undefined) {
        await this.modes.switchTo(tx, context, input.storageMode);
      }
      const effective = await this.modes.effective(tx, context);
      await this.deps.audit.record(tx, context, {
        action: 'storage_connection.settings_changed',
        result: 'allowed',
        objectId: connection.id,
        metadata: {
          provider: 'onedrive',
          storage_mode: effective,
          location: input.location?.kind ?? 'unchanged',
        },
      });
      return { row: await this.repository.findConnection(tx, context), mode: effective };
    });
    return toOneDriveStatusView(this.deps.config, row, true, mode);
  }

  /**
   * Disconnect: wipe the token and move this row back to TManage storage. Microsoft has no
   * revoke endpoint for a refresh token, so nothing is sent to Microsoft.
   */
  async disconnect(context: TenantContext): Promise<OneDriveStatusView> {
    const connection = await this.readConnection(context);
    if (!connection || connection.status === 'disconnected') return this.status(context, true);
    const { row, mode } = await this.deps.database.transaction(context, async (tx) => {
      await this.repository.update(tx, context, connection.id, {
        status: 'disconnected',
        storageMode: 'tmanage',
        refreshTokenEnc: null,
        lastErrorCode: null,
        disconnectedAt: new Date(),
      });
      await this.deps.audit.record(tx, context, {
        action: 'storage_connection.disconnected',
        result: 'allowed',
        objectId: connection.id,
        metadata: { provider: 'onedrive' },
      });
      return {
        row: await this.repository.findConnection(tx, context),
        mode: await this.modes.effective(tx, context),
      };
    });
    return toOneDriveStatusView(this.deps.config, row, true, mode);
  }

  // ── Picker, upload and attachments ────────────────────────────────────────

  /**
   * How the browser may choose OneDrive files (NV10 mirror). A picker token reaches every file the
   * connected account can, so it leaves only for a caller who could already read every project:
   * no target project needs org-wide scope and `org.manage`; a project-scoped caller gets
   * `scoped` (no token is minted). Never a client or a guest. Each token issued is audited.
   * `resource` (business accounts) picks the SharePoint origin the picker asked a token for; only
   * the account's own `-my.sharepoint.com` origin, or with libraries its `.sharepoint.com` origin.
   */
  async pickerSession(
    context: TenantContext,
    principal: Principal,
    projectId?: string,
    resource?: string,
  ): Promise<OneDrivePickerSessionView> {
    await this.requirePickerRelation(context, principal, projectId);
    if (projectId === undefined) this.requireOrgManage(context, principal);
    if (projectId !== undefined && !principal.hasOrgWideScope) {
      this.requireLive(await this.readConnection(context));
      return { mode: 'scoped', projectId };
    }
    const live = this.requireLive(await this.readConnection(context));
    const libraries = grantsLibraries(live.grantedScopes);
    const graphToken = await this.token(context, live);
    const drive = await this.graph(() => this.deps.transport.myDrive(graphToken), live.id, context);
    const target = pickerTarget(drive.driveType, drive.webUrl, libraries, resource);
    if (target === 'refused') throw invalid('resource', 'is not this account’s OneDrive');
    const accessToken = await this.token(context, live, target.scope);
    await this.deps.database.transaction(context, (tx) =>
      this.deps.audit.record(tx, context, {
        action: 'drive_picker.session_issued',
        result: 'allowed',
        objectId: live.id,
        metadata: {
          provider: 'onedrive',
          ...(projectId === undefined ? {} : { project_id: projectId }),
        },
      }),
    );
    return {
      mode: 'onedrive',
      accessToken,
      accountType: target.accountType,
      baseUrl: target.baseUrl,
      rootDriveId: live.onedriveDriveId,
      rootItemId: live.rootFolderId,
      librariesEnabled: libraries,
    };
  }

  /**
   * R36 F2. **Change folder**: one page of the sub-folders of `folderId` (the top of the drive the
   * root lives in by default), read with the connection's Graph token. The org.manage check is the
   * route's. A folder of another drive or a file answers 404, like an unknown id.
   */
  async browseFolders(
    context: TenantContext,
    input: { readonly folderId?: string; readonly pageToken?: string },
  ): Promise<OneDriveFolderBrowseView> {
    const live = this.requireLive(await this.readConnection(context));
    const accessToken = await this.token(context, live);
    const driveId = live.onedriveDriveId;
    const folder = await this.graph(
      () => this.deps.transport.getItem(accessToken, { driveId, itemId: input.folderId ?? 'root' }),
      live.id,
      context,
    );
    if (!folder.isFolder || folder.driveId !== driveId) throw notFound();
    const page = await this.graph(
      () =>
        this.deps.transport.listChildren(accessToken, {
          driveId,
          itemId: folder.id,
          skipToken: input.pageToken ?? null,
        }),
      live.id,
      context,
    );
    const isDriveRoot = folder.parentId === null;
    return {
      driveId,
      folder: { id: folder.id, name: isDriveRoot ? '' : folder.name, isDriveRoot },
      folders: page.files
        .filter((child) => child.isFolder)
        .map((child) => ({ id: child.id, name: child.name })),
      nextPageToken: page.nextPageToken,
    };
  }

  /** NV10. The server-side file list of one of the project's own TManage folders. */
  async projectFiles(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    input: { readonly folderId?: string; readonly pageToken?: string },
  ): Promise<OneDriveProjectFilesView> {
    await this.requirePickerRelation(context, principal, projectId);
    const live = this.requireLive(await this.readConnection(context));
    const known = await this.deps.database.read(context, (runner) =>
      this.repository.listProjectFolders(runner, context, projectId, live.rootFolderId),
    );
    const visible = known.filter(
      (folder) =>
        folder.item === null ||
        authorize({ principal, capability: 'work.read', resource: resourceOf(folder.item) })
          .allowed,
    );
    if (input.folderId !== undefined && !visible.some((f) => f.itemId === input.folderId)) {
      throw notFound();
    }
    const folders = visible.map((f) => ({ id: f.itemId, kind: f.kind, name: f.name }));
    const projectFolder = visible.find((folder) => folder.kind === 'project');
    if (!projectFolder) {
      return {
        driveId: live.onedriveDriveId,
        folderId: null,
        files: [],
        folders,
        nextPageToken: null,
      };
    }
    const folderId = input.folderId ?? projectFolder.itemId;
    const accessToken = await this.token(context, live);
    const page = await this.graph(
      () =>
        this.deps.transport.listChildren(accessToken, {
          driveId: live.onedriveDriveId,
          itemId: folderId,
          skipToken: input.pageToken ?? null,
        }),
      live.id,
      context,
    );
    return {
      driveId: live.onedriveDriveId,
      folderId,
      files: page.files,
      folders,
      nextPageToken: page.nextPageToken,
    };
  }

  async list(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<readonly OneDriveAttachmentView[]> {
    return this.deps.database.read(context, async (runner) => {
      await this.readableItem(runner, context, principal, workItemId);
      return (await this.repository.listAttachments(runner, context, workItemId)).map(toView);
    });
  }

  /** Attach a OneDrive file (picked or just uploaded). Idempotent per work item and file. */
  async attach(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    target: { readonly driveId: string; readonly itemId: string },
  ): Promise<OneDriveAttachmentView> {
    const live = this.requireLive(await this.readConnection(context));
    await this.deps.database.read(context, (runner) =>
      this.writableItem(runner, context, principal, workItemId),
    );
    const accessToken = await this.token(context, live);
    const file = await this.graph(
      () => this.deps.transport.getItem(accessToken, target),
      live.id,
      context,
    );
    if (file.isFolder) throw invalid('itemId', 'must be a file');
    // Microsoft is asked about the ancestors here, outside the transaction.
    const origin = await this.resolveOrigin(context, live, accessToken, file);

    return this.deps.database.transaction(context, async (tx) => {
      const item = await this.writableItem(tx, context, principal, workItemId);
      await this.requireAttachableOrigin(tx, context, principal, live, item, file, origin);
      const existing = (await this.repository.listAttachments(tx, context, workItemId)).find(
        (row) => row.driveId === file.driveId && row.itemId === file.id,
      );
      if (existing) return toView(existing);
      const row = await this.repository.insertAttachment(tx, context, {
        workItemId,
        driveId: file.driveId,
        itemId: file.id,
        name: file.name.slice(0, 255),
        mimeType: file.mimeType.slice(0, 190),
        sizeBytes: file.size,
        webUrl: safeOneDriveLink(file.webUrl),
        attachedByUserId: context.userId,
      });
      await this.deps.audit.record(tx, context, {
        action: 'onedrive_attachment.attached',
        result: 'allowed',
        objectId: row.id,
        metadata: { provider: 'onedrive', work_item_id: workItemId },
      });
      return toView(row);
    });
  }

  /**
   * FIX6 C1. A picked OneDrive file's bytes, for the server-side import into `projectId`. The
   * caller has already checked the person may add files there; this applies the same origin rule
   * as {@link attach} and then downloads with the company connection, at most `maxBytes`. The
   * token never leaves this service.
   */
  async fetchForImport(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    target: { readonly driveId: string; readonly itemId: string },
    maxBytes: number,
  ): Promise<FetchedCloudFile> {
    const live = this.requireLive(await this.readConnection(context));
    const accessToken = await this.token(context, live);
    const file = await this.graph(
      () => this.deps.transport.getItem(accessToken, target).catch(goneOrRethrow),
      live.id,
      context,
    );
    if (file.isFolder) throw invalid('itemId', 'must be a file');
    const origin = await this.resolveOrigin(context, live, accessToken, file);
    await this.deps.database.read(context, (runner) =>
      this.requireAttachableOrigin(runner, context, principal, live, { projectId }, file, origin),
    );
    const bytes = await this.graph(
      () =>
        this.deps.transport
          .downloadItem(accessToken, { driveId: file.driveId, itemId: file.id }, maxBytes)
          .catch((error: unknown) => {
            if (error instanceof OneDriveNoAccessError) throw cloudNoAccess();
            return goneOrRethrow(error);
          })
          .catch(rethrowTooLarge),
      live.id,
      context,
    );
    return {
      provider: 'onedrive',
      externalId: `${file.driveId}:${file.id}`,
      name: file.name.slice(0, 255),
      mimeType: file.mimeType.slice(0, 190),
      bytes,
    };
  }

  /**
   * FIX6 C3. A OneDrive folder about to be attached to a work item of `projectId`. The TManage
   * root, a folder that holds it, and a folder under another project's TManage folder are the
   * same 404 an unknown id gives.
   */
  async describeFolder(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    ref: CloudFolderRef,
  ): Promise<{ readonly name: string }> {
    const live = this.requireLive(await this.readConnection(context));
    const accessToken = await this.token(context, live);
    const folder = await this.graph(
      () => this.deps.transport.getItem(accessToken, this.target(ref, ref.folderId)),
      live.id,
      context,
    );
    if (!folder.isFolder) throw invalid('itemId', 'must be a folder');
    if (folder.driveId === live.onedriveDriveId) {
      if (folder.id === live.rootFolderId) throw notFound();
      const root = await this.graph(
        () =>
          this.deps.transport.getItem(
            accessToken,
            { driveId: live.onedriveDriveId, itemId: live.rootFolderId },
            'parent',
          ),
        live.id,
        context,
      );
      const parentsOf = this.parentsReader(context, live, accessToken, folder.driveId);
      if (await isInsideFolder(folder.id, root.parentId ? [root.parentId] : [], parentsOf)) {
        throw notFound();
      }
    }
    const origin = await this.resolveOrigin(context, live, accessToken, folder);
    await this.deps.database.read(context, (runner) =>
      this.requireAttachableOrigin(runner, context, principal, live, { projectId }, folder, origin),
    );
    return { name: folder.name.slice(0, 255) };
  }

  /** FIX6 C3. One live page of the attached folder, or of a subfolder proven to be inside it. */
  async listFolder(
    context: TenantContext,
    ref: CloudFolderRef,
    input: { readonly parentId: string | null; readonly pageToken: string | null },
  ): Promise<CloudFolderPage> {
    const live = this.requireLive(await this.readConnection(context));
    const accessToken = await this.token(context, live);
    let itemId = ref.folderId;
    if (input.parentId !== null && input.parentId !== ref.folderId) {
      const sub = await this.childInside(context, live, accessToken, ref, input.parentId);
      if (!sub.isFolder) throw invalid('parentId', 'must be a folder');
      itemId = sub.id;
    }
    const page = await this.graph(
      () =>
        this.deps.transport.listChildren(accessToken, {
          ...this.target(ref, itemId),
          skipToken: input.pageToken,
        }),
      live.id,
      context,
    );
    return { files: page.files, nextPageToken: page.nextPageToken };
  }

  /** FIX6 C3. A child's bytes, only once it is proven to sit inside the attached folder. */
  async fetchFromFolder(
    context: TenantContext,
    ref: CloudFolderRef,
    childId: string,
    maxBytes: number,
  ): Promise<FetchedCloudFile> {
    const live = this.requireLive(await this.readConnection(context));
    const accessToken = await this.token(context, live);
    const file = await this.childInside(context, live, accessToken, ref, childId);
    if (file.isFolder) throw invalid('itemId', 'must be a file');
    const bytes = await this.graph(
      () =>
        this.deps.transport
          .downloadItem(accessToken, { driveId: file.driveId, itemId: file.id }, maxBytes)
          .catch((error: unknown) => {
            if (error instanceof OneDriveNoAccessError) throw cloudNoAccess();
            return goneOrRethrow(error);
          })
          .catch(rethrowTooLarge),
      live.id,
      context,
    );
    return {
      provider: 'onedrive',
      externalId: `${file.driveId}:${file.id}`,
      name: file.name.slice(0, 255),
      mimeType: file.mimeType.slice(0, 190),
      bytes,
    };
  }

  private target(ref: CloudFolderRef, itemId: string): { driveId: string; itemId: string } {
    if (ref.driveId === null) throw notFound();
    return { driveId: ref.driveId, itemId };
  }

  /**
   * FIX6 C3. The child, when it is in the folder's drive and its parent chain leads up to the
   * attached folder (at most 20 levels); a 404 otherwise. The chain is followed by item id rather
   * than by comparing `parentReference.path` strings, which Graph may percent-encode while names
   * are not, so a prefix test could match a sibling whose name looks like a path.
   */
  private async childInside(
    context: TenantContext,
    live: LiveConnection,
    accessToken: string,
    ref: CloudFolderRef,
    childId: string,
  ): Promise<OneDriveItem> {
    const file = await this.graph(
      () => this.deps.transport.getItem(accessToken, this.target(ref, childId)),
      live.id,
      context,
    );
    const parentsOf = this.parentsReader(context, live, accessToken, file.driveId);
    if (
      file.driveId !== ref.driveId ||
      file.id === ref.folderId ||
      !(await isInsideFolder(ref.folderId, file.parentId ? [file.parentId] : [], parentsOf))
    ) {
      throw notFound();
    }
    return file;
  }

  /** An ancestor's parent for the descendant walk; one Graph will not show ends the branch. */
  private parentsReader(
    context: TenantContext,
    live: LiveConnection,
    accessToken: string,
    driveId: string,
  ): (id: string) => Promise<readonly string[]> {
    return async (itemId) => {
      try {
        const item = await this.deps.transport.getItem(accessToken, { driveId, itemId }, 'parent');
        return item.parentId ? [item.parentId] : [];
      } catch (error) {
        if (error instanceof OneDriveItemNotFoundError) return [];
        return this.graph<readonly string[]>(() => Promise.reject(error), live.id, context);
      }
    };
  }

  async detach(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    attachmentId: string,
  ): Promise<void> {
    await this.deps.database.transaction(context, async (tx) => {
      await this.writableItem(tx, context, principal, workItemId);
      const changed = await this.repository.removeAttachment(tx, context, workItemId, attachmentId);
      if (changed === 0) throw notFound();
      await this.deps.audit.record(tx, context, {
        action: 'onedrive_attachment.removed',
        result: 'allowed',
        objectId: attachmentId,
        metadata: { provider: 'onedrive', work_item_id: workItemId },
      });
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * M04 mirror. Follow the file's parent chain (Graph gives one parent) until a TManage folder or
   * root, at most {@link ORIGIN_MAX_HOPS} hops. `outside`: the chain reaches the drive's root with
   * no TManage folder on the way. `unresolved`: the hops run out, the chain loops, or an ancestor
   * answers 403/404 (it may be another project's folder; fail closed).
   */
  private async resolveOrigin(
    context: TenantContext,
    live: LiveConnection,
    accessToken: string,
    file: OneDriveItem,
  ): Promise<AttachOrigin> {
    const seen = new Set<string>([file.id]);
    let parentId = file.parentId;
    for (let hop = 0; ; hop += 1) {
      if (parentId === null) return { kind: 'outside' };
      if (await this.isTManageFolder(context, live, file.driveId, parentId)) {
        return { kind: 'tmanage', parentId };
      }
      if (hop === ORIGIN_MAX_HOPS) return { kind: 'unresolved' };
      seen.add(parentId);
      let next: string | null;
      try {
        const ancestor = { driveId: file.driveId, itemId: parentId };
        next = (await this.deps.transport.getItem(accessToken, ancestor, 'parent')).parentId;
      } catch (error) {
        if (error instanceof OneDriveItemNotFoundError) return { kind: 'unresolved' };
        return this.graph<AttachOrigin>(() => Promise.reject(error), live.id, context);
      }
      if (next !== null && seen.has(next)) return { kind: 'unresolved' };
      parentId = next;
    }
  }

  private isTManageFolder(
    context: TenantContext,
    live: LiveConnection,
    driveId: string,
    itemId: string,
  ): Promise<boolean> {
    if (itemId === live.rootFolderId) return Promise.resolve(true);
    return this.deps.database.read(context, async (runner) => {
      if (await this.repository.findKnownFolder(runner, context, driveId, itemId)) return true;
      return this.repository.isKnownRoot(runner, context, itemId);
    });
  }

  /**
   * V2 and M04 mirror. A file may be attached when its nearest TManage ancestor is one of the
   * destination project's own folders, or when it has no TManage ancestor at all (a person's own
   * picked file) and is not already linked to an item the caller cannot read. Anything else is
   * the same 404 an unknown id gives.
   */
  private async requireAttachableOrigin(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    live: LiveConnection,
    item: Pick<WorkItemRow, 'projectId'>,
    file: OneDriveItem,
    origin: AttachOrigin,
  ): Promise<void> {
    if (origin.kind === 'unresolved') throw notFound();
    if (origin.kind === 'tmanage') {
      const known = await this.repository.findKnownFolder(
        runner,
        context,
        file.driveId,
        origin.parentId,
      );
      // A root (`TManage/` itself), another project's folder, or a folder no longer known.
      if (!known || known.projectId !== item.projectId || origin.parentId === live.rootFolderId) {
        throw notFound();
      }
      return;
    }
    const linked = await this.repository.attachedItemsForFile(
      runner,
      context,
      file.driveId,
      file.id,
    );
    for (const row of linked) {
      if (!authorize({ principal, capability: 'work.read', resource: resourceOf(row) }).allowed) {
        throw notFound();
      }
    }
  }

  private requireConfig(): OneDriveConfig {
    if (!this.deps.config) throw conflict('not_configured');
    return this.deps.config;
  }

  private requireLive(connection: StorageConnectionRow | undefined): LiveConnection {
    this.requireConfig();
    if (!connection || connection.status === 'disconnected' || !connection.refreshTokenEnc) {
      throw conflict('not_connected');
    }
    if (connection.status === 'error' || !connection.rootFolderId || !connection.onedriveDriveId) {
      throw conflict('unreachable');
    }
    return connection as LiveConnection;
  }

  private readConnection(context: TenantContext): Promise<StorageConnectionRow | undefined> {
    return this.deps.database.read(context, (runner) =>
      this.repository.findConnection(runner, context),
    );
  }

  /**
   * A fresh access token for `scope` (Graph by default). Microsoft rotates the refresh token on
   * every refresh, so the new one is encrypted and stored straight away; a refused grant moves the
   * connection to `error`.
   */
  private async token(
    context: TenantContext,
    connection: LiveConnection,
    scope: string = graphScopes(connection),
  ): Promise<string> {
    const config = this.requireConfig();
    const binding = tokenBinding(context.organizationId);
    const refreshToken = this.deps.cipher.decrypt(connection.refreshTokenEnc, binding);
    // R36 F2. A refusal for the picker's own resource (never consented at connect) says nothing
    // about the Graph grant: it is a consent problem, and the connection stays connected.
    const otherResource = scope !== graphScopes(connection);
    const tokens = await this.graph(
      () =>
        this.deps.transport.refreshTokens({ config, refreshToken, scope }).catch((error) => {
          if (otherResource && error instanceof OneDriveGrantRevokedError) {
            throw new OneDriveConsentRequiredError('Microsoft refused the picker scope');
          }
          throw error;
        }),
      otherResource ? undefined : connection.id,
      otherResource ? undefined : context,
    );
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
      const rotated = this.deps.cipher.encrypt(tokens.refreshToken, binding);
      await this.deps.database.transaction(context, (tx) =>
        this.repository.storeRotatedToken(tx, context, connection.id, rotated),
      );
    }
    return tokens.accessToken;
  }

  /** Run a Microsoft call; a refused grant marks the connection `error`, anything else is a 409. */
  private async graph<T>(
    work: () => Promise<T>,
    connectionId?: string,
    context?: TenantContext,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof OneDriveItemNotFoundError) throw notFound();
      if (error instanceof OneDriveConsentRequiredError) throw conflict('consent_required');
      if (error instanceof OneDriveGrantRevokedError && connectionId && context) {
        await this.deps.database.transaction(context, (tx) =>
          this.repository.update(tx, context, connectionId, {
            status: 'error',
            lastErrorCode: 'revoked',
          }),
        );
      }
      throw conflict('unreachable');
    }
  }

  /** `TManage/` under `parentId` in `driveId`; its id must fit `root_folder_id`. */
  private async ensureRoot(
    accessToken: string,
    driveId: string,
    parentId: string,
  ): Promise<string> {
    const id = await this.graph(() =>
      this.deps.transport.ensureFolder(accessToken, {
        driveId,
        parentId,
        name: ONEDRIVE_ROOT_FOLDER_NAME,
      }),
    );
    if (id.length > ROOT_ID_MAX) {
      return this.graph<string>(() => Promise.reject(new OneDriveUnavailableError('Long id')));
    }
    return id;
  }

  private requireOrgManage(context: TenantContext, principal: Principal): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  private async requirePickerRelation(
    context: TenantContext,
    principal: Principal,
    projectId: string | undefined,
  ): Promise<void> {
    if (principal.kind !== 'internal' || principal.role === 'guest') {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'picker_not_for_guests');
    }
    if (projectId === undefined) {
      if (principal.hasOrgWideScope) return;
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'picker_target_project_required',
      );
    }
    const project = await this.deps.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project) throw notFound();
    const verdict = authorize({
      principal,
      capability: 'file.upload',
      resource: {
        organizationId: project.organizationId,
        projectId: project.id,
        audience: 'internal',
        lifecycle: project.archivedAt === null ? 'active' : 'archived',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  private async readableItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRow> {
    const row = await this.workItems.findById(runner, context, workItemId);
    if (
      !row ||
      row.deletedAt !== null ||
      !authorize({ principal, capability: 'work.read', resource: resourceOf(row) }).allowed
    ) {
      throw notFound();
    }
    return row;
  }

  private async writableItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRow> {
    const row = await this.readableItem(runner, context, principal, workItemId);
    const verdict = authorize({ principal, capability: 'work.update', resource: resourceOf(row) });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
    return row;
  }
}

type AttachOrigin =
  | { readonly kind: 'tmanage'; readonly parentId: string }
  | { readonly kind: 'outside' }
  | { readonly kind: 'unresolved' };

function resourceOf(row: AttachedItem) {
  return {
    organizationId: row.organizationId,
    projectId: row.projectId,
    audience: row.audience,
    lifecycle: row.deletedAt
      ? ('soft_deleted' as const)
      : row.state === 'archived'
        ? ('archived' as const)
        : ('active' as const),
  };
}

/**
 * Where File Picker v8 runs and which token it needs. Personal: onedrive.live.com with an
 * `OneDrive.ReadWrite` token. Business: the account's `https://<tenant>-my.sharepoint.com` with a
 * `.default` token for that origin; with libraries also `https://<tenant>.sharepoint.com`. Any
 * other requested resource is refused.
 */
export function pickerTarget(
  driveType: string,
  driveWebUrl: string | null,
  libraries: boolean,
  resource: string | undefined,
): { accountType: 'personal' | 'business'; baseUrl: string; scope: string } | 'refused' {
  if (driveType === 'personal') {
    if (resource !== undefined && resource !== PERSONAL_PICKER_BASE_URL) return 'refused';
    return {
      accountType: 'personal',
      baseUrl: PERSONAL_PICKER_BASE_URL,
      scope: PERSONAL_PICKER_SCOPE,
    };
  }
  let mine: URL;
  try {
    mine = new URL(driveWebUrl ?? '');
  } catch {
    return 'refused';
  }
  if (mine.protocol !== 'https:' || !mine.hostname.endsWith('-my.sharepoint.com')) return 'refused';
  const allowed = [mine.origin];
  if (libraries) allowed.push(mine.origin.replace('-my.sharepoint.com', '.sharepoint.com'));
  const wanted = resource === undefined ? mine.origin : resource.replace(/\/+$/, '');
  if (!allowed.includes(wanted)) return 'refused';
  return {
    accountType: 'business',
    baseUrl: wanted,
    scope: `${wanted}/.default offline_access`,
  };
}

/** Only OneDrive's own https links are kept; anything else is dropped rather than rendered. */
export function safeOneDriveLink(link: string | null): string | null {
  if (!link || link.length > 512) return null;
  try {
    const url = new URL(link);
    const host = url.hostname;
    return url.protocol === 'https:' &&
      (host === 'onedrive.live.com' || host === '1drv.ms' || host.endsWith('.sharepoint.com'))
      ? link
      : null;
  } catch {
    return null;
  }
}

export function toOneDriveStatusView(
  config: OneDriveConfig | null,
  row: StorageConnectionRow | undefined,
  canManage: boolean,
  effective: StorageMode,
): OneDriveStatusView {
  const live = row && row.status !== 'disconnected' ? row : undefined;
  const status = !live ? 'not_connected' : live.status === 'error' ? 'error' : 'connected';
  return {
    configured: config !== null,
    pickerAvailable: config !== null && status === 'connected',
    storageMode: effective,
    oneDrive: {
      status,
      accountEmail: canManage ? (live?.accountEmail ?? null) : null,
      folderPath: live ? oneDriveFolderPath(live.onedriveDriveName) : null,
      driveName: live?.onedriveDriveName ?? null,
      librariesEnabled: live ? grantsLibraries(live.grantedScopes) : false,
    },
  };
}

/**
 * Where the company's files go, as the Storage screen shows it: `<chosen place>/TManage/` (the
 * picked folder, library or drive, kept in `onedrive_drive_name`), or `TManage/` without one.
 */
export function oneDriveFolderPath(locationName: string | null | undefined): string {
  const location = locationName?.trim();
  return location ? `${location}/${ONEDRIVE_ROOT_FOLDER_NAME}/` : `${ONEDRIVE_ROOT_FOLDER_NAME}/`;
}

function toView(row: OneDriveAttachmentRow): OneDriveAttachmentView {
  return {
    id: row.id,
    workItemId: row.workItemId,
    driveId: row.driveId,
    itemId: row.itemId,
    name: row.name,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes ?? null,
    webUrl: row.webUrl ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
