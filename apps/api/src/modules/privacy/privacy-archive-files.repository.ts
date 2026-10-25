import { and, eq, inArray } from 'drizzle-orm';
import { isServableVersion } from '@tmanage/domain';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { ObjectStore } from '@tmanage/storage';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { fileVersions } from '../../common/database/schema.js';
import type { FileVersionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { awaitingScan } from '../files/file-download.service.js';
import { readDownloadScanPolicy } from '../tenancy/download-scan-policy.js';
import type { ScannerPresence } from '../tenancy/download-scan-policy.js';
import type { DownloadsBeforeScan } from '../tenancy/org-settings.allowlist.js';

/**
 * H3 (audit gap 3, NFR-09) — the file **bytes** of a data export, under the same scan policy as a
 * download (`file-download.service.ts`, B3).
 *
 * For each file in scope (every file of the company, or the files one member added) the latest
 * version is considered:
 *
 * - cleared by the scan and promoted → its bytes are included, `scan_status: clean`;
 * - verified but not judged yet → included, `scan_status: not_scanned`, **unless** the owner's
 *   "downloads before a virus scan" policy is `block`, when it is left out as `waiting_for_scan`;
 * - infected, rejected, expired, cancelled or never verified → never included (`blocked_by_scan` /
 *   `not_ready`).
 *
 * The whole archive then goes through the malware scanner once more before it can be served
 * (`privacy-job.ts`). Sizes are bounded so one export cannot exhaust the process: a file over
 * {@link MAX_FILE_BYTES} or past {@link MAX_ARCHIVE_FILE_BYTES} in total is listed with its reason
 * instead of its bytes. Every row says which happened; nothing is dropped silently.
 */

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ARCHIVE_FILE_BYTES = 64 * 1024 * 1024;
const PAGE = 200;
const MAX_FILES = 200_000;

export type LeftOutReason =
  | 'waiting_for_scan'
  | 'blocked_by_scan'
  | 'not_ready'
  | 'too_large'
  | 'archive_size_limit'
  | 'missing';

export interface ArchiveFileRow {
  readonly file_id: string;
  readonly name: string;
  readonly file_version_id: string | null;
  readonly version_no: number | null;
  readonly mime_type: string | null;
  readonly size_bytes: number | null;
  readonly included: boolean;
  readonly scan_status?: 'clean' | 'not_scanned';
  readonly left_out?: LeftOutReason;
  readonly content_base64?: string;
}

interface AssetRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

/** What the reader decides for one file, before any bytes are read. */
export type FileDecision =
  | {
      readonly include: true;
      readonly zone: 'private' | 'quarantine';
      readonly scanStatus: 'clean' | 'not_scanned';
    }
  | { readonly include: false; readonly reason: LeftOutReason };

/** The download gate's rule, applied to one file's latest version. Pure. */
export function decideFile(
  assetStatus: string,
  version: FileVersionRow | undefined,
  policy: DownloadsBeforeScan,
): FileDecision {
  if (version === undefined) return { include: false, reason: 'not_ready' };
  if (
    isServableVersion({
      status: assetStatus,
      scanVerdict: version.scanVerdict,
      trustZone: version.trustZone,
    })
  ) {
    return { include: true, zone: 'private', scanStatus: 'clean' };
  }
  if (awaitingScan(assetStatus, version)) {
    if (policy === 'block') return { include: false, reason: 'waiting_for_scan' };
    return {
      include: true,
      zone: version.trustZone === 'private' ? 'private' : 'quarantine',
      scanStatus: 'not_scanned',
    };
  }
  const blocked =
    version.scanVerdict === 'infected' ||
    assetStatus === 'rejected' ||
    assetStatus === 'expired' ||
    assetStatus === 'cancelled';
  return { include: false, reason: blocked ? 'blocked_by_scan' : 'not_ready' };
}

async function readAll(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    if (total > limit) {
      const candidate = stream as { destroy?: () => void };
      candidate.destroy?.();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export class ArchiveFileContents {
  constructor(
    private readonly database: TenantDatabase,
    private readonly store: Pick<ObjectStore, 'openObject'>,
    private readonly scanner: ScannerPresence | undefined,
    private readonly policyOf: (context: TenantContext) => Promise<DownloadsBeforeScan> = async (
      context,
    ) => (await readDownloadScanPolicy(this.database, context, this.scanner)).effective,
  ) {}

  /** Every file in scope with its bytes or the reason they are left out. `ownerUserId` narrows. */
  async read(
    context: TenantContext,
    ownerUserId: string | null,
  ): Promise<readonly ArchiveFileRow[]> {
    const policy = await this.policyOf(context);
    const out: ArchiveFileRow[] = [];
    let budget = MAX_ARCHIVE_FILE_BYTES;
    let after = '';
    while (out.length < MAX_FILES) {
      const assets = await this.assetsPage(context, ownerUserId, after);
      if (assets.length === 0) break;
      const latest = await this.latestVersions(
        context,
        assets.map((asset) => asset.id),
      );
      for (const asset of assets) {
        const version = latest.get(asset.id);
        const row = await this.oneFile(
          asset,
          version,
          decideFile(asset.status, version, policy),
          budget,
        );
        if (row.included && row.size_bytes !== null) budget -= row.size_bytes;
        out.push(row);
      }
      if (assets.length < PAGE) break;
      after = (assets[assets.length - 1] as AssetRow).id;
    }
    return out;
  }

  private async oneFile(
    asset: AssetRow,
    version: FileVersionRow | undefined,
    decision: FileDecision,
    budget: number,
  ): Promise<ArchiveFileRow> {
    const base = {
      file_id: asset.id,
      name: asset.name,
      file_version_id: version?.id ?? null,
      version_no: version?.versionNo ?? null,
      mime_type: version?.detectedMimeType ?? version?.declaredMimeType ?? null,
      size_bytes: version?.sizeBytes ?? null,
    };
    if (!decision.include || version === undefined) {
      return {
        ...base,
        included: false,
        left_out: decision.include ? 'not_ready' : decision.reason,
      };
    }
    if (version.sizeBytes > MAX_FILE_BYTES)
      return { ...base, included: false, left_out: 'too_large' };
    if (version.sizeBytes > budget) {
      return { ...base, included: false, left_out: 'archive_size_limit' };
    }
    let bytes: Buffer | null;
    try {
      const opened = await this.store.openObject({
        zone: decision.zone,
        objectKey: version.objectKey,
      });
      bytes = await readAll(opened.stream, version.sizeBytes);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        return { ...base, included: false, left_out: 'missing' };
      }
      throw error;
    }
    if (bytes === null || bytes.length !== version.sizeBytes) {
      return { ...base, included: false, left_out: 'missing' };
    }
    return {
      ...base,
      included: true,
      scan_status: decision.scanStatus,
      content_base64: bytes.toString('base64'),
    };
  }

  private async assetsPage(
    context: TenantContext,
    ownerUserId: string | null,
    after: string,
  ): Promise<readonly AssetRow[]> {
    const params = [context.organizationId, after];
    const owner = ownerUserId === null ? '' : ' and owner_user_id = ?';
    if (ownerUserId !== null) params.push(ownerUserId);
    const rows = await this.database.read(context, (runner) =>
      runner.query(
        `select id, name, status from file_assets
          where organization_id = ? and id > ?${owner} order by id limit ${String(PAGE)}`,
        params,
      ),
    );
    return rows as unknown as readonly AssetRow[];
  }

  private async latestVersions(
    context: TenantContext,
    assetIds: readonly string[],
  ): Promise<ReadonlyMap<string, FileVersionRow>> {
    const versions = await this.database.read(context, (runner) =>
      tenantDrizzle(runner)
        .select()
        .from(fileVersions)
        .where(
          and(
            eq(fileVersions.organizationId, context.organizationId),
            inArray(fileVersions.fileAssetId, [...assetIds]),
          ),
        ),
    );
    const latest = new Map<string, FileVersionRow>();
    for (const version of versions) {
      const current = latest.get(version.fileAssetId);
      if (current === undefined || version.versionNo > current.versionNo) {
        latest.set(version.fileAssetId, version);
      }
    }
    return latest;
  }
}
