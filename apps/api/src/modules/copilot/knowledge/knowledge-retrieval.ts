import type { Principal } from '@tmanage/domain';
import { isServableVersion } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../../common/database/tenant-context.js';
import { mayReadHit } from '../../search/search-permission.js';
import type { EmbeddingProvider } from './embeddings.js';
import type {
  ChunkVectorStore,
  FetchedChunk,
  KnowledgeRepository,
  RankedChunk,
  RetrievalScope,
} from './knowledge.repository.js';

/**
 * 62-24 (plan 62 §4.4 level 3, §4.5, §7 "Retrieval leaks") — file passages for one member's
 * question, permission-aware by construction:
 *
 * 1. **Filter before rank.** The scope is the workspace and the member's projects (all of them
 *    only with org-wide scope), narrowed to one project when asked. Both rankers run inside it.
 * 2. **Hybrid rank.** The vector store (when a provider is configured) and FULLTEXT each return
 *    their top {@link CANDIDATES}; reciprocal rank fusion (k = 60) merges them. No provider =
 *    FULLTEXT alone, the plan's fallback.
 * 3. **Re-check on fetch.** Every candidate is read back with its file and dropped unless the file
 *    is still live and servable (`isServableVersion` facts on the asset) and the member may open
 *    it — the search's per-hit rule for files (`mayReadHit`, kind `file`: purpose policy and
 *    `file.download` on the file's project, audience and client). A client principal gets
 *    nothing: the files relation is not resolved here, and `mayReadHit` refuses without it.
 *
 * What comes back is passage text other people wrote: the caller marks it untrusted (62-12).
 */

export const CANDIDATES = 20;
export const RRF_K = 60;
export const DEFAULT_PASSAGES = 6;
export const MAX_PASSAGES = 10;

export interface Passage {
  readonly fileId: string;
  readonly fileName: string;
  readonly projectId: string;
  readonly pageNo: number | null;
  readonly chunkNo: number;
  readonly text: string;
  readonly score: number;
}

/** Pure: reciprocal rank fusion of ranked lists, best first, ties by id. */
export function fuseRanks(lists: readonly (readonly RankedChunk[])[], k = RRF_K): RankedChunk[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((hit, index) => {
      scores.set(hit.chunkId, (scores.get(hit.chunkId) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([chunkId, score]) => ({ chunkId, score }))
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
}

/** The member's scope: the workspace's projects they are on, or every one with org-wide scope. */
export function retrievalScope(principal: Principal, projectId?: string): RetrievalScope {
  return {
    projectIds: principal.hasOrgWideScope ? null : [...principal.projectIds],
    ...(projectId === undefined ? {} : { projectId }),
  };
}

/** Pure: whether a fetched passage may go to this member (the re-check). */
export function mayReadPassage(principal: Principal, chunk: FetchedChunk): boolean {
  const asset = chunk.asset;
  if (asset === null || asset.deletedAt !== null || asset.purgedAt !== null) return false;
  if (asset.projectId !== chunk.projectId) return false;
  // The asset half of the servable rule; the version half is the passage's own provenance
  // (written only from a clean, promoted version's text, deleted when that version changes).
  if (!isServableVersion({ status: asset.status, scanVerdict: 'clean', trustZone: 'private' })) {
    return false;
  }
  return mayReadHit(principal, {
    organizationId: asset.organizationId,
    projectId: asset.projectId,
    targetKind: 'file',
    targetId: asset.id,
    title: asset.name,
    audience: asset.audience,
    updatedAt: asset.updatedAt,
    clientOrganizationId: asset.clientOrganizationId,
    asset,
  });
}

export class KnowledgeRetrieval {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: KnowledgeRepository,
    private readonly store: ChunkVectorStore,
    private readonly embeddings: EmbeddingProvider | null,
  ) {}

  async passages(
    context: TenantContext,
    principal: Principal,
    query: string,
    options: { readonly projectId?: string; readonly limit?: number } = {},
  ): Promise<readonly Passage[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PASSAGES, 1), MAX_PASSAGES);
    const scope = retrievalScope(principal, options.projectId);
    const vector =
      this.embeddings === null
        ? null
        : ((await this.embeddings.embed([query], 'query'))[0] ?? null);
    return this.database.read(context, async (runner) => {
      const lists = [
        await this.repository.keywordRank(runner, context, scope, query, CANDIDATES),
        ...(vector === null
          ? []
          : [await this.store.nearest(runner, context, scope, vector, CANDIDATES)]),
      ];
      const fused = fuseRanks(lists);
      const fetched = await this.repository.fetch(
        runner,
        context,
        fused.map((hit) => hit.chunkId),
      );
      const byId = new Map(fetched.map((chunk) => [chunk.id, chunk]));
      const out: Passage[] = [];
      for (const hit of fused) {
        const chunk = byId.get(hit.chunkId);
        if (chunk === undefined || !mayReadPassage(principal, chunk)) continue;
        out.push({
          fileId: chunk.fileAssetId,
          fileName: chunk.asset!.name,
          projectId: chunk.projectId,
          pageNo: chunk.pageNo,
          chunkNo: chunk.chunkNo,
          text: chunk.body,
          score: hit.score,
        });
        if (out.length >= limit) break;
      }
      return out;
    });
  }
}
