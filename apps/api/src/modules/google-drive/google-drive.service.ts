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
  type CloudFolderChild,
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
  GoogleDriveAttachmentRow,
  StorageConnectionRow,
  WorkItemRow,
} from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { SeedCipher } from '../identity/seed-cipher.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import {
  DRIVE_CALLBACK_PATH,
  DRIVE_MY_DRIVE_NAME,
  DRIVE_ROOT_FOLDER_NAME,
  DriveFileNotFoundError,
  DriveGrantRevokedError,
  DriveNoAccessError,
  FOLDER_MIME_TYPE,
  driveAuthorizationUrl,
  isGoogleNativeFormat,
  driveFolderName,
  driveStateMatches,
  newDriveFlow,
  type DriveConfig,
  type DriveFile,
  type DriveFlow,
  type DriveTransport,
} from './google-drive.google.js';
import { GoogleDriveRepository, type AttachedItem } from './google-drive.repository.js';
import {
  googleRootOwner,
  pendingHandoverFor,
  toRootOwnerView,
  type RootOwnerView,
} from '../storage-root/root-owner.js';
import {
  databaseStorageModes,
  type StorageMode,
  type StorageModeStore,
} from './storage-mode.repository.js';

/**
 * Google Drive as company storage — the application service.
 *
 * Network calls to Google never run inside a database transaction: the connection is read, Google
 * is called, and the result is written in a short transaction of its own. Every write that changes
 * where a company's files live, or links a Drive file into a work item, is audited in the same
 * transaction as the change.
 *
 * The refresh token is decrypted only in {@link accessToken}, only to obtain a short-lived access
 * token, and it never leaves this file. A token Google refuses moves the connection to `error`
 * (the Storage screen's "not reachable — Reconnect" state).
 */

export interface StorageStatusView {
  /** False when the Google client is not set in the environment: the feature is off. */
  readonly configured: boolean;
  /** Whether the browser file picker can be offered (needs the picker key too). */
  readonly pickerAvailable: boolean;
  /** 0236. The company's one effective storage, across providers (Google Drive or OneDrive). */
  readonly storageMode: StorageMode;
  readonly googleDrive: {
    readonly status: 'not_connected' | 'connected' | 'error';
    /** Shown to people who manage the organization only. */
    readonly accountEmail: string | null;
    readonly folderPath: string | null;
    readonly sharedDriveName: string | null;
    /** 51-17. Who owns the root (the steer) and the hand-over state; null when not connected. */
    readonly rootOwner: RootOwnerView | null;
  };
}

export interface DriveAttachmentView {
  readonly id: string;
  readonly workItemId: string;
  readonly driveFileId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
  readonly webViewLink: string | null;
  readonly createdAt: string;
}

/**
 * NV10. `google`: Google's own picker with the company connection's `drive.file` token, only for
 * a caller who can already read every project (org-wide scope). `scoped`: no token at all; the
 * browser lists the project's TManage folders through {@link GoogleDriveService.projectFiles}.
 */
export type PickerSessionView = GooglePickerSessionView | ScopedPickerSessionView;

/** NV10. The `google` picker session: only for a caller who can read every project. */
export interface GooglePickerSessionView {
  readonly mode: 'google';
  readonly accessToken: string;
  readonly apiKey: string;
  readonly appId: string | null;
  readonly rootFolderId: string | null;
}

/** NV10. The `scoped` picker session: no token; the project's own folders only. */
export interface ScopedPickerSessionView {
  readonly mode: 'scoped';
  readonly projectId: string;
}

/** NV10. One entry of the server-side project file list. No download link, no token. */
export interface ProjectFileView {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number | null;
  readonly modifiedTime: string | null;
  readonly isFolder: boolean;
}

export interface ProjectFolderView {
  readonly id: string;
  readonly kind: 'project' | 'work_item';
  readonly name: string;
}

export interface ProjectFilesView {
  /** The folder listed (the project folder by default); null when the project has none yet. */
  readonly folderId: string | null;
  readonly files: readonly ProjectFileView[];
  /** Only this project's own TManage folders: the only ones the list can open. */
  readonly folders: readonly ProjectFolderView[];
  readonly nextPageToken: string | null;
}

/** M04. How far up the attach check follows a file's unknown parents before it refuses. */
export const ORIGIN_MAX_HOPS = 8;
/** M04. How many parents per level the walk follows (Drive gives a file one parent today). */
const ORIGIN_MAX_BREADTH = 5;

export interface SettingsInput {
  readonly storageMode?: 'tmanage' | 'google_drive';
  /** `my_drive`, or a folder the person picked (possibly inside a Shared Drive). */
  readonly location?: { readonly kind: 'my_drive' } | { readonly kind: 'folder'; folderId: string };
}

