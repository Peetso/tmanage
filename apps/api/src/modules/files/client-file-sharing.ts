import { isServableVersion } from '@tmanage/domain';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { FileVersionRow } from '../../common/database/schema.js';
import { clientFilesPolicyOn } from '../tenancy/client-file-policy.js';
import type { ClientFilesPolicy } from '../tenancy/client-file-policy.js';
import {
  effectiveDownloadScanPolicyOn,
  scannerConfigured,
} from '../tenancy/download-scan-policy.js';
import type { ScannerPresence } from '../tenancy/download-scan-policy.js';
import { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { FileAssetsRepository } from './file-assets.repository.js';

/**
 * FIX6 item 1 — whether a file may reach a client, decided in one place.
 *
 * Every road to a client asks this: a deliverable version being sent (published), the portal's
 * deliverable and request file lists, and the client download, preview and review doors. Before,
 * each required `status = 'ready'`, which only a virus scan can give — so on a deployment with no
 * scanner (live) no file could ever reach a client.
 *
 * A file's client state is one of:
 *
 * - `virus_scanned` — a scanner cleared it (`ready`, `clean`, `private`).
 * - `checked` — it passed TManage's own checks (its type was read from its content and is allowed;
 *   executables, macro Office files and unsafe ZIPs never get this far), no scanner has judged it,
 *   and the owner's "Files clients can receive" is `checked`, and the team's own "downloads before
 *   a virus scan" does not hold it back.
 * - `null` — not shareable: still uploading or being checked, deleted, blocked, infected, refused,
 *   or held back by the owner's `virus_scanned` policy.
 *
 * Never call a `checked` file virus-scanned: the label the screens show comes from this state.
 */
export type ClientFileState = 'virus_scanned' | 'checked';

/** The facts the decision needs about one file asset. */
export interface ShareableAsset {
  readonly status: string;
  readonly deletedAt: Date | null;
}

/** The pure rule, so every case is unit-tested without a database. */
export function clientFileState(
  asset: ShareableAsset,
  version: FileVersionRow | null,
  policy: ClientFilesPolicy,
  teamDownloads: 'allow_labeled' | 'block',
): ClientFileState | null {
  if (version === null || asset.deletedAt != null) return null;
  if (
    isServableVersion({
      status: asset.status,
      scanVerdict: version.scanVerdict,
      trustZone: version.trustZone,
    })
  ) {
    return 'virus_scanned';
  }
  if (policy !== 'checked' || teamDownloads !== 'allow_labeled') return null;
  return awaitingScan(asset.status, version) ? 'checked' : null;
}

/** The two owner policies the rule reads, fetched once per request. */
export interface ClientSharingPolicies {
  readonly clientFiles: ClientFilesPolicy;
  readonly teamDownloads: 'allow_labeled' | 'block';
  readonly scannerPresent: boolean;
}

/** The injectable reader every sharing path holds. */
export class ClientFileSharing {
  constructor(
    private readonly scanner: ScannerPresence | undefined,
    private readonly settings: OrgSettingsRepository = new OrgSettingsRepository(),
    private readonly assets: FileAssetsRepository = new FileAssetsRepository(),
  ) {}

  /** Read the policies on a runner the caller already holds (a read or a write transaction). */
  async policiesOn(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<ClientSharingPolicies> {
    return {
      clientFiles: await clientFilesPolicyOn(runner, context, this.scanner, this.settings),
      teamDownloads: await effectiveDownloadScanPolicyOn(
        runner,
        context,
        this.scanner,
        this.settings,
      ),
      scannerPresent: scannerConfigured(this.scanner),
    };
  }

  /** The state of one file under policies already read. */
  stateOf(
    asset: ShareableAsset,
    version: FileVersionRow | null,
    policies: ClientSharingPolicies,
  ): ClientFileState | null {
    return clientFileState(asset, version, policies.clientFiles, policies.teamDownloads);
  }

  /**
   * The publish doors (send for approval, publish a projection): a deliverable version whose file
   * may not reach a client is refused before anything is published — `409 conflict` (audit code `file_not_shareable`),
   * with `scan_required` when the owner keeps clients to virus-scanned files and no scanner is
   * set up (nothing can be shared until the owner changes it), `not_shareable` otherwise. A
   * version without a file (a note) passes. The client doors re-check on every read, so a policy
   * changed later still holds.
   */
  async assertVersionFileShareable(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string | null,
  ): Promise<void> {
    if (fileAssetId === null) return;
    const file = await this.assets.findWithLatestVersion(runner, context, fileAssetId);
    const policies = await this.policiesOn(runner, context);
    if (file && this.stateOf(file.asset, file.version, policies) !== null) return;
    const scanRequired = policies.clientFiles === 'virus_scanned' && !policies.scannerPresent;
    throw new ApiError(
      409,
      'conflict',
      scanRequired
        ? 'Your company sends clients only virus-scanned files, and no virus scanner is set up, so this file cannot be sent. The company owner can change this in Settings.'
        : 'This file cannot be sent to the client yet. It is still being checked, or it did not pass the safety check.',
      [{ field: 'fileAssetId', message: scanRequired ? 'scan_required' : 'not_shareable' }],
      'file_not_shareable',
    );
  }

  /** Read the policies and decide one file. */
  async stateOn(
    runner: TenantQueryRunner,
    context: TenantContext,
    asset: ShareableAsset,
    version: FileVersionRow | null,
  ): Promise<ClientFileState | null> {
    return this.stateOf(asset, version, await this.policiesOn(runner, context));
  }
}

/**
 * B3. A version the scan has not judged yet: the asset is `scanning` (or `ready` with a replacement
 * version still in quarantine), the verifier has detected its type, and its verdict is none yet or
 * `unscanned` (the `none` driver). `infected` and every terminal refusal are excluded.
 */
export function awaitingScan(assetStatus: string, version: FileVersionRow): boolean {
  if (assetStatus !== 'scanning' && assetStatus !== 'ready') return false;
  if (version.detectedMimeType === null) return false;
  return version.scanVerdict === null || version.scanVerdict === 'unscanned';
}
