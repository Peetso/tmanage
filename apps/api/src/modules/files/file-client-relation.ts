import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { FileAssetRow } from '../../common/database/schema.js';
import { ClientRequestsRepository } from '../requests/client-requests.repository.js';
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
 * Every non-download file surface a client principal can reach (comments, tags) asks this before
 * `authorize()`, so a sibling client organization on a shared project gets the same 404 an absent
 * id gives (`04-SECURITY-PRIVACY` §5: no client discovers another client organization's file).
 * An internal principal is not narrowed here; `authorize()` alone decides for it.
 */
export class FileClientRelation {
  constructor(
    private readonly requests: ClientRequestsRepository = new ClientRequestsRepository(),
  ) {}

  async mayClientReach(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    asset: FileAssetRow,
  ): Promise<boolean> {
    if (principal.kind === 'internal') return true;
    if (principal.kind !== 'client' || !principal.clientOrganizationId) return false;
    if (!mayDownloadFor('client', asset.purpose)) return false;
    if (objectTableFor(asset.purpose) !== 'client_requests' || asset.objectId === null) {
      return false;
    }
    const request = await this.requests.findById(runner, context, asset.objectId);
    return (
      request !== null &&
      request.projectId === asset.projectId &&
      request.clientOrganizationId === principal.clientOrganizationId
    );
  }
}
