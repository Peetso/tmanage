import { authorize, isServableVersion } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileVersionRow } from '../../common/database/schema.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { mayDownloadFor } from './purpose-policy.js';

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
 *    returned. Only a `ready`, `clean`, `private` latest version ({@link isServableVersion}) is
 *    listed: a file still scanning, rejected, or quarantined is not "published" and never appears.
 */

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
}

export class PortalFileListService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly assets: FileAssetsRepository,
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
    const rows = await this.database.read(context, (runner) =>
      this.assets.listRequestAttachmentsForProject(runner, context, projectId),
    );

    const files: PortalFileView[] = [];
    for (const row of rows) {
      // The audience guard: a client sees only their own client organization's request files,
      // read from the request row (an internal upload leaves the asset's own column null). The
      // project is re-checked defensively — the query scopes it, and a mismatch is never listed.
      if (row.request.clientOrganizationId !== clientOrganizationId) continue;
      if (row.request.projectId !== row.asset.projectId) continue;
      if (!mayDownloadFor('client', row.asset.purpose)) continue;
      // "Published" for a file is servable: ready asset, clean verdict, private zone.
      if (row.version === null) continue;
      if (
        !isServableVersion({
          status: row.asset.status,
          scanVerdict: row.version.scanVerdict,
          trustZone: row.version.trustZone,
        })
      ) {
        continue;
      }
      files.push(toView(row.asset, row.version));
    }
    return files;
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

/** The allowlist projection. The detected type is non-null: a servable version has one. */
function toView(asset: FileAssetRow, version: FileVersionRow): PortalFileView {
  return {
    id: asset.id,
    projectId: asset.projectId,
    name: asset.name,
    sizeBytes: version.sizeBytes,
    contentType: version.detectedMimeType ?? version.declaredMimeType,
    uploadedAt: asset.createdAt.toISOString(),
  };
}
