import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { tenantDrizzle } from '../../../common/database/drizzle.js';
import {
  aiFileChunks,
  aiFileTexts,
  fileAssets,
  fileVersions,
} from '../../../common/database/schema.js';
import type { FileAssetRow } from '../../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../../common/database/tenant-context.js';
import { cosineDistance, parseVectorText, vectorText } from './embeddings.js';

/**
 * 62-24 (0394) — the passages of the workspace's files and the two vector stores over them.
 *
 * Every read names the organization (DA-12) and, for retrieval, the member's project scope
 * **before** anything is ranked ({@link RetrievalScope}): the ranking never sees a passage of a
 * project the member is not on, so it can neither leak one nor run short of results because of
 * one. Each hit is still re-checked on fetch by the retrieval service (the file's own read rule).
 *
 * A file's passages follow its **current** servable version: the latest `clean`, `private`
 * version of a `ready`, live asset whose text is `ready` in `ai_file_texts`. When that version
 * changes (a new upload), or the file is deleted, purged or rejected, the passages are stale and
 * are deleted ({@link KnowledgeRepository.deleteStale}); the soft delete and a move out of `ready`
 * also delete them in their own transaction (`deleteFileChunks`, `files/file-texts.repository.ts`).
 */

/** Which passages a retrieval may rank: the workspace, then the member's projects. */
export interface RetrievalScope {
  /** `null` = every project of the workspace (org-wide scope). */
  readonly projectIds: readonly string[] | null;
  /** Narrowed to one project by the caller (already checked visible). */
  readonly projectId?: string;
}

export interface RankedChunk {
  readonly chunkId: string;
  readonly score: number;
}

export interface AssetNeedingChunks {
  readonly fileAssetId: string;
  readonly projectId: string;
  readonly audience: FileAssetRow['audience'];
  readonly contentHash: string;
  readonly body: string;
}

export interface NewChunk {
  readonly id: string;
  readonly fileAssetId: string;
  readonly projectId: string;
  readonly audience: FileAssetRow['audience'];
  readonly contentHash: string;
  readonly chunkNo: number;
  readonly pageNo: number | null;
  readonly body: string;
  readonly embedding: Float32Array | null;
  readonly embeddingModel: string | null;
}

export interface FetchedChunk {
  readonly id: string;
  readonly fileAssetId: string;
  readonly projectId: string;
  readonly chunkNo: number;
  readonly pageNo: number | null;
  readonly body: string;
  readonly asset: FileAssetRow | null;
}

function affected(result: unknown): number {
  const header = Array.isArray(result) ? (result[0] as unknown) : result;
  const rows = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}

/**
 * The content hash of an asset's current servable version (latest version number, clean,
 * promoted, asset ready and live), as a correlated subquery on `file_assets`.
 */
function currentHashOf(organizationId: SQL | string, assetId: SQL): SQL {
  return sql`(select v.content_hash from ${fileVersions} v
    where v.organization_id = ${organizationId} and v.file_asset_id = ${assetId}
      and v.trust_zone = 'private' and v.scan_verdict = 'clean' and v.content_hash is not null
    order by v.version_no desc limit 1)`;
}

function liveAsset() {
  return and(
    eq(fileAssets.status, 'ready'),
    sql`${fileAssets.deletedAt} is null`,
    sql`${fileAssets.purgedAt} is null`,
  );
}

/** A passage whose file is gone, no longer live, or whose current version holds other bytes. */
function stale(): SQL {
  return sql`not exists (select 1 from ${fileAssets}
    where ${fileAssets.organizationId} = ${aiFileChunks.organizationId}
      and ${fileAssets.id} = ${aiFileChunks.fileAssetId}
      and ${fileAssets.status} = 'ready'
      and ${fileAssets.deletedAt} is null
      and ${fileAssets.purgedAt} is null
      and ${currentHashOf(sql`${fileAssets.organizationId}`, sql`${fileAssets.id}`)} = ${aiFileChunks.contentHash})`;
}

function needsChunks(): SQL {
  const hash = currentHashOf(sql`${fileAssets.organizationId}`, sql`${fileAssets.id}`);
  return sql`${liveAsset()}
    and exists (select 1 from ${aiFileTexts} t
      where t.organization_id = ${fileAssets.organizationId} and t.content_hash = ${hash}
        and t.status = 'ready')
    and not exists (select 1 from ${aiFileChunks} c
      where c.organization_id = ${fileAssets.organizationId} and c.file_asset_id = ${fileAssets.id})`;
}

function scoped(context: TenantContext, scope: RetrievalScope): SQL | undefined {
  return and(
    eq(aiFileChunks.organizationId, context.organizationId),
    scope.projectId === undefined ? undefined : eq(aiFileChunks.projectId, scope.projectId),
    scope.projectIds === null ? undefined : inArray(aiFileChunks.projectId, [...scope.projectIds]),
  );
}

function emptyScope(scope: RetrievalScope): boolean {
  return scope.projectIds !== null && scope.projectIds.length === 0;
}

