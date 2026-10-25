import { and, asc, desc, eq, exists, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { uploadStateMachine, uuidv7 } from '@tmanage/domain';
import type { Audience, UploadState } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { clientRequests, fileAssets, fileVersions } from '../../common/database/schema.js';
import type { FileAssetRow, FileVersionRow, UploadPurpose } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * File assets and their versions — the rows an upload produces.
 *
 * `23-ERD-AND-STATE-MACHINES` §10's lifecycle lives on `file_assets.status` and is driven
 * by `packages/domain`'s `uploadStateMachine`, which already knows that `uploading →
 * uploaded` requires a byte size. This repository asks the machine and writes the answer;
 * it does not restate the transitions. FILE-001 drives `created → uploading → uploaded` and
 * the two early exits; FILE-002's verification pass (`file-verifier.ts`) drives `uploaded →
 * verifying → scanning | rejected`, and its scan pass (`file-scanner.ts`) drives
 * `scanning → ready | rejected`. `ready` is written by {@link transition} alone, and only
 * with `scanVerdict: 'clean'`: the machine's `requires` is a presence rule, so the value
 * is checked here before the machine is asked, and migration 0019's trigger refuses the
 * move at the engine unless the latest version is clean and promoted.
 *
 * ## The facts a move carries are written, not only checked
 *
 * `transition` hands `facts` to the machine — which is how `verifying → rejected` without a
 * `rejectionCode` is refused before any write — and then **projects** the facts that have a
 * column: `rejectionCode` to `file_assets.rejection_code`. An earlier revision passed the
 * facts to the machine and discarded them, so a rejection would have satisfied the guard
 * and left the column NULL (the FILE-002 fleet's finding).
 *
 * ## A version is written once, and its verdict once
 *
 * A version's identity, key, size, declared type, etag and number are immutable at the
 * engine (`trg_file_versions_immutable`, recreated in 0018 and 0019); its `content_hash`
 * and `detected_mime_type` are NULL at creation and **write-once**: {@link recordVerification}
 * writes them conditionally on NULL, and the trigger refuses a second value even if that
 * condition is forgotten. The scan verdict, its time and its scanner are write-once as a
 * unit ({@link recordScan}), with `unscanned` the one verdict a real scanner may replace;
 * `trust_zone` moves once, to `private`, in the same write as a `clean` verdict. `users.sql`
 * grants the runtime credential INSERT and, since FILE-002, UPDATE — the trigger is what
 * keeps that grant to those writes. "Replacement creates new file version" (§10) remains
 * the only way the bytes behind an asset ever change.
 */

export class FileAssetNotFoundError extends Error {
  constructor(readonly fileAssetId: string) {
    super(`File asset ${fileAssetId} was not found`);
    this.name = 'FileAssetNotFoundError';
  }
}

export class FileAssetTransitionError extends Error {
  constructor(
    readonly from: UploadState,
    readonly to: UploadState,
    detail: string,
  ) {
    super(detail);
    this.name = 'FileAssetTransitionError';
  }
}

export interface CreateFileAssetInput {
  readonly projectId: string;
  readonly clientOrganizationId: string | null;
  readonly ownerUserId: string;
  readonly name: string;
  readonly purpose: UploadPurpose;
  readonly objectId: string | null;
  readonly audience: Audience;
}

export interface CreateFileVersionInput {
  readonly fileAssetId: string;
  readonly objectKey: string;
  readonly sizeBytes: number;
  readonly declaredMimeType: string;
  readonly etag: string | null;
}

/**
 * The asset's latest version has no final verdict: `NULL`, or `unscanned` when the pass
 * may replace it. A correlated `EXISTS` on the greatest `version_no`, in the same
 * organization — the shape 0019's trigger reads too.
 */
function awaitingScanVersion(rescanUnscanned: boolean) {
  const verdict = rescanUnscanned
    ? or(isNull(fileVersions.scanVerdict), eq(fileVersions.scanVerdict, 'unscanned'))
    : isNull(fileVersions.scanVerdict);
  return exists(
    sql`(select 1 from ${fileVersions} where ${fileVersions.organizationId} = ${fileAssets.organizationId}
      and ${fileVersions.fileAssetId} = ${fileAssets.id}
      and ${verdict}
      and ${fileVersions.versionNo} = (select max(l.version_no) from file_versions l
        where l.organization_id = ${fileAssets.organizationId} and l.file_asset_id = ${fileAssets.id}))`,
  );
}

export class FileAssetsRepository {
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
  ): Promise<FileAssetRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(fileAssets)
      .where(
        and(eq(fileAssets.organizationId, context.organizationId), eq(fileAssets.id, fileAssetId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
  ): Promise<FileAssetRow> {
    const found = await this.findById(runner, context, fileAssetId);
    if (!found) throw new FileAssetNotFoundError(fileAssetId);
    return found;
  }

  /** At the machine's initial state, explicitly — the column has no DEFAULT to invent one. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateFileAssetInput,
  ): Promise<FileAssetRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(fileAssets)
      .values({
        id,
        organizationId: context.organizationId,
        projectId: input.projectId,
        clientOrganizationId: input.clientOrganizationId,
        ownerUserId: input.ownerUserId,
        name: input.name,
        purpose: input.purpose,
        objectId: input.objectId,
        audience: input.audience,
        status: uploadStateMachine.definition.initial,
        version: 1,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });
    return this.requireById(runner, context, id);
  }

  /**
   * Move an asset through §10, with the facts the move requires.
   *
   * The current state is read in the same unit of work and the machine is asked; an illegal
   * move, or a legal one arriving without its facts, is refused before any write. The write
   * re-states the current status, so a concurrent move loses rather than being applied to a
   * state the row has since left — the pass that loses sees `FileAssetTransitionError` with
   * "changed state concurrently", and counts it skipped. A fact with a column is written
   * with the move: `rejectionCode`, as a string, to `rejection_code`.
   */
  async transition(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
    to: UploadState,
    facts: Readonly<Record<string, unknown>> = {},
  ): Promise<FileAssetRow> {
    const current = await this.requireById(runner, context, fileAssetId);
    const from = current.status as UploadState;
    const verdict = uploadStateMachine.transition(from, to, facts);
    if (!verdict.ok) throw new FileAssetTransitionError(from, to, verdict.detail);
    // The machine asks that a verdict be present; only a clean one reaches `ready`. Checked
    // before any write, and again at the engine by 0019's trigger.
    if (to === 'ready' && facts['scanVerdict'] !== 'clean') {
      throw new FileAssetTransitionError(from, to, 'ready requires a clean scan verdict');
    }

    const rejectionCode = facts['rejectionCode'];
    const result = await tenantDrizzle(runner)
      .update(fileAssets)
      .set({
        status: to,
        ...(typeof rejectionCode === 'string' ? { rejectionCode } : {}),
        version: sql`version + 1`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(fileAssets.organizationId, context.organizationId),
          eq(fileAssets.id, fileAssetId),
          eq(fileAssets.status, from),
        ),
      );
    if (result[0].affectedRows === 0) {
      throw new FileAssetTransitionError(from, to, 'the file changed state concurrently');
    }
    return this.requireById(runner, context, fileAssetId);
  }

  /**
   * FILE-002. The assets one verification pass should look at in this organization: every
   * `uploaded` one, and every `verifying` one that no pass has touched since `staleBefore` —
   * a pass that died mid-object. Oldest first, so a stuck row is never starved by new
   * arrivals; the index is `ix_file_assets_org_project_status`'s prefix.
   */
  async listAwaitingVerification(
    runner: TenantQueryRunner,
    context: TenantContext,
    staleBefore: Date,
    limit: number,
  ): Promise<readonly FileAssetRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(fileAssets)
      .where(
        and(
          eq(fileAssets.organizationId, context.organizationId),
          or(
            eq(fileAssets.status, 'uploaded'),
            and(eq(fileAssets.status, 'verifying'), lt(fileAssets.updatedAt, staleBefore)),
          ),
        ),
      )
      .orderBy(asc(fileAssets.updatedAt), asc(fileAssets.id))
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  /**
   * FILE-002's cross-tenant half: which organizations hold an asset a pass should look at.
   * Read through the bootstrap escape hatch with a reason naming this use, as the sweeper's
   * `organizationsHoldingExpired` is; one statement, and it reaches `file_assets` alone.
   */
  async organizationsAwaitingVerification(
    runner: BootstrapQueryRunner,
    staleBefore: Date,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ organizationId: fileAssets.organizationId })
      .from(fileAssets)
      .where(
        or(
          eq(fileAssets.status, 'uploaded'),
          and(eq(fileAssets.status, 'verifying'), lt(fileAssets.updatedAt, staleBefore)),
        ),
      )
      .orderBy(asc(fileAssets.organizationId));
    return rows.map((row) => row.organizationId);
  }

  /**
   * FILE-002. Record what the pass read — the digest of the bytes and, when the signature
   * admitted the declared type, the detected type — on a version whose `content_hash` is
   * still NULL. `true` when this call wrote it; `false` when a verdict was already there, in
   * which case nothing changed and the caller compares what it read with what stands (an
   * equal digest is a redelivery; a different one is an object that changed under a sealed
   * version, and is an error, never a rewrite). The trigger recreated in 0018 refuses a
   * rewrite even if this condition is forgotten. On a rejection the digest is still
   * recorded — the bytes are evidence — and the detected type stays NULL.
   */
  async recordVerification(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileVersionId: string,
    facts: { readonly contentHash: string; readonly detectedMimeType: string | null },
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(fileVersions)
      .set({ contentHash: facts.contentHash, detectedMimeType: facts.detectedMimeType })
      .where(
        and(
          eq(fileVersions.organizationId, context.organizationId),
          eq(fileVersions.id, fileVersionId),
          isNull(fileVersions.contentHash),
        ),
      );
    return result[0].affectedRows === 1;
  }

  /**
   * FILE-002 slice B. The assets one scan pass should look at in this organization: every
   * `scanning` one whose latest version has no final verdict — `NULL`, or `unscanned` when
   * a real scanner is now configured (`rescanUnscanned`) — and that no live pass holds:
   * `scan_claimed_at` is NULL or older than `staleBefore` (decision 13's bound, a pass that
   * died). Oldest first, so a stuck row is never starved by new arrivals.
   */
  async listAwaitingScan(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: { readonly staleBefore: Date; readonly rescanUnscanned: boolean },
    limit: number,
  ): Promise<readonly FileAssetRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(fileAssets)
      .where(
        and(
          eq(fileAssets.organizationId, context.organizationId),
          eq(fileAssets.status, 'scanning'),
          or(isNull(fileAssets.scanClaimedAt), lt(fileAssets.scanClaimedAt, options.staleBefore)),
          awaitingScanVersion(options.rescanUnscanned),
        ),
      )
      .orderBy(asc(fileAssets.updatedAt), asc(fileAssets.id))
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  /** The scan pass's cross-tenant half, through the bootstrap hatch as the verifier's is. */
  async organizationsAwaitingScan(
    runner: BootstrapQueryRunner,
    options: { readonly staleBefore: Date; readonly rescanUnscanned: boolean },
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ organizationId: fileAssets.organizationId })
      .from(fileAssets)
      .where(
        and(
          eq(fileAssets.status, 'scanning'),
          or(isNull(fileAssets.scanClaimedAt), lt(fileAssets.scanClaimedAt, options.staleBefore)),
          awaitingScanVersion(options.rescanUnscanned),
        ),
      )
      .orderBy(asc(fileAssets.organizationId));
    return rows.map((row) => row.organizationId);
  }

  /**
   * FILE-002 slice B. The scan pass's claim: `scan_claimed_at = now` on a `scanning` row
   * nobody holds, conditional on the row's `version` so two passes that selected it
   * together cannot both take it. `true` when this call took it. A claim is left standing
   * when the scan fails, so the row waits out decision 13's bound before the next try — a
   * scanner that times out on one object cannot fill every batch with it (the fleet's
   * starvation finding).
   */
  async claimForScan(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: FileAssetRow,
    now: Date,
    staleBefore: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(fileAssets)
      .set({ scanClaimedAt: now, version: sql`version + 1`, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(fileAssets.organizationId, context.organizationId),
          eq(fileAssets.id, row.id),
          eq(fileAssets.status, 'scanning'),
          eq(fileAssets.version, row.version),
          or(isNull(fileAssets.scanClaimedAt), lt(fileAssets.scanClaimedAt, staleBefore)),
        ),
      );
    return result[0].affectedRows === 1;
  }

  /**
   * FILE-002 slice B. Record what the scanner said — the verdict, when, and which driver —
   * and, for a clean verdict, that the object now lives in the private zone. A final
   * verdict is conditional on no final verdict standing (`NULL`, or `unscanned`);
   * `unscanned` itself is conditional on `NULL`, so two `none` passes record it once.
   * `true` when this call wrote it, `false` when a verdict already stood, in which case
   * the caller compares and a different final one is `file_asset.scan_disputed`, never a
   * rewrite. 0019's trigger refuses the rewrite even if this condition is forgotten, and
   * refuses `private` without `clean`.
   */
  async recordScan(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileVersionId: string,
    facts: {
      readonly scanVerdict: 'clean' | 'infected' | 'unscanned';
      readonly scannedAt: Date;
      readonly scanner: string;
    },
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(fileVersions)
      .set({
        scanVerdict: facts.scanVerdict,
        scannedAt: facts.scannedAt,
        scanner: facts.scanner,
        ...(facts.scanVerdict === 'clean' ? { trustZone: 'private' } : {}),
      })
      .where(
        and(
          eq(fileVersions.organizationId, context.organizationId),
          eq(fileVersions.id, fileVersionId),
          facts.scanVerdict === 'unscanned'
            ? isNull(fileVersions.scanVerdict)
            : or(isNull(fileVersions.scanVerdict), eq(fileVersions.scanVerdict, 'unscanned')),
        ),
      );
    return result[0].affectedRows === 1;
  }

  // ── FILE-003: quarantine / rejected retention lifecycle ─────────────────────

  /**
   * FILE-003's cross-tenant half: which organizations hold a rejected asset past its
   * retention window that has not yet been purged. Read through the bootstrap escape hatch
   * with a reason naming this use, as the verifier's `organizationsAwaitingVerification` and
   * the sweeper's `organizationsHoldingExpired` are; one statement, reaching `file_assets`
   * alone. `updated_at` is when the asset was rejected (its last transition), so the cutoff is
   * the retention age.
   */
  async organizationsWithPurgeableAssets(
    runner: BootstrapQueryRunner,
    cutoff: Date,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ organizationId: fileAssets.organizationId })
      .from(fileAssets)
      .where(
        and(
          eq(fileAssets.status, 'rejected'),
          isNull(fileAssets.purgedAt),
          lt(fileAssets.updatedAt, cutoff),
        ),
      )
      .orderBy(asc(fileAssets.organizationId));
    return rows.map((row) => row.organizationId);
  }

  /**
   * FILE-003. The assets one retention pass should purge in this organization: every
   * `rejected` one past `cutoff` that has not been purged, paired with its latest version —
   * the version whose quarantine object the job deletes and whose `size_bytes` it gives back.
   * Only versions still in `quarantine` are returned: a rejected asset never reached the
   * private zone, and filtering on it guarantees the job cannot delete a promoted object.
   * Oldest first, so a stuck row is never starved by new arrivals; a limit caps the batch.
   */
  async listPurgeable(
    runner: TenantQueryRunner,
    context: TenantContext,
    cutoff: Date,
    limit: number,
  ): Promise<readonly { readonly asset: FileAssetRow; readonly version: FileVersionRow }[]> {
    const rows = await tenantDrizzle(runner)
      .select({ asset: fileAssets, version: fileVersions })
      .from(fileAssets)
      .innerJoin(
        fileVersions,
        and(
          eq(fileVersions.organizationId, fileAssets.organizationId),
          eq(fileVersions.fileAssetId, fileAssets.id),
          eq(fileVersions.trustZone, 'quarantine'),
          eq(
            fileVersions.versionNo,
            sql`(select max(l.version_no) from file_versions l where l.organization_id = ${fileAssets.organizationId} and l.file_asset_id = ${fileAssets.id})`,
          ),
        ),
      )
      .where(
        and(
          eq(fileAssets.organizationId, context.organizationId),
          eq(fileAssets.status, 'rejected'),
          isNull(fileAssets.purgedAt),
          lt(fileAssets.updatedAt, cutoff),
        ),
      )
      .orderBy(asc(fileAssets.updatedAt), asc(fileAssets.id))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map((row) => ({ asset: row.asset, version: row.version }));
  }

  /**
   * FILE-003's one-shot claim: stamp `purged_at` on a `rejected`, not-yet-purged row,
   * conditional on its `version` (so two passes that selected it together cannot both take
   * it) and on `purged_at` still being NULL (so a second pass over an already-purged object
   * moves nothing). `true` when this call took it. Called inside the purge transaction,
   * after the provider bytes are gone (`49-PRICING` §6 step 8), so a committed claim means
   * the counter decrement and the ledger row beside it also committed.
   */
  async claimPurged(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: FileAssetRow,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(fileAssets)
      .set({
        purgedAt: sql`current_timestamp(3)`,
        version: sql`version + 1`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(fileAssets.organizationId, context.organizationId),
          eq(fileAssets.id, row.id),
          eq(fileAssets.status, 'rejected'),
          eq(fileAssets.version, row.version),
          isNull(fileAssets.purgedAt),
        ),
      );
    return result[0].affectedRows === 1;
  }

  async findVersionById(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileVersionId: string,
  ): Promise<FileVersionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(fileVersions)
      .where(
        and(
          eq(fileVersions.organizationId, context.organizationId),
          eq(fileVersions.id, fileVersionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The asset's newest version, or null before its first completion. */
  async findLatestVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
  ): Promise<FileVersionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(fileVersions)
      .where(
        and(
          eq(fileVersions.organizationId, context.organizationId),
          eq(fileVersions.fileAssetId, fileAssetId),
        ),
      )
      .orderBy(desc(fileVersions.versionNo))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * FILE-002 slice C. The asset and its **latest** version in one statement — the download
   * gate's read. Two reads (`findById`, then `findLatestVersion`) can describe two moments;
   * one join cannot. The version is `null` before the first completion. The latest version
   * is the greatest `version_no` in the asset's own organization — the same correlated
   * shape 0019's trigger and {@link awaitingScanVersion} use.
   */
  async findWithLatestVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
  ): Promise<{ readonly asset: FileAssetRow; readonly version: FileVersionRow | null } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ asset: fileAssets, version: fileVersions })
      .from(fileAssets)
      .leftJoin(
        fileVersions,
        and(
          eq(fileVersions.organizationId, fileAssets.organizationId),
          eq(fileVersions.fileAssetId, fileAssets.id),
          eq(
            fileVersions.versionNo,
            sql`(select max(l.version_no) from file_versions l where l.organization_id = ${fileAssets.organizationId} and l.file_asset_id = ${fileAssets.id})`,
          ),
        ),
      )
      .where(
        and(eq(fileAssets.organizationId, context.organizationId), eq(fileAssets.id, fileAssetId)),
      )
      .limit(1);
    const row = rows[0];
    return row ? { asset: row.asset, version: row.version ?? null } : null;
  }

  /**
   * x114. The client-visible files attached to one deliverable, each with its **latest**
   * version — the client portal's per-deliverable file list.
   *
   * Every predicate here is a security boundary, and each is in the query rather than a filter
   * afterwards (`25-AUTH` §7's rule about never carrying an internal row you then remember to
   * drop):
   *
   * - `organization_id` — the tenant, from the context.
   * - `purpose = 'deliverable'` and `object_id = deliverableId` — the files of *this* deliverable
   *   and no other row kind (`0016`'s purpose/object pairing).
   * - `audience IN (client_visible, client_action_required)` — never an `internal` file. A
   *   deliverable upload is `internal` by default (`purpose-policy.ts`); only a file explicitly
   *   marked client-facing is a file "shared to the client".
   * - `client_organization_id = clientOrganizationId` — `04-SECURITY-PRIVACY` §5: one client
   *   never sees another client organization's file, even inside a project both can read.
   * - `status = 'ready'` — `23-ERD` §10: a file is invisible until it is verified, scanned clean
   *   and promoted. A draft, scanning or rejected asset is not a shared file.
   *
   * The join is the same correlated-latest shape as {@link findWithLatestVersion}; the version is
   * present for every `ready` asset (an asset reaches `ready` only through a clean version), but
   * it is typed nullable and the caller drops any row without one rather than assume it.
   * Newest-first by `created_at`, then `id`, so the list is deterministic.
   */
  async listClientVisibleForDeliverable(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { readonly deliverableId: string; readonly clientOrganizationId: string },
  ): Promise<readonly { readonly asset: FileAssetRow; readonly version: FileVersionRow | null }[]> {
    const clientAudiences: readonly Audience[] = ['client_visible', 'client_action_required'];
    const rows = await tenantDrizzle(runner)
      .select({ asset: fileAssets, version: fileVersions })
      .from(fileAssets)
      .leftJoin(
        fileVersions,
        and(
          eq(fileVersions.organizationId, fileAssets.organizationId),
          eq(fileVersions.fileAssetId, fileAssets.id),
          eq(
            fileVersions.versionNo,
            sql`(select max(l.version_no) from file_versions l where l.organization_id = ${fileAssets.organizationId} and l.file_asset_id = ${fileAssets.id})`,
          ),
        ),
      )
      .where(
        and(
          eq(fileAssets.organizationId, context.organizationId),
          eq(fileAssets.purpose, 'deliverable'),
          eq(fileAssets.objectId, input.deliverableId),
          inArray(fileAssets.audience, clientAudiences),
          eq(fileAssets.clientOrganizationId, input.clientOrganizationId),
          eq(fileAssets.status, 'ready'),
        ),
      )
      .orderBy(desc(fileAssets.createdAt), desc(fileAssets.id));
    return rows.map((row) => ({ asset: row.asset, version: row.version ?? null }));
  }

  /**
   * FILE-003 · WEB-006. The request-attachment assets in one project, each with its **latest**
   * version and the `client_requests` row it hangs off (0016: a `request_attachment`'s `objectId`
   * names a client request). The join is `INNER`, so an asset whose `objectId` is NULL or names
   * no live request is not returned — a client's file door is a request's attachment or nothing.
   *
   * This returns **candidates**, not an already-authorized list: the client-organization relation
   * and the servable-version rule are applied by {@link PortalFileListService}, exactly as the
   * per-file download gate applies them, so the two client file paths refuse by one rule expressed
   * once. `client_organization_id` is read from the **request**, never the asset — an internal
   * upload against a client's request carries no client organization on the asset itself, the
   * distinction {@link FileDownloadService.gate} turns on. Newest first.
   */
  async listRequestAttachmentsForProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<
    readonly {
      readonly asset: FileAssetRow;
      readonly version: FileVersionRow | null;
      readonly request: {
        readonly id: string;
        readonly projectId: string;
        readonly clientOrganizationId: string;
      };
    }[]
  > {
    const rows = await tenantDrizzle(runner)
      .select({
        asset: fileAssets,
        version: fileVersions,
        requestId: clientRequests.id,
        requestProjectId: clientRequests.projectId,
        requestClientOrganizationId: clientRequests.clientOrganizationId,
      })
      .from(fileAssets)
      .innerJoin(
        clientRequests,
        and(
          eq(clientRequests.organizationId, fileAssets.organizationId),
          eq(clientRequests.id, fileAssets.objectId),
        ),
      )
      .leftJoin(
        fileVersions,
        and(
          eq(fileVersions.organizationId, fileAssets.organizationId),
          eq(fileVersions.fileAssetId, fileAssets.id),
          eq(
            fileVersions.versionNo,
            sql`(select max(l.version_no) from file_versions l where l.organization_id = ${fileAssets.organizationId} and l.file_asset_id = ${fileAssets.id})`,
          ),
        ),
      )
      .where(
        and(
          eq(fileAssets.organizationId, context.organizationId),
          eq(fileAssets.projectId, projectId),
          eq(fileAssets.purpose, 'request_attachment'),
          // F48. Only client audiences are candidates: a staff attachment marked `internal` on a
          // client's request is never a client's file, whatever the service does next.
          inArray(fileAssets.audience, ['client_visible', 'client_action_required']),
        ),
      )
      .orderBy(desc(fileAssets.createdAt), desc(fileAssets.id));
    return rows.map((row) => ({
      asset: row.asset,
      version: row.version ?? null,
      request: {
        id: row.requestId,
        projectId: row.requestProjectId,
        clientOrganizationId: row.requestClientOrganizationId,
      },
    }));
  }

  /**
   * Append the asset's next version. The number is allocated from the asset's own rows
   * inside the caller's transaction, and `uq_file_versions_org_asset_no` refuses a duplicate
   * if two completions ever reach here for one asset at once.
   */
  async createVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateFileVersionInput,
  ): Promise<FileVersionRow> {
    const [latest] = await tenantDrizzle(runner)
      .select({ max: sql<number | null>`max(${fileVersions.versionNo})` })
      .from(fileVersions)
      .where(
        and(
          eq(fileVersions.organizationId, context.organizationId),
          eq(fileVersions.fileAssetId, input.fileAssetId),
        ),
      );
    const versionNo = Number(latest?.max ?? 0) + 1;

    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(fileVersions)
      .values({
        id,
        organizationId: context.organizationId,
        fileAssetId: input.fileAssetId,
        versionNo,
        objectKey: input.objectKey,
        sizeBytes: input.sizeBytes,
        declaredMimeType: input.declaredMimeType,
        etag: input.etag,
        createdAt: sql`current_timestamp(3)`,
      });
    const row = await this.findVersionById(runner, context, id);
    if (!row) throw new FileAssetNotFoundError(input.fileAssetId);
    return row;
  }
}
