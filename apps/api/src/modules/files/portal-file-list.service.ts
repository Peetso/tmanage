import { authorize, isServableVersion } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileVersionRow } from '../../common/database/schema.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { mayDownloadFor } from './purpose-policy.js';
import { awaitingScan, DOWNLOAD_CAPABILITY } from './file-download.service.js';
import { readDownloadScanPolicy } from '../tenancy/download-scan-policy.js';
import type { ScannerPresence } from '../tenancy/download-scan-policy.js';
import { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';

/**
 * FILE-003 · WEB-006 — the client portal's file list, over the FILE-002 download surface.
 *
 * The per-file download door (`FileDownloadService.downloadForClient`, `/portal/files/:id/content`)
 * already exists; a client could download a file whose id they held but had nowhere to *see* which
 * files were theirs. This is that missing read: the request-attachment files in one of the client's
 * projects that the download door would actually serve, so the list can never name a file the door
 * then refuses, and never omit one it would serve.
 *
 * ## Built field by field, not a filtered internal row
 *
 * `25-AUTH-AND-TENANT-ISOLATION` §7: never `serializeInternalObject(); delete fields`. {@link
 * PortalFileView} is the allowlist — id, name, size, detected type, uploaded-at — and the two
 * internal facts a filter would have leaked are absent by construction: `objectKey` (the storage
 * literal `FORBIDDEN_CLIENT_FIELDS` names) and the owning staff member. A column added to
 * `file_assets` tomorrow is invisible to a client until someone lists it here.
 *
 * ## Three gates, the same as the download door's, in the same order
 *
 * 1. **Client principal only.** The list is a client's own files; an internal or service principal
 *    is refused `403`, exactly as {@link FileDownloadService.downloadForClient} refuses them —
 *    "what can the client see" for an internal caller is a later ticket, not this route.
 * 2. **The project, relation-scoped first** (the Known trap, FAST-PROTOCOL 19:55). {@link mayRead}
 *    runs `authorize()` rule 10 — the project must be in `principal.projectIds`, which comes from
 *    `project_clients` and nothing else — **before** any file is read. An unknown, cross-tenant or
 *    sibling-client `projectId` fails it and the refusal is **404, not 403**: a client probing
 *    project ids must not learn which of them are real.
 * 3. **The client-organization relation and the servable rule, per row.** The relation is read
 *    from the **request** the file hangs off — never the asset, which an internal upload leaves
 *    without a client organization — so a sibling client's attachment in a shared project is never
 *    returned. A `ready`, `clean`, `private` latest version ({@link isServableVersion}) is listed
 *    as `clean`. C4 (B3 follow-up): a file the scan has not judged yet ({@link awaitingScan}, the
 *    download door's own rule) is listed too, as the owner's "downloads before a virus scan"
 *    policy says — `not_scanned` under `allow_labeled` (the door serves it, labelled), and
 *    `being_checked` under `block` (the door answers 409; the screen disables Download). An
 *    infected, rejected, expired or not-yet-verified file is never listed, whatever the policy.
 */

/** C4. What the list says about a file's virus scan; the screen labels the last two. */
export type PortalFileScanStatus = 'clean' | 'not_scanned' | 'being_checked';

export interface PortalFileView {
  readonly id: string;
  readonly projectId: string;
  /** The client-facing file name. Never `objectKey`, the storage literal. */
  readonly name: string;
  /** The provider's byte count for the served version. */
  readonly sizeBytes: number;
  /** The detected type of the served version — non-null because a servable version has one. */
  readonly contentType: string;
  /** When the file asset was created, as an ISO-8601 instant. */
  readonly uploadedAt: string;
  /** C4. `clean` once scanned; otherwise what the owner's policy makes of an unscanned file. */
  readonly scanStatus: PortalFileScanStatus;
}

export class PortalFileListService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly assets: FileAssetsRepository,
    /** C4. The configured scanner, as the download door gets it; absent means `allow_labeled`. */
    private readonly scanner?: ScannerPresence,
    private readonly settings: OrgSettingsRepository = new OrgSettingsRepository(),
    /** F48. The project's lifecycle, for the download door's own `authorize()` per row. */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /**
   * The downloadable files in one of this client's projects.
   *
   * The order of the gates is load-bearing and matches {@link FileDownloadService}: principal
   * kind, then the project relation (404 before any read), then the per-row client-organization
   * and servable checks. The client-organization check is the audience guard this slice's revert
   * proof pins — remove it and a sibling client's request attachment in a shared project would be
   * listed.
   */
  async listForClient(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<readonly PortalFileView[]> {
    if (principal.kind !== 'client' || !principal.clientOrganizationId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'not_a_client_principal');
    }
    if (!this.mayRead(principal, projectId)) {
      // 404, not 403. A client probing project ids must not learn which of them are real.
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const clientOrganizationId = principal.clientOrganizationId;
    const { rows, archived } = await this.database.read(context, async (runner) => ({
      rows: await this.assets.listRequestAttachmentsForProject(runner, context, projectId),
      archived: (await this.projects.findById(runner, context, projectId))?.archivedAt != null,
    }));

    const files: PortalFileView[] = [];
    // C4. The policy is read once, and only when some file is still waiting for its scan.
    let unscannedStatus: PortalFileScanStatus | undefined;
    for (const row of rows) {
      // The audience guard: a client sees only their own client organization's request files,
      // read from the request row (an internal upload leaves the asset's own column null). The
      // project is re-checked defensively — the query scopes it, and a mismatch is never listed.
      if (row.request.clientOrganizationId !== clientOrganizationId) continue;
      if (row.request.projectId !== row.asset.projectId) continue;
      if (!mayDownloadFor('client', row.asset.purpose)) continue;
      // F48. The download door's own decision on the asset — audience, client organization,
      // project relation and lifecycle — so an `internal` staff attachment is never listed.
      if (!this.mayDownload(principal, row.asset, archived)) continue;
      if (row.version === null) continue;
      // "Published" for a file is servable: ready asset, clean verdict, private zone.
      if (
        isServableVersion({
          status: row.asset.status,
          scanVerdict: row.version.scanVerdict,
          trustZone: row.version.trustZone,
        })
      ) {
        files.push(toView(row.asset, row.version, 'clean'));
        continue;
      }
      // Not judged by the scan yet — the same rule the download door applies. Anything else
      // (infected, rejected, expired, not verified) stays hidden.
      if (!awaitingScan(row.asset.status, row.version)) continue;
      unscannedStatus ??= await this.unscannedStatus(context);
      files.push(toView(row.asset, row.version, unscannedStatus));
    }
    return files;
  }

  /** C4. `allow_labeled` → `not_scanned` (downloadable, labelled); `block` → `being_checked`. */
  private async unscannedStatus(context: TenantContext): Promise<PortalFileScanStatus> {
    const policy = await readDownloadScanPolicy(
      this.database,
      context,
      this.scanner,
      this.settings,
    );
    return policy.effective === 'block' ? 'being_checked' : 'not_scanned';
  }

  /** F48. `authorize(file.download)` exactly as {@link FileDownloadService} asks it. */
  private mayDownload(principal: Principal, asset: FileAssetRow, archived: boolean): boolean {
    return authorize({
      principal,
      capability: DOWNLOAD_CAPABILITY,
      resource: {
        organizationId: asset.organizationId,
        projectId: asset.projectId,
        audience: asset.audience,
        clientOrganizationId: asset.clientOrganizationId,
        lifecycle: archived ? 'archived' : 'active',
      },
    }).allowed;
  }

  /**
   * May this client read this project's client projection? One `authorize()` call at audience
   * `client_visible`, exactly as {@link PortalService.mayRead} — same rule, so the file list and
   * the rest of the portal agree on which projects a client may see.
   */
  private mayRead(principal: Principal, projectId: string): boolean {
    return authorize({
      principal,
      capability: 'client_projection.read',
      resource: {
        organizationId: principal.organizationId,
        projectId,
        audience: 'client_visible',
        clientOrganizationId: principal.clientOrganizationId,
        lifecycle: 'active',
      },
    }).allowed;
  }
}

/** The allowlist projection. Listed versions are verified, so the detected type is set. */
function toView(
  asset: FileAssetRow,
  version: FileVersionRow,
  scanStatus: PortalFileScanStatus,
): PortalFileView {
  return {
    id: asset.id,
    projectId: asset.projectId,
    name: asset.name,
    sizeBytes: version.sizeBytes,
    contentType: version.detectedMimeType ?? version.declaredMimeType,
    uploadedAt: asset.createdAt.toISOString(),
    scanStatus,
  };
}
