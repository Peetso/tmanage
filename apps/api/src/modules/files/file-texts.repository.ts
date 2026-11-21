import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { aiFileTexts, fileAssets, fileVersions } from '../../common/database/schema.js';
import type { AiFileTextRow } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * 62-23 (0393) — the extracted text of a workspace's files, once per (workspace, content hash),
 * and the queue the text job works from (`file-text-job.ts`). Every statement names the
 * organization (DA-12); every time is a bound `Date` (DA-10).
 *
 * A version is a candidate only when it is servable — asset `ready` and not deleted, version
 * `clean` and promoted to `private` (the AR-8 rule, `isServableVersion`; the job re-checks it with
 * that function before reading a byte) — of a type the job reads, with a content hash. Unscanned
 * files are never read: the AI layer reads only what passed the malware scan (plan 62 §4.5).
 */

export const FILE_TEXT_MAX_ATTEMPTS = 3;

export type FileText = Pick<
  AiFileTextRow,
  'id' | 'organizationId' | 'contentHash' | 'mimeType' | 'status' | 'attempts' | 'claimedAt'
>;

/** A hash the job should plan a row for, with one servable version that holds it. */
export interface HashNeedingText {
  readonly contentHash: string;
  readonly mimeType: string;
}

export interface ConcludedText {
  readonly status: 'ready' | 'unsupported' | 'failed';
  readonly reasonCode: string | null;
  readonly extractor: string | null;
  readonly body: string | null;
  readonly pageCount: number | null;
  readonly truncated: boolean;
}

function affected(result: unknown): number {
  const header = Array.isArray(result) ? (result[0] as unknown) : result;
  const rows = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}

/** A version the download door would serve (AR-8), as SQL. */
function servableVersion() {
  return and(
    eq(fileVersions.trustZone, 'private'),
    eq(fileVersions.scanVerdict, 'clean'),
    isNotNull(fileVersions.contentHash),
    exists(
      sql`(select 1 from ${fileAssets} where ${fileAssets.organizationId} = ${fileVersions.organizationId}
        and ${fileAssets.id} = ${fileVersions.fileAssetId}
        and ${fileAssets.status} = ${'ready'}
        and ${fileAssets.deletedAt} is null
        and ${fileAssets.purgedAt} is null)`,
    ),
  );
}

function needsText(mimeTypes: readonly string[]) {
  return and(
    servableVersion(),
    inArray(fileVersions.detectedMimeType, [...mimeTypes]),
    notExists(
      sql`(select 1 from ${aiFileTexts} where ${aiFileTexts.organizationId} = ${fileVersions.organizationId}
        and ${aiFileTexts.contentHash} = ${fileVersions.contentHash})`,
    ),
  );
}

/** A text row whose hash no live version in its workspace holds any more. */
function orphaned() {
  return notExists(
    sql`(select 1 from ${fileVersions} join ${fileAssets}
        on ${fileAssets.organizationId} = ${fileVersions.organizationId}
        and ${fileAssets.id} = ${fileVersions.fileAssetId}
      where ${fileVersions.organizationId} = ${aiFileTexts.organizationId}
        and ${fileVersions.contentHash} = ${aiFileTexts.contentHash}
        and ${fileAssets.deletedAt} is null
        and ${fileAssets.purgedAt} is null
        and ${fileAssets.status} <> ${'rejected'})`,
  );
}

function claimable(staleBefore: Date) {
  return and(
    eq(aiFileTexts.status, 'pending'),
    or(isNull(aiFileTexts.claimedAt), lt(aiFileTexts.claimedAt, staleBefore)),
  );
}

const COLUMNS = {
  id: aiFileTexts.id,
  organizationId: aiFileTexts.organizationId,
  contentHash: aiFileTexts.contentHash,
  mimeType: aiFileTexts.mimeType,
  status: aiFileTexts.status,
  attempts: aiFileTexts.attempts,
  claimedAt: aiFileTexts.claimedAt,
};

export class FileTextsRepository {
  /** The discovery's cross-tenant half: workspaces with work for the job (through bootstrap). */
  async organizationsWithWork(
    runner: BootstrapQueryRunner,
    mimeTypes: readonly string[],
    staleBefore: Date,
  ): Promise<readonly string[]> {
    const db = tenantDrizzle(runner);
    const needing =
      mimeTypes.length === 0
        ? []
        : await db
            .selectDistinct({ organizationId: fileVersions.organizationId })
            .from(fileVersions)
            .where(needsText(mimeTypes));
    const pending = await db
      .selectDistinct({ organizationId: aiFileTexts.organizationId })
      .from(aiFileTexts)
      .where(or(claimable(staleBefore), orphaned()));
    return [...new Set([...needing, ...pending].map((row) => row.organizationId))].sort();
  }

