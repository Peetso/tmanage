import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileVersionRow } from '../../common/database/schema.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { mayDownloadFor } from './purpose-policy.js';
import { DOWNLOAD_CAPABILITY } from './file-download.service.js';
import { awaitingScan, ClientFileSharing } from './client-file-sharing.js';
import type { ClientFileState, ClientSharingPolicies } from './client-file-sharing.js';
import type { ScannerPresence } from '../tenancy/download-scan-policy.js';
import { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { viewerKindFor } from './file-preview.service.js';
import { ReviewThreadsRepository } from './review-threads.repository.js';

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
 *    returned. FIX6 item 1: each row is then decided by the one sharing rule
 *    ({@link ClientFileSharing}) the download door also applies, so the list never names a file the
 *    door refuses. An
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
  /** R4 slice 8. The proofing viewer can show this type (the row's "Review" button). */
  readonly reviewable: boolean;
  /** R4 slice 8. Open comments the client can see on this file (team-only ones never count). */
  readonly openComments: number;
}

export class PortalFileListService {
  /** FIX6 item 1. The one rule that decides whether a file may reach a client. */
  private readonly sharing: ClientFileSharing;

  constructor(
    private readonly database: TenantDatabase,
    private readonly assets: FileAssetsRepository,
    /** C4. The configured scanner, as the download door gets it; absent means `allow_labeled`. */
    scanner?: ScannerPresence,
    settings: OrgSettingsRepository = new OrgSettingsRepository(),
    /** F48. The project's lifecycle, for the download door's own `authorize()` per row. */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    /** R4 slice 8. The open client-visible comment count per listed file. */
    private readonly threads: ReviewThreadsRepository = new ReviewThreadsRepository(),
  ) {
    this.sharing = new ClientFileSharing(scanner, settings);
  }

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
    // FIX6 item 1. The policies are read once; each row is decided by the one sharing rule.
    let policies: ClientSharingPolicies | undefined;
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
      policies ??= await this.database.read(context, (runner) =>
        this.sharing.policiesOn(runner, context),
      );
      const status = portalScanStatus(
        this.sharing.stateOf(row.asset, row.version, policies),
        awaitingScan(row.asset.status, row.version),
        policies.scannerPresent,
      );
      if (status !== null) files.push(toView(row.asset, row.version, status));
    }
    if (files.length === 0) return files;
    const open = await this.database.read(context, (runner) =>
      this.threads.countOpenClientVisible(
        runner,
        context,
        files.map((file) => file.id),
      ),
    );
    return files.map((file) => ({ ...file, openComments: open.get(file.id) ?? 0 }));
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

/**
 * FIX6 item 1. What the list says about one file: `clean` once virus-scanned, `not_scanned` (the
 * screen's "Checked") when the sharing rule lets a checked file reach the client, and
 * `being_checked` while a configured scanner may still clear it. Anything else is not listed —
 * blocked, infected or refused files, and, with no scanner, files the owner keeps to virus-scanned.
 */
export function portalScanStatus(
  state: ClientFileState | null,
  awaiting: boolean,
  scannerPresent: boolean,
): PortalFileScanStatus | null {
  if (state === 'virus_scanned') return 'clean';
  if (state === 'checked') return 'not_scanned';
  return awaiting && scannerPresent ? 'being_checked' : null;
}

/** The allowlist projection. Listed versions are verified, so the detected type is set. */
function toView(
  asset: FileAssetRow,
  version: FileVersionRow,
  scanStatus: PortalFileScanStatus,
): PortalFileView {
  const contentType = version.detectedMimeType ?? version.declaredMimeType;
  return {
    id: asset.id,
    projectId: asset.projectId,
    name: asset.name,
    sizeBytes: version.sizeBytes,
    contentType,
    uploadedAt: asset.createdAt.toISOString(),
    scanStatus,
    reviewable: viewerKindFor(contentType) !== 'unsupported',
    openComments: 0,
  };
}