export interface GoogleDriveServiceDeps {
  readonly database: TenantDatabase;
  readonly audit: AuditService;
  readonly transport: DriveTransport;
  readonly cipher: SeedCipher;
  readonly config: DriveConfig | null;
  /** `API_PUBLIC_URL`: the OAuth redirect is `${apiPublicUrl}/v1/integrations/google-drive/callback`. */
  readonly apiPublicUrl: string;
  readonly repository?: GoogleDriveRepository;
  readonly workItems?: Pick<WorkItemsRepository, 'findById'>;
  /** NV10. The picker's target project, for its relation check. */
  readonly projects?: Pick<ProjectsRepository, 'findById'>;
  /** 0236. The one-mode-per-organization store (shared with OneDrive). */
  readonly storageModes?: StorageModeStore;
}

/** The additional data binding a stored refresh token to its organization. */
export function tokenBinding(organizationId: string): { userId: string } {
  return { userId: `storage:${organizationId}:google_drive` };
}

function conflict(
  detail: 'not_configured' | 'not_connected' | 'unreachable' | 'root_not_shared',
): ApiError {
  const messages = {
    not_configured: 'Google Drive is not set up for TManage yet',
    not_connected: 'Google Drive is not connected',
    unreachable: 'Google Drive is not reachable. Reconnect it in Storage',
    root_not_shared: 'This Google account cannot open the company TManage folder',
  } as const;
  return new ApiError(409, 'conflict', messages[detail], [{ field: 'storage', message: detail }]);
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

export class GoogleDriveService implements CloudFolderDrive {
  private readonly repository: GoogleDriveRepository;
  private readonly workItems: Pick<WorkItemsRepository, 'findById'>;
  private readonly projects: Pick<ProjectsRepository, 'findById'>;
  private readonly modes: StorageModeStore;

  constructor(private readonly deps: GoogleDriveServiceDeps) {
    this.repository = deps.repository ?? new GoogleDriveRepository();
    this.workItems = deps.workItems ?? new WorkItemsRepository();
    this.projects = deps.projects ?? new ProjectsRepository();
    this.modes = deps.storageModes ?? databaseStorageModes;
  }

  get redirectUri(): string {
    return `${this.deps.apiPublicUrl.replace(/\/+$/, '')}${DRIVE_CALLBACK_PATH}`;
  }

  // ── Status and settings ───────────────────────────────────────────────────

  async status(context: TenantContext, canManage: boolean): Promise<StorageStatusView> {
    const { row, mode } = await this.deps.database.read(context, async (runner) => ({
      row: await this.repository.findConnection(runner, context),
      mode: await this.modes.effective(runner, context),
    }));
    return toStatusView(this.deps.config, row, canManage, mode, context.userId);
  }

  /** Begin connecting: the Google consent URL and the flow to seal into the cookie. */
  startConnect(
    context: TenantContext,
    organizationSlug: string,
  ): { readonly url: string; readonly flow: DriveFlow } {
    const config = this.requireConfig();
    const flow = newDriveFlow({
      organizationId: context.organizationId,
      organizationSlug,
      userId: context.userId,
    });
    return {
      url: driveAuthorizationUrl({
        clientId: config.clientId,
        redirectUri: this.redirectUri,
        flow,
      }),
      flow,
    };
  }

  /**
   * Finish connecting. The flow must have been started by this person in this organization, and
   * the `state` Google returned must equal the cookie's — a code replayed into another browser,
   * another organization or another person's session is refused before Google is called.
   */
  async completeConnect(
    context: TenantContext,
    flow: DriveFlow | undefined,
    input: { code: unknown; state: unknown },
  ): Promise<StorageStatusView> {
    const config = this.requireConfig();
    if (
      !flow ||
      flow.organizationId !== context.organizationId ||
      flow.userId !== context.userId ||
      !driveStateMatches(flow, input.state) ||
      typeof input.code !== 'string' ||
      input.code === '' ||
      input.code.length > 2048
    ) {
      throw new ApiError(400, 'validation_failed', 'The Google sign-in could not be completed');
    }
    const tokens = await this.google(() =>
      this.deps.transport.exchangeCode({
        code: input.code as string,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: this.redirectUri,
        verifier: flow.verifier,
      }),
    );
    if (!tokens.refreshToken) throw conflict('unreachable');
    const handover = pendingHandoverFor(await this.readConnection(context), context.userId);
    if (handover) {
      return this.completeHandover(context, handover, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        email: tokens.email,
      });
    }
    const rootFolderId = await this.google(() =>
      this.deps.transport.ensureFolder(tokens.accessToken, {
        name: DRIVE_ROOT_FOLDER_NAME,
        parentId: null,
        driveId: null,
      }),
    );
    const refreshTokenEnc = this.deps.cipher.encrypt(
      tokens.refreshToken,
      tokenBinding(context.organizationId),
    );
    const { row, mode } = await this.deps.database.transaction(context, async (tx) => {
      await this.repository.saveConnected(tx, context, {
        accountEmail: tokens.email,
        refreshTokenEnc,
        rootFolderId,
        connectedByUserId: context.userId,
      });
      const saved = await this.repository.findConnection(tx, context);
      await this.deps.audit.record(tx, context, {
        action: 'storage_connection.connected',
        result: 'allowed',
        objectId: saved?.id ?? null,
        metadata: { provider: 'google_drive' },
      });
      return { row: saved, mode: await this.modes.effective(tx, context) };
    });
    return toStatusView(this.deps.config, row, true, mode, context.userId);
  }

  /**
   * 51-17. The admin named in a hand-over finished their own Google consent: their token replaces
   * the leaving person's, and the root stays where it is. Their account must already open the
   * root (a Shared Drive they belong to, or a folder shared with them); otherwise nothing changes.
   * The old token is revoked at Google (best effort) only after the new one is stored.
   */
  private async completeHandover(
    context: TenantContext,
    connection: StorageConnectionRow & { rootFolderId: string },
    tokens: { accessToken: string; refreshToken: string; email: string | null },
  ): Promise<StorageStatusView> {
    try {
      await this.deps.transport.getFile(tokens.accessToken, connection.rootFolderId, 'parents');
    } catch (error) {
      if (error instanceof DriveFileNotFoundError || error instanceof DriveNoAccessError) {
        throw conflict('root_not_shared');
      }
      throw conflict('unreachable');
    }
    const refreshTokenEnc = this.deps.cipher.encrypt(
      tokens.refreshToken,
      tokenBinding(context.organizationId),
    );
    const { row, mode } = await this.deps.database.transaction(context, async (tx) => {
      await this.repository.update(tx, context, connection.id, {
        status: 'connected',
        accountEmail: tokens.email,
        refreshTokenEnc,
        lastErrorCode: null,
        connectedByUserId: context.userId,
        handoverToUserId: null,
        handedOverAt: new Date(),
      });
      await this.deps.audit.record(tx, context, {
        action: 'storage_connection.handover',
        result: 'allowed',
        objectId: connection.id,
        metadata: {
          provider: 'google_drive',
          from_user_id: connection.connectedByUserId,
          to_user_id: context.userId,
        },
      });
      return {
        row: await this.repository.findConnection(tx, context),
        mode: await this.modes.effective(tx, context),
      };
    });
    if (connection.refreshTokenEnc) {
      try {
        await this.deps.transport.revoke(
          this.deps.cipher.decrypt(
            connection.refreshTokenEnc,
            tokenBinding(context.organizationId),
          ),
        );
      } catch {
        // The old token is no longer stored either way.
      }
    }
    return toStatusView(this.deps.config, row, true, mode, context.userId);
  }

  async updateSettings(context: TenantContext, input: SettingsInput): Promise<StorageStatusView> {
    const connection = await this.readConnection(context);
    const patch: Parameters<GoogleDriveRepository['update']>[3] = {};

    if (input.location) {
      const live = this.requireLive(connection);
      const accessToken = await this.accessToken(context, live);
      if (input.location.kind === 'my_drive') {
        patch.rootFolderId = await this.google(() =>
          this.deps.transport.ensureFolder(accessToken, {
            name: DRIVE_ROOT_FOLDER_NAME,
            parentId: null,
            driveId: null,
          }),
        );
        patch.sharedDriveId = null;
        patch.sharedDriveName = null;
        patch.locationName = DRIVE_MY_DRIVE_NAME;
        patch.rootOwnerKind = googleRootOwner(null);
      } else {
        const folderId = input.location.folderId;
        const folder = await this.google(() => this.deps.transport.getFile(accessToken, folderId));
        if (folder.mimeType !== FOLDER_MIME_TYPE) throw invalid('folderId', 'must be a folder');
        patch.rootFolderId = await this.google(() =>
          this.deps.transport.ensureFolder(accessToken, {
            name: DRIVE_ROOT_FOLDER_NAME,
            parentId: folder.id,
            driveId: folder.driveId,
          }),
        );
        patch.sharedDriveId = folder.driveId;
        patch.rootOwnerKind = googleRootOwner(folder.driveId);
        patch.sharedDriveName = folder.driveId
          ? driveFolderName(folder.name, 'Shared Drive')
          : null;
        // 0238. The picked folder's own name, so the Storage screen shows where files go.
        patch.locationName = driveFolderName(
          folder.name,
          folder.driveId ? 'Shared Drive' : 'Folder',
        );
      }
    }
    // 0236. The mode itself is written by `switchTo` below, which also resets OneDrive's row.
    if (input.storageMode === 'google_drive') this.requireLive(connection);
    if (!connection) {
      // Nothing to change: with no connection the company is on TManage storage already.
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
          provider: 'google_drive',
          storage_mode: effective,
          uses_shared_drive: (patch.sharedDriveId ?? connection.sharedDriveId) !== null,
        },
      });
      return { row: await this.repository.findConnection(tx, context), mode: effective };
    });
    return toStatusView(this.deps.config, row, true, mode, context.userId);
  }

  /** Disconnect: revoke at Google (best effort), wipe the token, move back to TManage storage. */
  async disconnect(context: TenantContext): Promise<StorageStatusView> {
    const connection = await this.readConnection(context);
    if (!connection || connection.status === 'disconnected') return this.status(context, true);
    if (connection.refreshTokenEnc) {
      try {
        const refreshToken = this.deps.cipher.decrypt(
          connection.refreshTokenEnc,
          tokenBinding(context.organizationId),
        );
        await this.deps.transport.revoke(refreshToken);
      } catch {
        // A token that cannot be opened or revoked is wiped below all the same.
      }
    }
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
        metadata: { provider: 'google_drive' },
      });
      return {
        row: await this.repository.findConnection(tx, context),
        mode: await this.modes.effective(tx, context),
      };
    });
    return toStatusView(this.deps.config, row, true, mode, context.userId);
  }

  // ── Picker, upload and attachments ────────────────────────────────────────

  /**
   * How the browser may choose Drive files.
   *
   * NV10. The connection's access token is company-wide (Google offers no Drive token narrowed to
   * one folder), and once it leaves the server Drive no longer knows about projects. So the raw
   * token leaves only for a caller who could already read every project:
   *  - no target project (the Storage screen's "Change folder"): org-wide scope and `org.manage`,
   *    otherwise 403;
   *  - a target project and org-wide scope: the same `google` session;
   *  - a target project and a project-scoped caller (`file.upload` on it): `scoped`, with no
   *    token — none is minted or refreshed — and the browser lists the project's own TManage
   *    folders through {@link projectFiles}.
   * Never a client or a guest. Each token issued is audited (`drive_picker.session_issued`, the
   * project id, never the token), and {@link attach} still checks where a file lives (V2, M04).
   */
  async pickerSession(
    context: TenantContext,
    principal: Principal,
    projectId?: string,
  ): Promise<PickerSessionView> {
    await this.requirePickerRelation(context, principal, projectId);
    if (projectId === undefined) this.requireOrgManage(context, principal);
    if (projectId !== undefined && !principal.hasOrgWideScope) {
      this.requireLive(await this.readConnection(context));
      return { mode: 'scoped', projectId };
    }
    const config = this.requireConfig();
    if (!config.pickerApiKey) throw conflict('not_configured');
    const live = this.requireLive(await this.readConnection(context));
    const accessToken = await this.accessToken(context, live);
    await this.deps.database.transaction(context, (tx) =>
      this.deps.audit.record(tx, context, {
        action: 'drive_picker.session_issued',
        result: 'allowed',
        objectId: live.id,
        metadata: {
          provider: 'google_drive',
          ...(projectId === undefined ? {} : { project_id: projectId }),
        },
      }),
    );
    return {
      mode: 'google',
      accessToken,
      apiKey: config.pickerApiKey,
      appId: config.projectNumber,
      rootFolderId: live.rootFolderId,
    };
  }

  /**
   * NV10. The server-side file list for a project-scoped person: the children of one of the
   * project's own TManage folders (the project folder by default). A folder outside that set is
   * the same 404 an unknown id gives, before Google is asked; the token never leaves the server.
   */
  async projectFiles(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    input: { readonly folderId?: string; readonly pageToken?: string },
  ): Promise<ProjectFilesView> {
    await this.requirePickerRelation(context, principal, projectId);
    const live = this.requireLive(await this.readConnection(context));
    const known = await this.deps.database.read(context, (runner) =>
      this.repository.listProjectFolders(runner, context, projectId, live.rootFolderId),
    );
    // A work-item folder is listed only when its item is readable to the caller.
    const visible = known.filter(
      (folder) =>
        folder.item === null ||
        authorize({ principal, capability: 'work.read', resource: resourceOf(folder.item) })
          .allowed,
    );
    if (
      input.folderId !== undefined &&
      !visible.some((folder) => folder.driveFolderId === input.folderId)
    ) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    const folders = visible.map((folder) => ({
      id: folder.driveFolderId,
      kind: folder.kind,
      name: folder.name,
    }));
    const projectFolder = visible.find((folder) => folder.kind === 'project');
    if (!projectFolder) return { folderId: null, files: [], folders, nextPageToken: null };
    const folderId = input.folderId ?? projectFolder.driveFolderId;
    const accessToken = await this.accessToken(context, live);
    const page = await this.google(
      () =>
        this.deps.transport.listChildren(accessToken, {
          parentId: folderId,
          pageToken: input.pageToken ?? null,
        }),
      live.id,
      context,
    );
    return {
      folderId,
      files: page.files.map((file) => ({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        modifiedTime: file.modifiedTime,
        isFolder: file.isFolder,
      })),
      folders,
      nextPageToken: page.nextPageToken,
    };
  }

  async list(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<readonly DriveAttachmentView[]> {
    return this.deps.database.read(context, async (runner) => {
      await this.readableItem(runner, context, principal, workItemId);
      return (await this.repository.listAttachments(runner, context, workItemId)).map(toView);
    });
  }

  /** Attach a Drive file (picked or just uploaded). Idempotent per work item and file. */
  async attach(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    driveFileId: string,
  ): Promise<DriveAttachmentView> {
    const live = this.requireLive(await this.readConnection(context));
    await this.deps.database.read(context, (runner) =>
      this.writableItem(runner, context, principal, workItemId),
    );
    const accessToken = await this.accessToken(context, live);
    // Google answers only for a file this connection may see (`drive.file`): one TManage created
    // or one a person picked. Anything else is the same 404 an unknown id gives.
    const file = await this.google(
      () => this.deps.transport.getFile(accessToken, driveFileId),
      live.id,
      context,
    );
    if (file.mimeType === FOLDER_MIME_TYPE) throw invalid('driveFileId', 'must be a file');
    // M04. Google is asked about the ancestors here, outside the transaction.
    const origin = await this.resolveOrigin(context, live, accessToken, file);

    return this.deps.database.transaction(context, async (tx) => {
      const item = await this.writableItem(tx, context, principal, workItemId);
      await this.requireAttachableOrigin(tx, context, principal, live, item, file, origin);
      const existing = (await this.repository.listAttachments(tx, context, workItemId)).find(
        (row) => row.driveFileId === file.id,
      );
      if (existing) return toView(existing);
      const row = await this.repository.insertAttachment(tx, context, {
        workItemId,
        driveFileId: file.id,
        name: file.name.slice(0, 255),
        mimeType: file.mimeType.slice(0, 190),
        sizeBytes: file.size,
        webViewLink: safeDriveLink(file.webViewLink),
        attachedByUserId: context.userId,
      });
      await this.deps.audit.record(tx, context, {
        action: 'drive_attachment.attached',
        result: 'allowed',
        objectId: row.id,
        metadata: { provider: 'google_drive', work_item_id: workItemId },
      });
      return toView(row);
    });
  }

  /**
   * FIX6 C1. A picked Drive file's bytes, for the server-side import into `projectId`. The caller
   * has already checked the person may add files there; this applies the same origin rule as
   * {@link attach} (another project's TManage folder is a 404) and then downloads with the
   * company connection, at most `maxBytes`. The token never leaves this service.
   */
  async fetchForImport(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    driveFileId: string,
    maxBytes: number,
  ): Promise<FetchedCloudFile> {
    const live = this.requireLive(await this.readConnection(context));
    const accessToken = await this.accessToken(context, live);
    const file = await this.google(
      () => this.deps.transport.getFile(accessToken, driveFileId).catch(goneOrRethrow),
      live.id,
      context,
    );
    if (file.mimeType === FOLDER_MIME_TYPE) throw invalid('fileId', 'must be a file');
    if (isGoogleNativeFormat(file.mimeType)) {
      throw new ApiError(422, 'validation_failed', 'Save this Google file as PDF or DOCX first', [
        { field: 'file', message: 'google_native_format' },
      ]);
    }
    const origin = await this.resolveOrigin(context, live, accessToken, file);
    await this.deps.database.read(context, (runner) =>
      this.requireAttachableOrigin(runner, context, principal, live, { projectId }, file, origin),
    );
    const bytes = await this.google(
      () =>
        this.deps.transport
          .downloadFile(accessToken, file.id, maxBytes)
          .catch((error: unknown) => {
            if (error instanceof DriveNoAccessError) throw cloudNoAccess();
            return goneOrRethrow(error);
          })
          .catch(rethrowTooLarge),
      live.id,
      context,
    );
    return {
      provider: 'google_drive',
      externalId: file.id,
      name: file.name.slice(0, 255),
      mimeType: file.mimeType.slice(0, 190),
      bytes,
    };
  }

  /**
   * FIX6 C3. A Drive folder about to be attached to a work item of `projectId`: it must be a
   * folder Google shows to the company connection, and attaching it must not reach into TManage's
   * own tree beyond this project. The TManage root, a folder that holds it, and a folder under
   * another project's TManage folder are the same 404 an unknown id gives.
   */
  async describeFolder(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    ref: CloudFolderRef,
  ): Promise<{ readonly name: string }> {
    const live = this.requireLive(await this.readConnection(context));
    const accessToken = await this.accessToken(context, live);
    const folder = await this.google(
      () => this.deps.transport.getFile(accessToken, ref.folderId),
      live.id,
      context,
    );
    if (folder.mimeType !== FOLDER_MIME_TYPE) throw invalid('folderId', 'must be a folder');
    const notFound = () => new ApiError(404, 'not_found', MESSAGES.notFound);
    if (folder.id === live.rootFolderId) throw notFound();
    const root = await this.google(
      () => this.deps.transport.getFile(accessToken, live.rootFolderId, 'parents'),
      live.id,
      context,
    );
    const parentsOf = this.parentsReader(context, live, accessToken);
    if (await isInsideFolder(folder.id, root.parents, parentsOf)) throw notFound();
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
    const accessToken = await this.accessToken(context, live);
    let parentId = ref.folderId;
    if (input.parentId !== null && input.parentId !== ref.folderId) {
      const sub = await this.childInside(context, live, accessToken, ref, input.parentId);
      if (sub.mimeType !== FOLDER_MIME_TYPE) throw invalid('parentId', 'must be a folder');
      parentId = sub.id;
    }
    const page = await this.google(
      () => this.deps.transport.listChildren(accessToken, { parentId, pageToken: input.pageToken }),
      live.id,
      context,
    );
    return { files: page.files, nextPageToken: page.nextPageToken };
  }

  /** FIX6 C3b. A child's metadata, only once it is proven to sit inside the attached folder. */
  async inspectChild(
    context: TenantContext,
    ref: CloudFolderRef,
    childId: string,
  ): Promise<CloudFolderChild> {
    const live = this.requireLive(await this.readConnection(context));
    const accessToken = await this.accessToken(context, live);
    const file = await this.childInside(context, live, accessToken, ref, childId);
    return {
      id: file.id,
      name: file.name.slice(0, 255),
      mimeType: file.mimeType.slice(0, 190),
      size: file.size,
      modifiedTime: file.modifiedTime ?? null,
      isFolder: file.mimeType === FOLDER_MIME_TYPE,
    };
  }

  /** FIX6 C3. A child's bytes, only once it is proven to sit inside the attached folder. */
  async fetchFromFolder(
    context: TenantContext,
    ref: CloudFolderRef,
    childId: string,
    maxBytes: number,
  ): Promise<FetchedCloudFile> {
    const live = this.requireLive(await this.readConnection(context));
    const accessToken = await this.accessToken(context, live);
    const file = await this.childInside(context, live, accessToken, ref, childId);
    if (file.mimeType === FOLDER_MIME_TYPE) throw invalid('itemId', 'must be a file');
    if (isGoogleNativeFormat(file.mimeType)) {
      throw new ApiError(422, 'validation_failed', 'Save this Google file as PDF or DOCX first', [
        { field: 'file', message: 'google_native_format' },
      ]);
    }
    const bytes = await this.google(
      () =>
        this.deps.transport
          .downloadFile(accessToken, file.id, maxBytes)
          .catch((error: unknown) => {
            if (error instanceof DriveNoAccessError) throw cloudNoAccess();
            return goneOrRethrow(error);
          })
          .catch(rethrowTooLarge),
      live.id,
      context,
    );
    return {
      provider: 'google_drive',
      externalId: file.id,
      name: file.name.slice(0, 255),
      mimeType: file.mimeType.slice(0, 190),
      bytes,
    };
  }

  /** FIX6 C3. The child, when its parents lead up to the attached folder; a 404 otherwise. */
  private async childInside(
    context: TenantContext,
    live: StorageConnectionRow & { rootFolderId: string },
    accessToken: string,
    ref: CloudFolderRef,
    childId: string,
  ): Promise<DriveFile> {
    const file = await this.google(
      () => this.deps.transport.getFile(accessToken, childId),
      live.id,
      context,
    );
    const parentsOf = this.parentsReader(context, live, accessToken);
    if (
      file.id === ref.folderId ||
      !(await isInsideFolder(ref.folderId, file.parents, parentsOf))
    ) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return file;
  }

  /** An ancestor's parents for the descendant walk; one Google will not show ends the branch. */
  private parentsReader(
    context: TenantContext,
    live: StorageConnectionRow & { rootFolderId: string },
    accessToken: string,
  ): (id: string) => Promise<readonly string[]> {
    return async (id) => {
      const parents = await this.ancestorParents(context, live, accessToken, id);
      return parents === 'hidden' ? [] : parents;
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
      if (changed === 0) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      await this.deps.audit.record(tx, context, {
        action: 'drive_attachment.removed',
        result: 'allowed',
        objectId: attachmentId,
        metadata: { provider: 'google_drive', work_item_id: workItemId },
      });
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * M04. Find the nearest level of the file's ancestry that holds a TManage folder or root.
   * Level 0 is the file's own parents; while no id on a level is known, the next level is asked
   * of Google (`parents` only), at most {@link ORIGIN_MAX_HOPS} times. Returns that level;
   * `outside` when the walk reaches a parentless top (or the connected account's My Drive root, or
   * the file's shared drive) with no TManage folder on the way; `unresolved` when the hops run out
   * first, or when Google refuses to show an ancestor (W12-2: under `drive.file` a hidden folder
   * may be another project's subfolder, so the attach check then refuses: fail closed).
   */
  private async resolveOrigin(
    context: TenantContext,
    live: StorageConnectionRow & { rootFolderId: string },
    accessToken: string,
    file: DriveFile,
  ): Promise<AttachOrigin> {
    let level: readonly string[] = file.parents.slice(0, ORIGIN_MAX_BREADTH);
    const seen = new Set<string>([file.id]);
    let myDriveRoot: Promise<string | null> | undefined;
    const isTop = async (id: string) => {
      if (file.driveId !== null && id === file.driveId) return true;
      myDriveRoot ??= this.myDriveRootId(context, live, accessToken);
      return (await myDriveRoot) === id;
    };
    for (let hop = 0; ; hop += 1) {
      if (level.length === 0) return { kind: 'outside' };
      if (await this.levelIsKnown(context, live, level)) return { kind: 'tmanage', level };
      if (hop === ORIGIN_MAX_HOPS) return { kind: 'unresolved' };
      for (const id of level) seen.add(id);
      const next = new Set<string>();
      for (const id of level) {
        const parents = await this.ancestorParents(context, live, accessToken, id);
        if (parents === 'hidden') {
          // W12-2. Only a top Google will not describe (the account's own My Drive root, the
          // file's shared drive) ends the walk as "outside"; any other unseen folder leaves the
          // origin unresolved, and the attach is refused.
          if (await isTop(id)) continue;
          return { kind: 'unresolved' };
        }
        for (const parent of parents) {
          // A cycle cannot hold the walk: an id already seen adds nothing.
          if (!seen.has(parent) && next.size < ORIGIN_MAX_BREADTH) next.add(parent);
        }
      }
      level = [...next];
    }
  }

  private async levelIsKnown(
    context: TenantContext,
    live: StorageConnectionRow & { rootFolderId: string },
    level: readonly string[],
  ): Promise<boolean> {
    if (level.includes(live.rootFolderId)) return true;
    return this.deps.database.read(context, async (runner) => {
      if ((await this.repository.findKnownFolders(runner, context, level)).length > 0) return true;
      return (await this.repository.knownRootsAmong(runner, context, level)).length > 0;
    });
  }

  /** The parents of one ancestor folder; `hidden` when Google does not show it to this connection. */
  private async ancestorParents(
    context: TenantContext,
    live: StorageConnectionRow,
    accessToken: string,
    folderId: string,
  ): Promise<readonly string[] | 'hidden'> {
    try {
      return (await this.deps.transport.getFile(accessToken, folderId, 'parents')).parents;
    } catch (error) {
      if (error instanceof DriveFileNotFoundError) return 'hidden';
      return this.google<readonly string[]>(() => Promise.reject(error), live.id, context);
    }
  }

  /** W12-2. The id of the connected account's My Drive root (Google's `root` alias), or null. */
  private async myDriveRootId(
    context: TenantContext,
    live: StorageConnectionRow,
    accessToken: string,
  ): Promise<string | null> {
    try {
      return (await this.deps.transport.getFile(accessToken, 'root', 'parents')).id;
    } catch (error) {
      if (error instanceof DriveFileNotFoundError) return null;
      return this.google<string | null>(() => Promise.reject(error), live.id, context);
    }
  }

  /**
   * V2 and M04. The company connection can read every file TManage made or anyone picked, in
   * every project, so Google answering is not enough to link a file into this item. The nearest
   * level of the file's ancestry that holds a TManage folder or root decides
   * ({@link resolveOrigin}). A file may be attached when
   *  (a) that level holds one of the destination project's TManage folders (the project folder or
   *      a work-item folder of an item now in that project) and no other TManage folder or root,
   *      or
   *  (b) no ancestor is a TManage folder or root (a person's own picked file) and it is not
   *      already linked to an item the caller cannot read.
   * Anything else — a file under another project's folder at any depth, in the bare root, one
   * whose ancestry is deeper than the walk, or one linked only where the caller cannot see — is
   * the same 404 an unknown id gives, before any insert.
   */
  private async requireAttachableOrigin(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    live: StorageConnectionRow & { rootFolderId: string },
    item: Pick<WorkItemRow, 'projectId'>,
    file: DriveFile,
    origin: AttachOrigin,
  ): Promise<void> {
    const notFound = () => new ApiError(404, 'not_found', MESSAGES.notFound);
    if (origin.kind === 'unresolved') throw notFound();
    const parents = origin.kind === 'tmanage' ? origin.level : file.parents;
    if (parents.length > 0) {
      const folders = await this.repository.findKnownFolders(runner, context, parents);
      const roots = new Set([
        live.rootFolderId,
        ...(await this.repository.knownRootsAmong(runner, context, parents)),
      ]);
      const insideTManage = folders.length > 0 || parents.some((id) => roots.has(id));
      if (insideTManage) {
        const known = new Map(folders.map((folder) => [folder.driveFolderId, folder]));
        const here = (id: string) => known.get(id)?.projectId === item.projectId;
        const elsewhere = (id: string) => !here(id) && (known.has(id) || roots.has(id));
        if (parents.some(here) && !parents.some(elsewhere)) return;
        throw notFound();
      }
    }
    // The walk found TManage ancestry that is no longer known: never treat it as a personal file.
    if (origin.kind === 'tmanage') throw notFound();
    const linked = await this.repository.attachedItemsForFile(runner, context, file.id);
    for (const row of linked) {
      if (!authorize({ principal, capability: 'work.read', resource: resourceOf(row) }).allowed) {
        throw notFound();
      }
    }
  }

  private requireConfig(): DriveConfig {
    if (!this.deps.config) throw conflict('not_configured');
    return this.deps.config;
  }

  private requireLive(
    connection: StorageConnectionRow | undefined,
  ): StorageConnectionRow & { refreshTokenEnc: string; rootFolderId: string } {
    this.requireConfig();
    if (!connection || connection.status === 'disconnected' || !connection.refreshTokenEnc) {
      throw conflict('not_connected');
    }
    if (connection.status === 'error' || !connection.rootFolderId) throw conflict('unreachable');
    return connection as StorageConnectionRow & { refreshTokenEnc: string; rootFolderId: string };
  }

  private readConnection(context: TenantContext): Promise<StorageConnectionRow | undefined> {
    return this.deps.database.read(context, (runner) =>
      this.repository.findConnection(runner, context),
    );
  }

  /** A fresh access token; a refused grant moves the connection to `error`. */
  private async accessToken(
    context: TenantContext,
    connection: StorageConnectionRow & { refreshTokenEnc: string },
  ): Promise<string> {
    const config = this.requireConfig();
    const refreshToken = this.deps.cipher.decrypt(
      connection.refreshTokenEnc,
      tokenBinding(context.organizationId),
    );
    return this.google(
      () =>
        this.deps.transport.refreshAccessToken({
          refreshToken,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
        }),
      connection.id,
      context,
    );
  }

  /** Run a Google call; a refused grant marks the connection `error`, anything else is a 409. */
  private async google<T>(
    work: () => Promise<T>,
    connectionId?: string,
    context?: TenantContext,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DriveFileNotFoundError) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      if (error instanceof DriveGrantRevokedError && connectionId && context) {
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

  /** NV10. The raw token without a target project is for people who manage the company only. */
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

  /** NV10. Refuses with 403 (or 404 for an unknown project) before any token is minted. */
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
    if (!project) throw new ApiError(404, 'not_found', MESSAGES.notFound);
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
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
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

/** FIX6 C1. On the import path a file Google no longer shows is "gone", not a bare 404. */
function goneOrRethrow(error: unknown): never {
  if (error instanceof DriveFileNotFoundError) throw cloudFileGone();
  throw error;
}

/** M04. Where the attach check found the file's nearest TManage ancestry. */
type AttachOrigin =
  | { readonly kind: 'tmanage'; readonly level: readonly string[] }
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

/** Only Google's own https links are kept; anything else is dropped rather than rendered. */
export function safeDriveLink(link: string | null): string | null {
  if (!link || link.length > 512) return null;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' &&
      (url.hostname === 'drive.google.com' || url.hostname === 'docs.google.com')
      ? link
      : null;
  } catch {
    return null;
  }
}

export function toStatusView(
  config: DriveConfig | null,
  row: StorageConnectionRow | undefined,
  canManage: boolean,
  /** 0236. The organization's effective mode across providers; without it, this row's own. */
  effective?: StorageMode,
  /** 51-17. The person reading, for "you were asked to take over". */
  viewerUserId: string | null = null,
): StorageStatusView {
  const live = row && row.status !== 'disconnected' ? row : undefined;
  const status = !live ? 'not_connected' : live.status === 'error' ? 'error' : 'connected';
  return {
    configured: config !== null,
    pickerAvailable: config?.pickerApiKey != null && status === 'connected',
    storageMode:
      effective ?? (live && live.storageMode === 'google_drive' ? 'google_drive' : 'tmanage'),
    googleDrive: {
      status,
      accountEmail: canManage ? (live?.accountEmail ?? null) : null,
      folderPath: live ? driveFolderPath(live.locationName) : null,
      sharedDriveName: live?.sharedDriveName ?? null,
      rootOwner: toRootOwnerView(live, viewerUserId, canManage),
    },
  };
}

/**
 * 0238. Where the company's files go, as the Storage screen shows it: `<location>/TManage/`, or
 * `TManage/` for a row saved before the location's name was kept.
 */
export function driveFolderPath(locationName: string | null | undefined): string {
  const location = locationName?.trim();
  return location ? `${location}/${DRIVE_ROOT_FOLDER_NAME}/` : `${DRIVE_ROOT_FOLDER_NAME}/`;
}

function toView(row: GoogleDriveAttachmentRow): DriveAttachmentView {
  return {
    id: row.id,
    workItemId: row.workItemId,
    driveFileId: row.driveFileId,
    name: row.name,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes ?? null,
    webViewLink: row.webViewLink ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