export class KnowledgeRepository {
  /** Cross-tenant discovery through bootstrap: workspaces with passages to write or delete. */
  async organizationsWithWork(runner: BootstrapQueryRunner): Promise<readonly string[]> {
    const db = tenantDrizzle(runner);
    const needing = await db
      .selectDistinct({ organizationId: fileAssets.organizationId })
      .from(fileAssets)
      .where(needsChunks());
    const old = await db
      .selectDistinct({ organizationId: aiFileChunks.organizationId })
      .from(aiFileChunks)
      .where(stale());
    return [...new Set([...needing, ...old].map((row) => row.organizationId))].sort();
  }

  async listAssetsNeedingChunks(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit: number,
  ): Promise<readonly AssetNeedingChunks[]> {
    const hash = currentHashOf(sql`${fileAssets.organizationId}`, sql`${fileAssets.id}`);
    const rows = await tenantDrizzle(runner)
      .select({
        fileAssetId: fileAssets.id,
        projectId: fileAssets.projectId,
        audience: fileAssets.audience,
        contentHash: sql<string>`${hash}`,
        body: sql<string>`(select t.body from ${aiFileTexts} t
          where t.organization_id = ${fileAssets.organizationId} and t.content_hash = ${hash}
            and t.status = 'ready' limit 1)`,
      })
      .from(fileAssets)
      .where(and(eq(fileAssets.organizationId, context.organizationId), needsChunks()))
      .orderBy(asc(fileAssets.id))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.filter((row) => typeof row.body === 'string' && row.body !== '');
  }

  /** Vectors already paid for: the same bytes' passages under another file, this model. */
  async knownEmbeddings(
    runner: TenantQueryRunner,
    context: TenantContext,
    contentHash: string,
    model: string,
  ): Promise<ReadonlyMap<number, Float32Array>> {
    const rows = await tenantDrizzle(runner)
      .select({
        chunkNo: aiFileChunks.chunkNo,
        vector: sql<string>`VEC_ToText(${aiFileChunks.embedding})`,
      })
      .from(aiFileChunks)
      .where(
        and(
          eq(aiFileChunks.organizationId, context.organizationId),
          eq(aiFileChunks.contentHash, contentHash),
          eq(aiFileChunks.embeddingModel, model),
          isNotNull(aiFileChunks.embedding),
        ),
      );
    const known = new Map<number, Float32Array>();
    for (const row of rows) {
      const vector = typeof row.vector === 'string' ? parseVectorText(row.vector) : null;
      if (vector !== null && !known.has(row.chunkNo)) known.set(row.chunkNo, vector);
    }
    return known;
  }

  async insertChunks(
    runner: TenantQueryRunner,
    context: TenantContext,
    chunks: readonly NewChunk[],
    now: Date,
  ): Promise<void> {
    if (chunks.length === 0) return;
    await tenantDrizzle(runner)
      .insert(aiFileChunks)
      .values(
        chunks.map((chunk) => ({
          id: chunk.id,
          organizationId: context.organizationId,
          projectId: chunk.projectId,
          fileAssetId: chunk.fileAssetId,
          contentHash: chunk.contentHash,
          chunkNo: chunk.chunkNo,
          pageNo: chunk.pageNo,
          audience: chunk.audience,
          body: chunk.body,
          embedding:
            chunk.embedding === null
              ? null
              : (sql`VEC_FromText(${vectorText(chunk.embedding)})` as unknown as string),
          embeddingModel: chunk.embedding === null ? null : chunk.embeddingModel,
          createdAt: now,
          updatedAt: now,
        })),
      );
  }

  /** Deletes up to `limit` stale passages (see {@link stale}). */
  async deleteStale(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit: number,
  ): Promise<number> {
    const db = tenantDrizzle(runner);
    const ids = await db
      .select({ id: aiFileChunks.id })
      .from(aiFileChunks)
      .where(and(eq(aiFileChunks.organizationId, context.organizationId), stale()))
      .limit(Math.min(Math.max(limit, 1), 1000));
    if (ids.length === 0) return 0;
    const result = await db.delete(aiFileChunks).where(
      and(
        eq(aiFileChunks.organizationId, context.organizationId),
        inArray(
          aiFileChunks.id,
          ids.map((row) => row.id),
        ),
      ),
    );
    return affected(result);
  }

  /**
   * The dirty hook's catch-up: a passage carries its file's project and audience for the filter;
   * where the file's differ (moved, re-audienced), the passage takes the file's.
   */
  async resyncScope(runner: TenantQueryRunner, context: TenantContext): Promise<number> {
    const result = await tenantDrizzle(runner).execute(sql`update ${aiFileChunks} c
      join ${fileAssets} a on a.organization_id = c.organization_id and a.id = c.file_asset_id
      set c.project_id = a.project_id, c.audience = a.audience
      where c.organization_id = ${context.organizationId}
        and (c.project_id <> a.project_id or c.audience <> a.audience)`);
    return affected(result);
  }

