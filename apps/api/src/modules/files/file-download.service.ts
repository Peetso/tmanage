import { authorize, isServableVersion } from '@tmanage/domain';
import type { AuditAction, AuditMetadata, Principal } from '@tmanage/domain';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { ByteRange, ObjectStore, OpenedObject } from '@tmanage/storage';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { FileClientRelation } from './file-client-relation.js';
import { mayDownloadFor } from './purpose-policy.js';
import { readDownloadScanPolicy } from '../tenancy/download-scan-policy.js';
import { awaitingScan, ClientFileSharing } from './client-file-sharing.js';
import type { ScannerPresence } from '../tenancy/download-scan-policy.js';
import { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import type { FileAssetRow, FileVersionRow, ProjectRow } from '../../common/database/schema.js';
import { ProviderObjectUnavailableError, VersionStore } from './provider-objects.js';
import type { ProviderObjectSources } from './provider-objects.js';

/**
 * FILE-002 slice C — the download gate.
 *
 * The one read path that hands file bytes to a principal. `23-ERD` §10: a file is
 * inaccessible until `ready`; `25-AUTHORIZATION` §5–§6: every client read matches
 * organization, membership, client organization, relation and version state in one
 * decision; `04-SECURITY-PRIVACY` §5: no client discovers another client organization's
 * file; `26-THREAT-MODELS` §5: quarantine is never served, keys never leave the server.
 *
 * ## The order of the gate, and why every refusal is one 404
 *
 * 1. The row and its **latest** version, in one query (a replacement version that is still
 *    in quarantine must not be served under an asset that went `ready` on its first).
 * 2. The purpose table ({@link mayDownloadFor}): which purposes a principal kind may ask for.
 * 3. For a client, the relation ({@link FileClientRelation}) — the **request row** a request file
 *    hangs off (its project and its client organization), never the asset alone: an internal
 *    upload carries no client organization, and `authorize()`'s rule 7 is then a no-op. R4 slice
 *    4 adds a published deliverable version's file and the other versions of a reachable chain.
 * 4. `authorize()` with the project's true lifecycle: an archived project is readable by
 *    internal principals and by no client (rule 6).
 * 5. {@link isServableVersion}: `ready`, `clean`, `private` — three facts, not one. The
 *    0019 trigger guards the transition into `ready`; this guards the read.
 * 6. The object is opened in the `private` zone — the literal, never a zone read from the
 *    row — and its size is held to the version's, as the scanner's read is.
 *
 * Every refusal before step 5 is `404 not_found` with the same body, and the cause is on the
 * audit row's `audit_code` alone (`file_asset.downloaded`, `denied`): a caller must not learn
 * whether an id exists or is another client's. Step 5 runs only for a caller already authorized
 * for the file (who sees its status in the list anyway), so it answers a typed `409` —
 * `pending_scan` or `blocked` (CQ-09). A successful download writes one
 * `allowed` row before the first byte leaves — `12-PERMISSION-MATRIX` §12's "restricted
 * export download" is auditable or it does not happen.
 *
 * ## What is not here
 *
 * No signed URL (`25` §96's wording): the bytes are proxied through the authenticated tenant
 * route, so membership is re-resolved on every request and a suspension holds at once
 * (`27` AUTH-12). An uploader gets no carve-out before `ready`.
 *
 * ## R4 slice 4
 *
 * - {@link FileDownloadService.resolve} is steps 1–5 without opening anything, so the viewer
 *   manifest and the preview-content route refuse by exactly this gate.
 * - An HTTP `Range` (`bytes=a-b`, one range) is honoured: the store streams just those bytes and
 *   the answer is `206`. A range that is malformed, multiple or past the end is ignored and the
 *   whole file is sent (RFC 9110 §14.2 lets a server ignore Range).
 * - `?inline=1` is honoured only for `video/*`, `audio/*` and `image/gif` — what a `<video>`,
 *   `<audio>` or `<img>` plays from the original. Everything else stays `attachment`.
 */
export interface FileDownload {
  readonly stream: OpenedObject['stream'];
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly fileName: string;
  /**
   * B3. `clean` for a file the scan cleared; `not_scanned` for one served before any clean scan
   * result under the owner's `allow_labeled` policy — the screen labels it. Sent as `x-scan-status`.
   */
  readonly scanStatus: DownloadScanStatus;
  /** R4 slice 4. The bytes sent when a `Range` was honoured (`206`); absent for the whole file. */
  readonly range?: ByteRange;
  /** R4 slice 4. `inline` only for a media type asked inline; `attachment` otherwise. */
  readonly disposition: 'attachment' | 'inline';
}

/** B3. Whether the bytes handed out were cleared by a scan. */
export type DownloadScanStatus = 'clean' | 'not_scanned';

/** R4 slice 4. What a caller may ask of the original's bytes. */
export interface DownloadOptions {
  /** The raw `Range` request header, if any. */
  readonly range?: string | undefined;
  /** `?inline=1` — honoured for {@link mayServeOriginalInline} types only. */
  readonly inline?: boolean;
}

/**
 * R4 slice 4. A file the gate let through steps 1–4: its row, latest version and project, and
 * whether its bytes may be served now (step 5). `servable` carries the zone and the scan label;
 * the other states are the typed `409`s a download answers.
 */
export interface ResolvedFile {
  readonly asset: FileAssetRow;
  readonly version: FileVersionRow | null;
  readonly project: ProjectRow;
  readonly access: FileAccess;
}

export type FileAccess =
  | {
      readonly state: 'servable';
      readonly zone: 'private' | 'quarantine';
      readonly scanStatus: DownloadScanStatus;
    }
  | { readonly state: 'pending_scan' | 'blocked' | 'scan_required_by_policy' };

export const DOWNLOAD_CAPABILITY = 'file.download';

/** Originals a browser may render in place (a player or an animated image), never a document. */
export function mayServeOriginalInline(mimeType: string): boolean {
  return mimeType.startsWith('video/') || mimeType.startsWith('audio/') || mimeType === 'image/gif';
}

/**
 * R4 slice 4. One `bytes=start-end` / `bytes=start-` / `bytes=-suffix` range inside `size`, or
 * `null` (absent, malformed, several ranges, or unsatisfiable — the whole file is sent then).
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange | null {
  if (header === undefined || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const first = match[1] ?? '';
  const last = match[2] ?? '';
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (!Number.isSafeInteger(start) || start >= size) return null;
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end };
}

export class FileDownloadService {
  private readonly relation: FileClientRelation;
  private readonly sharing: ClientFileSharing;
  private readonly versions: VersionStore;

  constructor(
    private readonly database: TenantDatabase,
    private readonly assets: FileAssetsRepository,
    private readonly projects: ProjectsRepository,
    requests: ClientRequestsRepository,
    store: ObjectStore,
    private readonly audit: AuditService,
    /** B3. The configured scanner; absent or `none` means unscanned files are allowed, labelled. */
    private readonly scanner?: ScannerPresence,
    private readonly settings: OrgSettingsRepository = new OrgSettingsRepository(),
    relation?: FileClientRelation,
    /** 57-13a. The company's Drive/OneDrive, for versions held there. */
    providers: ProviderObjectSources = {},
  ) {
    this.versions = new VersionStore(store, providers);
    this.relation = relation ?? new FileClientRelation(requests);
    this.sharing = new ClientFileSharing(scanner, settings);
  }

  /** The studio's door. */
  async download(
    context: TenantContext,
    principal: Principal,
    fileAssetId: string,
    options: DownloadOptions = {},
  ): Promise<FileDownload> {
    assertDoor(principal, 'internal');
    return this.gate(context, principal, fileAssetId, options);
  }

  /** The client's door, under `/portal`. */
  async downloadForClient(
    context: TenantContext,
    principal: Principal,
    fileAssetId: string,
    options: DownloadOptions = {},
  ): Promise<FileDownload> {
    assertDoor(principal, 'client');
    return this.gate(context, principal, fileAssetId, options);
  }

  private async gate(
    context: TenantContext,
    principal: Principal,
    fileAssetId: string,
    options: DownloadOptions,
  ): Promise<FileDownload> {
    const action: AuditAction = 'file_asset.downloaded';
    const { asset, version, access } = await this.resolve(context, principal, fileAssetId, action);
    if (version === null) throw await this.notReady(context, asset.status, action);
    if (access.state === 'scan_required_by_policy') {
      throw await this.blockedByPolicy(context, action);
    }
    if (access.state !== 'servable') throw await this.notReady(context, asset.status, action);
    const { zone, scanStatus } = access;
    const mimeType = version.detectedMimeType;
    if (mimeType === null) throw await this.refuse(context, 'no_detected_type', action);

    const range = parseByteRange(options.range, version.sizeBytes) ?? undefined;
    let opened: OpenedObject;
    try {
      // `private` for a cleared file. An unscanned one still sits in quarantine; the zone is one
      // of the two literals chosen in step 5, never a string read from the row.
      opened = await this.versions.open(context, version, zone, range);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        throw await this.refuse(context, 'private_object_missing', action);
      }
      if (error instanceof ProviderObjectUnavailableError) throw storageUnreachable(error);
      throw error;
    }
    if (opened.sizeBytes !== version.sizeBytes) {
      destroy(opened.stream);
      throw await this.refuse(context, 'size_mismatch', action);
    }

    // A media player asks for many ranges of one file; the first request (from byte 0, or the
    // whole file) is the disclosure, the seeks that follow are not new ones.
    if (range === undefined || range.start === 0) {
      const metadata: AuditMetadata = {
        project_id: asset.projectId,
        purpose: asset.purpose,
        file_version_id: version.id,
        size_bytes: version.sizeBytes,
        principal_kind: principal.kind,
        delivery: 'proxy',
        scan_status: scanStatus,
      };
      try {
        await this.database.transaction(context, (tx) =>
          this.audit.record(tx, context, {
            action,
            objectId: asset.id,
            result: 'allowed',
            actorUserId: principal.userId,
            metadata,
          }),
        );
      } catch (error) {
        destroy(opened.stream);
        throw error;
      }
    }

    return {
      stream: opened.stream,
      mimeType,
      sizeBytes: version.sizeBytes,
      fileName: asset.name,
      scanStatus,
      disposition:
        options.inline === true && mayServeOriginalInline(mimeType) ? 'inline' : 'attachment',
      ...(range ? { range } : {}),
    };
  }

  /**
   * R4 slice 4. Steps 1–5 of the gate without opening the object: the file, its latest version
   * and project for a caller authorized to read it, and whether its bytes may be served now.
   * Every refusal is the one 404 (a denied row under `action`); the scan state is returned, not
   * thrown, so the viewer can say "being checked" instead of failing.
   */
  async resolve(
    context: TenantContext,
    principal: Principal,
    fileAssetId: string,
    action: AuditAction,
  ): Promise<ResolvedFile> {
    const found = await this.database.read(context, (runner) =>
      this.assets.findWithLatestVersion(runner, context, fileAssetId),
    );
    if (!found) throw await this.refuse(context, 'file_not_found', action);
    const { asset, version } = found;
    // FIX5 item 5 (B-N5): a deleted file (in its restore window) serves nothing — no bytes, no
    // preview, no review — and answers exactly like an unknown id.
    if (asset.deletedAt != null) throw await this.refuse(context, 'file_not_found', action);

    if (!mayDownloadFor(principal.kind, asset.purpose)) {
      throw await this.refuse(context, 'purpose_not_downloadable', action);
    }

    let audience = asset.audience;
    if (principal.kind === 'client') {
      const reach = await this.database.read(context, (runner) =>
        this.relation.reach(runner, context, principal, asset),
      );
      if (!reach) {
        throw await this.refuse(
          context,
          asset.purpose === 'deliverable'
            ? 'deliverable_not_published'
            : 'client_relation_mismatch',
          action,
        );
      }
      audience = reach.audience;
    }

    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, asset.projectId),
    );
    if (!project) throw await this.refuse(context, 'project_not_found', action);

    const decision = authorize({
      principal,
      capability: DOWNLOAD_CAPABILITY,
      resource: {
        organizationId: asset.organizationId,
        projectId: asset.projectId,
        audience,
        clientOrganizationId: asset.clientOrganizationId,
        lifecycle: project.archivedAt === null ? 'active' : 'archived',
      },
    });
    if (!decision.allowed) throw await this.refuse(context, decision.code, action);

    const access = await this.accessOf(context, asset, version);
    // FIX6 item 1: a client is served only what the one sharing rule lets reach a client — a
    // virus-scanned file, or a checked one when the owner's "Files clients can receive" allows it.
    // Anything else is the one indistinguishable 404. Members keep `downloads_before_scan`.
    if (principal.kind === 'client' && access.state === 'servable') {
      const state = await this.database.read(context, (runner) =>
        this.sharing.stateOn(runner, context, asset, version),
      );
      if (state === null) throw await this.refuse(context, 'client_scan_required', action);
    }
    return { asset, version, project, access };
  }

  /** Step 5: the version's servable state under the owner's scan policy (B3). */
  private async accessOf(
    context: TenantContext,
    asset: FileAssetRow,
    version: FileVersionRow | null,
  ): Promise<FileAccess> {
    if (version === null) return { state: downloadStateFor(asset.status) };
    if (
      isServableVersion({
        status: asset.status,
        scanVerdict: version.scanVerdict,
        trustZone: version.trustZone,
      })
    ) {
      return { state: 'servable', zone: 'private', scanStatus: 'clean' };
    }
    // B3. A verified file with no scan verdict yet (or `unscanned` under the `none` driver) is
    // the owner's call: `block` keeps a 409, `allow_labeled` serves it labelled `not_scanned`.
    // An infected, rejected, expired or cancelled file — or one not yet verified — never is.
    if (!awaitingScan(asset.status, version)) return { state: downloadStateFor(asset.status) };
    // 52-20a: a file a stranger attached on a public form is served only once scanned clean,
    // whatever the owner's policy — it never passed a person or a provider before staff open it.
    if (asset.purpose === 'form_attachment') return { state: 'scan_required_by_policy' };
    const policy = await readDownloadScanPolicy(
      this.database,
      context,
      this.scanner,
      this.settings,
    );
    if (policy.effective === 'block') return { state: 'scan_required_by_policy' };
    return {
      state: 'servable',
      zone: version.trustZone === 'private' ? 'private' : 'quarantine',
      scanStatus: 'not_scanned',
    };
  }

  /**
   * B3. The owner chose `block` and a scanner is configured: an authorized caller is told the file
   * waits for its scan — `409 conflict`, `status: scan_required_by_policy`. One denied audit row.
   */
  async blockedByPolicy(
    context: TenantContext,
    action: AuditAction = 'file_asset.downloaded',
  ): Promise<ApiError> {
    await this.audit.recordDenial(context, action, {
      status: 409,
      capability: DOWNLOAD_CAPABILITY,
      auditCode: 'not_scanned_blocked_by_policy',
    });
    return new ApiError(
      409,
      'conflict',
      'Your company allows downloads only after the virus scan. Try again once it has been checked',
      [{ field: 'status', message: 'scan_required_by_policy' }],
      'not_scanned_blocked_by_policy',
    );
  }

  /**
   * CQ-09. Past every authorization step the caller may already see the file's status in its
   * list, so the gate says why it will not serve it rather than pretending it does not exist:
   * `409 conflict` with `status: pending_scan` while it is still being checked, or
   * `status: blocked` once the scan rejected it. Still one denied audit row, `not_servable`.
   */
  async notReady(
    context: TenantContext,
    status: string,
    action: AuditAction = 'file_asset.downloaded',
  ): Promise<ApiError> {
    await this.audit.recordDenial(context, action, {
      status: 409,
      capability: DOWNLOAD_CAPABILITY,
      auditCode: 'not_servable',
    });
    const state = downloadStateFor(status);
    return new ApiError(
      409,
      'conflict',
      state === 'blocked'
        ? 'This file was blocked by the malware check and cannot be downloaded'
        : 'This file is still being checked for malware. Try again shortly',
      [{ field: 'status', message: state }],
      'not_servable',
    );
  }

  /** One denied row, one indistinguishable 404. */
  async refuse(
    context: TenantContext,
    auditCode: string,
    action: AuditAction = 'file_asset.downloaded',
  ): Promise<ApiError> {
    await this.audit.recordDenial(context, action, {
      status: 404,
      capability: DOWNLOAD_CAPABILITY,
      auditCode,
    });
    return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, auditCode);
  }
}

