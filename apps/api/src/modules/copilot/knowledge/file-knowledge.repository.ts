import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../../common/database/drizzle.js';
import {
  aiFileSummaries,
  aiFileTexts,
  fileAssets,
  fileVersions,
} from '../../../common/database/schema.js';
import type {
  AiFileTextRow,
  FileAssetRow,
  FileVersionRow,
} from '../../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../../common/database/tenant-context.js';
import { currentHashOf } from './knowledge.repository.js';

/**
 * 62-25 (0397) — what the AI layer holds about one file: its current servable version's text row
 * (`ai_file_texts`, 62-23) and the cached summary of those bytes for the file's audience
 * (`ai_file_summaries`). Every statement names the organization (DA-12); every time is a bound
 * `Date` (DA-10). Whether the member may read any of it is the service's check
 * (`mayReadFileAsset`), on the asset row read here.
 *
 * A summary is keyed by content hash and audience (plan 62 §4.5): the same bytes uploaded twice
 * are summarised once; a client-visible file never reads a summary written for an internal one.
 * It lives as long as a text row holds its hash: the knowledge index job deletes the rest
 * (`KnowledgeRepository.deleteOrphanSummaries`).
 */

export type FileTextState = Pick<
  AiFileTextRow,
  'id' | 'status' | 'reasonCode' | 'charCount' | 'pageCount' | 'truncated' | 'body'
>;

export interface FileSummaryState {
  readonly summary: string;
  readonly model: string;
}

export interface FileKnowledgeState {
  readonly asset: FileAssetRow;
  /** The current servable version's content hash; `null` while none is clean and promoted. */
  readonly contentHash: string | null;
  readonly text: FileTextState | null;
  readonly summary: FileSummaryState | null;
}

export interface NewFileSummary {
  readonly textId: string;
  readonly audience: FileAssetRow['audience'];
  readonly summary: string;
  readonly model: string;
}

export class FileKnowledgeRepository {
  async read(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
  ): Promise<FileKnowledgeState | null> {
    const db = tenantDrizzle(runner);
    const hash = currentHashOf(sql`${fileAssets.organizationId}`, sql`${fileAssets.id}`);
    const assets = await db
      .select({ asset: fileAssets, contentHash: sql<string | null>`${hash}` })
      .from(fileAssets)
      .where(
        and(eq(fileAssets.organizationId, context.organizationId), eq(fileAssets.id, fileAssetId)),
      )
      .limit(1);
    const found = assets[0];
    if (found === undefined) return null;
    const contentHash = typeof found.contentHash === 'string' ? found.contentHash : null;
    if (contentHash === null) return { asset: found.asset, contentHash, text: null, summary: null };
    const texts = await db
      .select({
        id: aiFileTexts.id,
        status: aiFileTexts.status,
        reasonCode: aiFileTexts.reasonCode,
        charCount: aiFileTexts.charCount,
        pageCount: aiFileTexts.pageCount,
        truncated: aiFileTexts.truncated,
        body: aiFileTexts.body,
      })
      .from(aiFileTexts)
      .where(
        and(
          eq(aiFileTexts.organizationId, context.organizationId),
          eq(aiFileTexts.contentHash, contentHash),
        ),
      )
      .limit(1);
    const summaries = await db
      .select({ summary: aiFileSummaries.summary, model: aiFileSummaries.model })
      .from(aiFileSummaries)
      .where(
        and(
          eq(aiFileSummaries.organizationId, context.organizationId),
          eq(aiFileSummaries.contentHash, contentHash),
          eq(aiFileSummaries.audience, found.asset.audience),
        ),
      )
      .limit(1);
    return {
      asset: found.asset,
      contentHash,
      text: texts[0] ?? null,
      summary: summaries[0] ?? null,
    };
  }

  /**
   * The asset's current version as the AI layer reads it: the newest clean version promoted to
   * `private` with a content hash (the version `currentHashOf` names). The caller re-checks it with
   * `isServableVersion` before reading a byte (AR-8).
   */
  async currentVersion(
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
          eq(fileVersions.trustZone, 'private'),
          eq(fileVersions.scanVerdict, 'clean'),
          isNotNull(fileVersions.contentHash),
        ),
      )
      .orderBy(desc(fileVersions.versionNo))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Records (or replaces) the summary of a text row's bytes for one audience. `false` when the
   * text row is gone (the file changed or was deleted meanwhile): nothing is written.
   */
  async upsertSummary(
    runner: TenantQueryRunner,
    context: TenantContext,
    summary: NewFileSummary,
    now: Date,
  ): Promise<boolean> {
    const db = tenantDrizzle(runner);
    const texts = await db
      .select({ contentHash: aiFileTexts.contentHash })
      .from(aiFileTexts)
      .where(
        and(
          eq(aiFileTexts.organizationId, context.organizationId),
          eq(aiFileTexts.id, summary.textId),
        ),
      )
      .limit(1);
    const contentHash = texts[0]?.contentHash;
    if (contentHash === undefined) return false;
    await db
      .insert(aiFileSummaries)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        contentHash,
        audience: summary.audience,
        summary: summary.summary,
        model: summary.model,
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: { summary: summary.summary, model: summary.model, updatedAt: now },
      });
    return true;
  }
}
