import { authorize, isServableVersion } from '@tmanage/domain';
import type { AuditMetadata, Principal } from '@tmanage/domain';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { ObjectStore, OpenedObject } from '@tmanage/storage';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { mayDownloadFor } from './purpose-policy.js';

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
 * 2. The purpose table ({@link mayDownloadFor}): a client downloads request attachments and
 *    nothing else until DEL-001 supplies the published fact a deliverable needs.
 * 3. For a client, the relation is the **request row** — its project and its client
 *    organization — never the asset alone: an internal upload carries no client
 *    organization, and `authorize()`'s rule 7 is then a no-op.
 * 4. `authorize()` with the project's true lifecycle: an archived project is readable by
 *    internal principals and by no client (rule 6).
 * 5. {@link isServableVersion}: `ready`, `clean`, `private` — three facts, not one. The
 *    0019 trigger guards the transition into `ready`; this guards the read.
 * 6. The object is opened in the `private` zone — the literal, never a zone read from the
 *    row — and its size is held to the version's, as the scanner's read is.
 *
 * Every refusal is `404 not_found` with the same body, and the cause is on the audit row's
 * `audit_code` alone (`file_asset.downloaded`, `denied`): a caller must not learn whether an
 * id exists, is another client's, or is still scanning. A successful download writes one
 * `allowed` row before the first byte leaves — `12-PERMISSION-MATRIX` §12's "restricted
 * export download" is auditable or it does not happen.
 *
 * ## What is not here
 *
 * No signed URL (`25` §96's wording): the bytes are proxied through the authenticated tenant
 * route, so membership is re-resolved on every request and a suspension holds at once
 * (`27` AUTH-12). An uploader gets no carve-out before `ready`. Previews, inline rendering
 * and a client's deliverable downloads are later tickets (CL-03, CL-05, DEL-001).
 */
export interface FileDownload {
  readonly stream: OpenedObject['stream'];
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly fileName: string;
}

export const DOWNLOAD_CAPABILITY = 'file.download';

export class FileDownloadService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly assets: FileAssetsRepository,
    private readonly projects: ProjectsRepository,
    private readonly requests: ClientRequestsRepository,
    private readonly store: ObjectStore,
    private readonly audit: AuditService,
  ) {}

  /** The studio's door. */
  async download(
    context: TenantContext,
    principal: Principal,
    fileAssetId: string,
  ): Promise<FileDownload> {
    if (principal.kind !== 'internal') {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'not_an_internal_principal',
      );
    }
    return this.gate(context, principal, fileAssetId);
  }

  /** The client's door, under `/portal`. */
  async downloadForClient(
    context: TenantContext,
    principal: Principal,
    fileAssetId: string,
  ): Promise<FileDownload> {
    if (principal.kind !== 'client' || !principal.clientOrganizationId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'not_a_client_principal');
    }
    return this.gate(context, principal, fileAssetId);
  }

  private async gate(
    context: TenantContext,
    principal: Principal,
    fileAssetId: string,
  ): Promise<FileDownload> {
    const found = await this.database.read(context, (runner) =>
      this.assets.findWithLatestVersion(runner, context, fileAssetId),
    );
    if (!found) throw await this.refuse(context, 'file_not_found');
    const { asset, version } = found;

    if (!mayDownloadFor(principal.kind, asset.purpose)) {
      throw await this.refuse(context, 'purpose_not_downloadable');
    }

    if (principal.kind === 'client') {
      const request =
        asset.purpose === 'request_attachment' && asset.objectId !== null
          ? await this.database.read(context, (runner) =>
              this.requests.findById(runner, context, asset.objectId as string),
            )
          : null;
      const related =
        request !== null &&
        request.projectId === asset.projectId &&
        request.clientOrganizationId === principal.clientOrganizationId;
      if (!related) throw await this.refuse(context, 'client_relation_mismatch');
    }

    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, asset.projectId),
    );
    if (!project) throw await this.refuse(context, 'project_not_found');

    const decision = authorize({
      principal,
      capability: DOWNLOAD_CAPABILITY,
      resource: {
        organizationId: asset.organizationId,
        projectId: asset.projectId,
        audience: asset.audience,
        clientOrganizationId: asset.clientOrganizationId,
        lifecycle: project.archivedAt === null ? 'active' : 'archived',
      },
    });
    if (!decision.allowed) throw await this.refuse(context, decision.code);

    if (
      version === null ||
      !isServableVersion({
        status: asset.status,
        scanVerdict: version.scanVerdict,
        trustZone: version.trustZone,
      })
    ) {
      throw await this.refuse(context, 'not_servable');
    }
    const mimeType = version.detectedMimeType;
    if (mimeType === null) throw await this.refuse(context, 'no_detected_type');

    let opened: OpenedObject;
    try {
      opened = await this.store.openObject({ zone: 'private', objectKey: version.objectKey });
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        throw await this.refuse(context, 'private_object_missing');
      }
      throw error;
    }
    if (opened.sizeBytes !== version.sizeBytes) {
      destroy(opened.stream);
      throw await this.refuse(context, 'size_mismatch');
    }

    const metadata: AuditMetadata = {
      project_id: asset.projectId,
      purpose: asset.purpose,
      file_version_id: version.id,
      size_bytes: version.sizeBytes,
      principal_kind: principal.kind,
      delivery: 'proxy',
    };
    try {
      await this.database.transaction(context, (tx) =>
        this.audit.record(tx, context, {
          action: 'file_asset.downloaded',
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

    return {
      stream: opened.stream,
      mimeType,
      sizeBytes: version.sizeBytes,
      fileName: asset.name,
    };
  }

  /** One denied row, one indistinguishable 404. */
  private async refuse(context: TenantContext, auditCode: string): Promise<ApiError> {
    await this.audit.recordDenial(context, 'file_asset.downloaded', {
      status: 404,
      capability: DOWNLOAD_CAPABILITY,
      auditCode,
    });
    return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, auditCode);
  }
}

function destroy(stream: unknown): void {
  const candidate = stream as { destroy?: () => void; destroyed?: boolean };
  if (typeof candidate.destroy === 'function' && !candidate.destroyed) candidate.destroy();
}