  /** FULLTEXT rank inside the scope. */
  async keywordRank(
    runner: TenantQueryRunner,
    context: TenantContext,
    scope: RetrievalScope,
    query: string,
    k: number,
  ): Promise<readonly RankedChunk[]> {
    if (emptyScope(scope) || query.trim() === '') return [];
    const score = sql<number>`MATCH(${aiFileChunks.body}) AGAINST (${query} IN NATURAL LANGUAGE MODE)`;
    const rows = await tenantDrizzle(runner)
      .select({ chunkId: aiFileChunks.id, score })
      .from(aiFileChunks)
      .where(and(scoped(context, scope), sql`${score} > 0`))
      .orderBy(sql`${score} desc`, asc(aiFileChunks.id))
      .limit(Math.min(Math.max(k, 1), 100));
    return rows.map((row) => ({ chunkId: row.chunkId, score: Number(row.score) }));
  }

  /** The passages and their files, for the per-hit re-check. */
  async fetch(
    runner: TenantQueryRunner,
    context: TenantContext,
    ids: readonly string[],
  ): Promise<readonly FetchedChunk[]> {
    if (ids.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({ chunk: aiFileChunks, asset: fileAssets })
      .from(aiFileChunks)
      .leftJoin(
        fileAssets,
        and(
          eq(fileAssets.organizationId, aiFileChunks.organizationId),
          eq(fileAssets.id, aiFileChunks.fileAssetId),
        ),
      )
      .where(
        and(
          eq(aiFileChunks.organizationId, context.organizationId),
          inArray(aiFileChunks.id, [...ids]),
        ),
      );
    return rows.map(({ chunk, asset }) => ({
      id: chunk.id,
      fileAssetId: chunk.fileAssetId,
      projectId: chunk.projectId,
      chunkNo: chunk.chunkNo,
      pageNo: chunk.pageNo,
      body: chunk.body,
      asset,
    }));
  }
}

/** The vector half of retrieval: one interface, two stores (plan §4.5). */
export interface ChunkVectorStore {
  readonly name: 'mariadb_vector' | 'node_cosine';
  nearest(
    runner: TenantQueryRunner,
    context: TenantContext,
    scope: RetrievalScope,
    query: Float32Array,
    k: number,
  ): Promise<readonly RankedChunk[]>;
}

/** MariaDB 11.8: exact cosine scan inside the scope, no vector index (P0-proven). */
export class MariaDbVectorStore implements ChunkVectorStore {
  readonly name = 'mariadb_vector' as const;

  async nearest(
    runner: TenantQueryRunner,
    context: TenantContext,
    scope: RetrievalScope,
    query: Float32Array,
    k: number,
  ): Promise<readonly RankedChunk[]> {
    if (emptyScope(scope)) return [];
    const distance = sql<number>`VEC_DISTANCE_COSINE(${aiFileChunks.embedding}, VEC_FromText(${vectorText(query)}))`;
    const rows = await tenantDrizzle(runner)
      .select({ chunkId: aiFileChunks.id, distance })
      .from(aiFileChunks)
      .where(and(scoped(context, scope), isNotNull(aiFileChunks.embedding)))
      .orderBy(distance, asc(aiFileChunks.id))
      .limit(Math.min(Math.max(k, 1), 100));
    return rows.map((row) => ({ chunkId: row.chunkId, score: 1 - Number(row.distance) }));
  }
}

/**
 * The fallback: the scope's vectors read as text, cosine in Node over that subset only. Bounded
 * at `maxScan` passages (most recent first); a workspace past it should use the MariaDB store.
 */
export class NodeCosineVectorStore implements ChunkVectorStore {
  readonly name = 'node_cosine' as const;

  constructor(private readonly maxScan = 5_000) {}

  async nearest(
    runner: TenantQueryRunner,
    context: TenantContext,
    scope: RetrievalScope,
    query: Float32Array,
    k: number,
  ): Promise<readonly RankedChunk[]> {
    if (emptyScope(scope)) return [];
    const rows = await tenantDrizzle(runner)
      .select({
        chunkId: aiFileChunks.id,
        vector: sql<string>`VEC_ToText(${aiFileChunks.embedding})`,
      })
      .from(aiFileChunks)
      .where(and(scoped(context, scope), isNotNull(aiFileChunks.embedding)))
      .orderBy(sql`${aiFileChunks.updatedAt} desc`, asc(aiFileChunks.id))
      .limit(this.maxScan);
    return rankByCosine(rows, query, k);
  }
}

/** Pure: nearest first, ties by id; rows whose vector does not parse are skipped. */
export function rankByCosine(
  rows: readonly { readonly chunkId: string; readonly vector: string | null }[],
  query: Float32Array,
  k: number,
): RankedChunk[] {
  return rows
    .flatMap((row) => {
      const vector = row.vector === null ? null : parseVectorText(row.vector);
      return vector === null
        ? []
        : [{ chunkId: row.chunkId, score: 1 - cosineDistance(vector, query) }];
    })
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
    .slice(0, Math.max(k, 0));
}