/** 57-13a. A version held in Drive/OneDrive that cannot be read now: a calm 409, never a crash. */
function storageUnreachable(error: ProviderObjectUnavailableError): ApiError {
  return new ApiError(
    409,
    'conflict',
    'This file is kept in your connected storage, which cannot be reached right now',
    [{ field: 'file', message: `storage_${error.reason}` }],
  );
}

/** R4 slice 4. The door's principal kind, refused with the existing 403 otherwise. */
export function assertDoor(principal: Principal, door: 'internal' | 'client'): void {
  if (door === 'internal' && principal.kind !== 'internal') {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      undefined,
      'not_an_internal_principal',
    );
  }
  if (door === 'client' && (principal.kind !== 'client' || !principal.clientOrganizationId)) {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'not_a_client_principal');
  }
}

/** The typed state a refused-but-authorized download reports (CQ-09). */
export type DownloadState = 'pending_scan' | 'blocked';

export function downloadStateFor(assetStatus: string): DownloadState {
  return assetStatus === 'rejected' || assetStatus === 'expired' || assetStatus === 'cancelled'
    ? 'blocked'
    : 'pending_scan';
}

export { awaitingScan };

/**
 * FIX4 item 1b. Whether a file may be used now — attached to a message, listed in Files, shown in a
 * doc — and how it is labelled. `clean`: scanned and promoted (`ready`). `not_scanned`: verified
 * (its type is known and allowed; executables and macro Office files never get this far) but not
 * judged by a scanner, and the owner's policy is "Allow, marked Not scanned" — always the case
 * when no scanner is configured. `null`: not usable (still uploading or verifying, refused,
 * infected, or the owner's "Block until scanned").
 */
export type UsableScanStatus = 'clean' | 'not_scanned';

export function usableScanStatus(
  assetStatus: string,
  version: FileVersionRow | null,
  effective: 'allow_labeled' | 'block',
): UsableScanStatus | null {
  if (version === null) return null;
  if (
    isServableVersion({
      status: assetStatus,
      scanVerdict: version.scanVerdict,
      trustZone: version.trustZone,
    })
  ) {
    return 'clean';
  }
  if (effective === 'allow_labeled' && awaitingScan(assetStatus, version)) return 'not_scanned';
  return null;
}

export function destroy(stream: unknown): void {
  const candidate = stream as { destroy?: () => void; destroyed?: boolean };
  if (typeof candidate.destroy === 'function' && !candidate.destroyed) candidate.destroy();
}