  /** Distinct hashes with a servable version of a readable type and no text row yet. */
  async listHashesNeedingText(
    runner: TenantQueryRunner,
    context: TenantContext,
    mimeTypes: readonly string[],
    limit: number,
  ): Promise<readonly HashNeedingText[]> {
    if (mimeTypes.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({
        contentHash: fileVersions.contentHash,
        mimeType: sql<string>`min(${fileVersions.detectedMimeType})`,
      })
      .from(fileVersions)
      .where(and(eq(fileVersions.organizationId, context.organizationId), needsText(mimeTypes)))
      .groupBy(fileVersions.contentHash)
      .orderBy(asc(fileVersions.contentHash))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.flatMap((row) =>
      row.contentHash === null || row.mimeType === null
        ? []
        : [{ contentHash: row.contentHash, mimeType: row.mimeType }],
    );
  }

  /** The row for a hash, `pending`; a second plan of the same hash is a no-op (unique key). */
  async ensurePending(
    runner: TenantQueryRunner,
    context: TenantContext,
    hash: HashNeedingText,
    now: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(aiFileTexts)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        contentHash: hash.contentHash,
        mimeType: hash.mimeType,
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({ set: { contentHash: sql`content_hash` } });
  }

  async listClaimable(
    runner: TenantQueryRunner,
    context: TenantContext,
    staleBefore: Date,
    limit: number,
  ): Promise<readonly FileText[]> {
    return tenantDrizzle(runner)
      .select(COLUMNS)
      .from(aiFileTexts)
      .where(and(eq(aiFileTexts.organizationId, context.organizationId), claimable(staleBefore)))
      .orderBy(asc(aiFileTexts.createdAt), asc(aiFileTexts.id))
      .limit(Math.min(Math.max(limit, 1), 100));
  }

  /** Take a row for this pass, conditional on it still being pending, unheld and unchanged. */
  async claim(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: Pick<FileText, 'id' | 'attempts'>,
    now: Date,
    staleBefore: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(aiFileTexts)
      .set({ claimedAt: now, updatedAt: now })
      .where(
        and(
          eq(aiFileTexts.organizationId, context.organizationId),
          eq(aiFileTexts.id, row.id),
          eq(aiFileTexts.attempts, row.attempts),
          claimable(staleBefore),
        ),
      );
    return affected(result) === 1;
  }

  /** One servable version holding the hash, to read the bytes from; `null` when none is left. */
  async findVersionForHash(
    runner: TenantQueryRunner,
    context: TenantContext,
    contentHash: string,
  ): Promise<{ readonly fileAssetId: string; readonly fileVersionId: string } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ fileAssetId: fileVersions.fileAssetId, fileVersionId: fileVersions.id })
      .from(fileVersions)
      .where(
        and(
          eq(fileVersions.organizationId, context.organizationId),
          eq(fileVersions.contentHash, contentHash),
          servableVersion(),
        ),
      )
      .orderBy(asc(fileVersions.createdAt), asc(fileVersions.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** The final state of a claimed row; `false` when another pass concluded it first. */
  async conclude(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    outcome: ConcludedText,
    now: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(aiFileTexts)
      .set({
        status: outcome.status,
        reasonCode: outcome.reasonCode,
        extractor: outcome.extractor,
        body: outcome.body,
        charCount: outcome.body === null ? 0 : [...outcome.body].length,
        pageCount: outcome.pageCount,
        truncated: outcome.truncated,
        claimedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(aiFileTexts.organizationId, context.organizationId),
          eq(aiFileTexts.id, id),
          eq(aiFileTexts.status, 'pending'),
        ),
      );
    return affected(result) === 1;
  }

  /**
   * A fault that is not the file's (the store): one attempt counted, the claim kept until the
   * stale bound; `failed` with the code after {@link FILE_TEXT_MAX_ATTEMPTS}.
   */
  async recordAttempt(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: Pick<FileText, 'id' | 'attempts'>,
    code: string,
    now: Date,
  ): Promise<'retrying' | 'failed' | 'not_pending'> {
    const attempts = row.attempts + 1;
    const last = attempts >= FILE_TEXT_MAX_ATTEMPTS;
    const result = await tenantDrizzle(runner)
      .update(aiFileTexts)
      .set({
        attempts,
        reasonCode: code,
        updatedAt: now,
        ...(last ? { status: 'failed' as const, claimedAt: null } : {}),
      })
      .where(
        and(
          eq(aiFileTexts.organizationId, context.organizationId),
          eq(aiFileTexts.id, row.id),
          eq(aiFileTexts.status, 'pending'),
          eq(aiFileTexts.attempts, row.attempts),
        ),
      );
    if (affected(result) !== 1) return 'not_pending';
    return last ? 'failed' : 'retrying';
  }

  /** Deletes up to `limit` rows whose hash no live version holds (a deleted or purged file). */
  async deleteOrphans(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit: number,
  ): Promise<number> {
    const db = tenantDrizzle(runner);
    const ids = await db
      .select({ id: aiFileTexts.id })
      .from(aiFileTexts)
      .where(and(eq(aiFileTexts.organizationId, context.organizationId), orphaned()))
      .orderBy(asc(aiFileTexts.id))
      .limit(Math.min(Math.max(limit, 1), 500));
    if (ids.length === 0) return 0;
    const result = await db.delete(aiFileTexts).where(
      and(
        eq(aiFileTexts.organizationId, context.organizationId),
        inArray(
          aiFileTexts.id,
          ids.map((row) => row.id),
        ),
        orphaned(),
      ),
    );
    return affected(result);
  }
}
