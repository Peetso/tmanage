import { authorize, isClientReadableAudience } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { FileAssetRow } from '../../common/database/schema.js';
import { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import { ClientFileReachRepository } from './client-file-reach.repository.js';
import { mayDownloadFor, objectTableFor } from './purpose-policy.js';

/**
 * Security audit F35 — the client relation of one file asset, expressed once.
 *
 * `FileDownloadService.gate` and the portal file list refuse to trust the asset row alone for a
 * client principal: a staff upload carries no client organization on the asset, so `authorize()`
 * rule 7 is a no-op and rule 10 passes for every client organization sharing the project. The
 * relation is the **request row** the file hangs off — its project and its client organization —
 * after the client purpose table ({@link mayDownloadFor}) admits the purpose at all.
 *
 * R4 slice 4 adds the published-deliverable fact (SPEC §3.4) and the version chain:
 *
 * - **`published_deliverable`** — the asset is the file of a `deliverable_versions` row that has a
 *   `client_projections` row, in the asset's own project, and `client_projection.read` passes for
 *   this client on that project. Publishing is the act that makes it client content, so the gate
 *   then authorizes it as `client_visible` whatever audience the upload carried.
 * - **`deliverable_file`** — a `deliverable`-purpose file uploaded for a deliverable (`objectId`)
 *   that has at least one published version, carrying a client audience and this client's own
 *   organization: exactly the rows the portal's deliverable file list shows.
 * - **`chain`** — for a `deliverable` file, another version of the same attachment chain is
 *   reachable by one of the rules above. The asset's own audience still decides in `authorize()`, so an internal later version
 *   stays the same 404.
 *
 * Every non-download file surface a client principal can reach (comments, tags) asks this before
 * `authorize()`, so a sibling client organization on a shared project gets the same 404 an absent
 * id gives (`04-SECURITY-PRIVACY` §5: no client discovers another client organization's file).
 * An internal principal is not narrowed here; `authorize()` alone decides for it.
 */
export type ClientReachVia =
  'internal' | 'request' | 'published_deliverable' | 'deliverable_file' | 'chain';

export interface ClientReach {
  readonly via: ClientReachVia;
  /**
   * The audience the gate authorizes the read under: the asset's own, except for a published
   * deliverable version's file, which publication made `client_visible`.
   */
  readonly audience: FileAssetRow['audience'];
}

export class FileClientRelation {
  constructor(
    private readonly requests: ClientRequestsRepository = new ClientRequestsRepository(),
    private readonly reachReads: ClientFileReachRepository = new ClientFileReachRepository(),
  ) {}

  async mayClientReach(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    asset: FileAssetRow,
  ): Promise<boolean> {
    return (await this.reach(runner, context, principal, asset)) !== null;
  }

  /** How this principal reaches the asset, or `null` for the one 404. */
  async reach(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    asset: FileAssetRow,
  ): Promise<ClientReach | null> {
    if (principal.kind === 'internal') return { via: 'internal', audience: asset.audience };
    if (principal.kind !== 'client' || !principal.clientOrganizationId) return null;
    const direct = await this.directReach(runner, context, principal, asset);
    if (direct) return direct;
    // The chain rule is for deliverable work: version 1 is the published deliverable file and the
    // later versions are uploaded beside it. A request file's versions hang off the request row.
    if (asset.purpose !== 'deliverable') return null;
    const siblings = await this.reachReads.chainSiblings(runner, context, asset.id);
    for (const sibling of siblings) {
      if (sibling.projectId !== asset.projectId) continue;
      if (await this.directReach(runner, context, principal, sibling)) {
        return { via: 'chain', audience: asset.audience };
      }
    }
    return null;
  }

  private async directReach(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    asset: FileAssetRow,
  ): Promise<ClientReach | null> {
    if (!mayDownloadFor('client', asset.purpose)) return null;
    if (objectTableFor(asset.purpose) === 'client_requests') {
      if (asset.objectId === null) return null;
      const request = await this.requests.findById(runner, context, asset.objectId);
      const related =
        request !== null &&
        request.projectId === asset.projectId &&
        request.clientOrganizationId === principal.clientOrganizationId;
      return related ? { via: 'request', audience: asset.audience } : null;
    }
    if (asset.purpose !== 'deliverable') return null;
    if (!mayReadProjection(principal, asset.projectId)) return null;
    const published = await this.reachReads.publishedVersionNaming(runner, context, asset.id);
    if (published && published.projectId === asset.projectId) {
      return { via: 'published_deliverable', audience: 'client_visible' };
    }
    if (
      asset.objectId !== null &&
      isClientReadableAudience(asset.audience) &&
      asset.clientOrganizationId === principal.clientOrganizationId &&
      (await this.reachReads.deliverableIsPublished(runner, context, asset.objectId))
    ) {
      return { via: 'deliverable_file', audience: asset.audience };
    }
    return null;
  }
}

/** `client_projection.read` on the project — the portal's own `mayRead`. */
function mayReadProjection(principal: Principal, projectId: string): boolean {
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
