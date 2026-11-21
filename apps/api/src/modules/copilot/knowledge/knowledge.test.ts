import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { FileAssetRow } from '../../../common/database/schema.js';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { MAX_CHARS, chunkText } from './chunker.js';
import {
  EMBEDDING_DIMENSIONS,
  HashingEmbeddingProvider,
  cosineDistance,
  parseVectorText,
  vectorText,
} from './embeddings.js';
import { KnowledgeIndexJob } from './knowledge-index-job.js';
import {
  KnowledgeRetrieval,
  fuseRanks,
  mayReadPassage,
  retrievalScope,
} from './knowledge-retrieval.js';
import { rankByCosine } from './knowledge.repository.js';
import type {
  AssetNeedingChunks,
  ChunkVectorStore,
  FetchedChunk,
  KnowledgeRepository,
  NewChunk,
  RankedChunk,
  RetrievalScope,
} from './knowledge.repository.js';

/**
 * 62-24 §9 row: "retrieval-leak tests (§7)". §7: a member without project access gets no chunk and
 * no hint a file exists; access removed → next query returns nothing; deleted file → chunks gone.
 * The SQL half (both vector stores over the same suite, the filter in SQL, the delete hooks) is
 * `t-62-24-knowledge.db.test.ts`.
 */

const ORG = '0190a3e4-0000-7000-8000-0000000000c1';

function member(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'u1',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'm1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: ['p1'],
    hasOrgWideScope: false,
    ...overrides,
  };
}

function asset(overrides: Partial<FileAssetRow> = {}): FileAssetRow {
  return {
    id: 'f1',
    organizationId: ORG,
    projectId: 'p1',
    clientOrganizationId: null,
    ownerUserId: 'u1',
    name: 'Brand brief.docx',
    purpose: 'deliverable',
    objectId: null,
    audience: 'internal',
    status: 'ready',
    rejectionCode: null,
    scanClaimedAt: null,
    purgedAt: null,
    version: 1,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    deletedAt: null,
    deletedByUserId: null,
    deletedReason: null,
    purgeAfter: null,
    ...overrides,
  } as FileAssetRow;
}

function chunk(id: string, overrides: Partial<FetchedChunk> = {}): FetchedChunk {
  return {
    id,
    fileAssetId: 'f1',
    projectId: 'p1',
    chunkNo: 0,
    pageNo: null,
    body: `passage ${id}`,
    asset: asset(),
    ...overrides,
  };
}

describe('passages (62-24)', () => {
  it('cuts text into passages of the planned size, at headings and page markers', () => {
    const paragraph = 'Word '.repeat(300).trim(); // 1,499 characters
    const text = [
      'Slide 1',
      paragraph,
      paragraph,
      'Slide 2',
      'Short',
      '# Heading',
      'x'.repeat(MAX_CHARS * 2),
    ].join('\n\n');
    const chunks = chunkText(text);
    for (const piece of chunks) expect(piece.body.length).toBeLessThanOrEqual(MAX_CHARS + 2);
    expect(chunks.map((c) => c.chunkNo)).toEqual(chunks.map((_, i) => i));
    expect(chunks[0]?.pageNo).toBe(1);
    expect(chunks.some((c) => c.pageNo === 2 && c.body.startsWith('Slide 2'))).toBe(true);
    // A heading inside a short passage stays with it (no passage under MIN_CHARS is cut off).
    expect(chunks[2]?.body).toBe(['Slide 2', 'Short', '# Heading'].join('\n\n'));
    expect(chunkText('')).toEqual([]);
  });

  it('the test provider is deterministic, 512 long and unit length; cosine ranks like words', async () => {
    const provider = new HashingEmbeddingProvider();
    const [a, b, c] = await provider.embed([
      'invoice overdue client',
      'client invoice overdue',
      'holiday photos',
    ]);
    expect(a!.length).toBe(EMBEDDING_DIMENSIONS);
    expect(cosineDistance(a!, b!)).toBeCloseTo(0, 6);
    expect(cosineDistance(a!, c!)).toBeGreaterThan(0.5);
    expect(parseVectorText(vectorText(a!))).toEqual(a);
    expect(parseVectorText('[1,2]')).toBeNull();
    const ranked = rankByCosine(
      [
        { chunkId: 'far', vector: vectorText(c!) },
        { chunkId: 'near', vector: vectorText(b!) },
        { chunkId: 'broken', vector: 'x' },
      ],
      a!,
      5,
    );
    expect(ranked.map((r) => r.chunkId)).toEqual(['near', 'far']);
  });

  it('fuses the two rankings by reciprocal rank', () => {
    const fused = fuseRanks([
      [
        { chunkId: 'a', score: 9 },
        { chunkId: 'b', score: 8 },
      ],
      [
        { chunkId: 'b', score: 0.9 },
        { chunkId: 'c', score: 0.8 },
      ],
    ]);
    expect(fused.map((h) => h.chunkId)).toEqual(['b', 'a', 'c']);
  });

  it('the scope is the member’s projects, all of them only with org-wide scope', () => {
    expect(retrievalScope(member())).toEqual({ projectIds: ['p1'] });
    expect(retrievalScope(member({ hasOrgWideScope: true }), 'p9')).toEqual({
      projectIds: null,
      projectId: 'p9',
    });
  });

  it('the re-check drops every passage the member could not open', () => {
    const me = member();
    expect(mayReadPassage(me, chunk('ok'))).toBe(true);
    const refused: [string, FetchedChunk, Principal][] = [
      ['file gone', chunk('x', { asset: null }), me],
      ['file deleted', chunk('x', { asset: asset({ deletedAt: new Date() }) }), me],
      ['file purged', chunk('x', { asset: asset({ purgedAt: new Date() }) }), me],
      ['file rejected', chunk('x', { asset: asset({ status: 'rejected' }) }), me],
      ['file moved', chunk('x', { projectId: 'p0' }), me],
      ['another workspace', chunk('x', { asset: asset({ organizationId: 'org-2' }) }), me],
      ['not on the project', chunk('x'), member({ projectIds: ['p2'] })],
      ['access removed', chunk('x'), member({ projectIds: [] })],
      [
        'a client (files relation not resolved)',
        chunk('x'),
        member({ kind: 'client', role: 'client_member', clientOrganizationId: 'c1' }),
      ],
    ];
    for (const [why, passage, who] of refused)
      expect(mayReadPassage(who, passage), why).toBe(false);
  });
});

/** In-memory database: every unit of work runs at once. */
const database = {
  bootstrapRead: (_o: unknown, work: (db: unknown) => unknown) => work({}),
  read: (_c: unknown, work: (db: unknown) => unknown) => work({}),
  transaction: (_c: unknown, work: (tx: unknown) => unknown) => work({}),
} as unknown as TenantDatabase;

describe('retrieval (62-24)', () => {
  function setup(fetched: FetchedChunk[], keyword: RankedChunk[], vector: RankedChunk[]) {
    const scopes: { ranker: string; scope: RetrievalScope }[] = [];
    const repository = {
      keywordRank: (_r: unknown, _c: unknown, scope: RetrievalScope) => {
        scopes.push({ ranker: 'keyword', scope });
        return Promise.resolve(keyword);
      },
      fetch: (_r: unknown, _c: unknown, ids: readonly string[]) =>
        Promise.resolve(fetched.filter((c) => ids.includes(c.id))),
    } as unknown as KnowledgeRepository;
    const store: ChunkVectorStore = {
      name: 'node_cosine',
      nearest: (_r, _c, scope) => {
        scopes.push({ ranker: 'vector', scope });
        return Promise.resolve(vector);
      },
    };
    return { repository, store, scopes };
  }

  it('filters before ranking, re-checks every hit, and gives nothing away about the rest', async () => {
    const { repository, store, scopes } = setup(
      [chunk('mine'), chunk('elsewhere', { projectId: 'p2', asset: asset({ projectId: 'p2' }) })],
      [
        { chunkId: 'elsewhere', score: 5 },
        { chunkId: 'mine', score: 4 },
      ],
      [{ chunkId: 'mine', score: 0.9 }],
    );
    const retrieval = new KnowledgeRetrieval(
      database,
      repository,
      store,
      new HashingEmbeddingProvider(),
    );
    const passages = await retrieval.passages({} as never, member(), 'brief');
    expect(passages.map((p) => p.fileId + ':' + p.text)).toEqual(['f1:passage mine']);
    expect(scopes).toEqual([
      { ranker: 'keyword', scope: { projectIds: ['p1'] } },
      { ranker: 'vector', scope: { projectIds: ['p1'] } },
    ]);
  });

  it('without a provider it is keyword retrieval only', async () => {
    const { repository, store, scopes } = setup(
      [chunk('mine')],
      [{ chunkId: 'mine', score: 1 }],
      [],
    );
    const retrieval = new KnowledgeRetrieval(database, repository, store, null);
    expect(await retrieval.passages({} as never, member(), 'brief')).toHaveLength(1);
    expect(scopes.map((s) => s.ranker)).toEqual(['keyword']);
  });
});

describe('index job (62-24)', () => {
  function setup(known: Map<number, Float32Array>) {
    const inserted: NewChunk[] = [];
    const embedded: string[][] = [];
    const repository = {
      organizationsWithWork: () => Promise.resolve([ORG]),
      deleteStale: () => Promise.resolve(2),
      resyncScope: () => Promise.resolve(0),
      listAssetsNeedingChunks: (): Promise<AssetNeedingChunks[]> =>
        Promise.resolve([
          {
            fileAssetId: 'f2',
            projectId: 'p1',
            audience: 'internal',
            contentHash: 'h1',
            body: `Slide 1\n\n${'alpha '.repeat(500)}\n\nSlide 2\n\n${'beta '.repeat(500)}`,
          },
        ]),
      knownEmbeddings: () => Promise.resolve(known),
      insertChunks: (_t: unknown, _c: unknown, rows: NewChunk[]) => {
        inserted.push(...rows);
        return Promise.resolve();
      },
    } as unknown as KnowledgeRepository;
    const provider = new HashingEmbeddingProvider();
    const counting = {
      model: provider.model,
      embed: (texts: readonly string[], purpose: 'passage' | 'query') => {
        embedded.push([...texts]);
        void purpose;
        return provider.embed(texts);
      },
    };
    return { repository, counting, inserted, embedded };
  }

  it('writes passages, reuses vectors of the same bytes (paid once), embeds only the rest', async () => {
    const reused = new Float32Array(EMBEDDING_DIMENSIONS).fill(0.01);
    const { repository, counting, inserted, embedded } = setup(new Map([[0, reused]]));
    const job = new KnowledgeIndexJob(
      database,
      repository,
      counting,
      true,
      undefined,
      () => new Date(0),
    );
    const report = await job.pass();
    expect(report).toMatchObject({ files: 1, forgotten: 2, reused: 1 });
    expect(inserted.length).toBeGreaterThan(1);
    expect(inserted[0]?.embedding).toBe(reused);
    expect(embedded.flat()).toHaveLength(inserted.length - 1);
    expect(inserted.every((c) => c.projectId === 'p1' && c.embeddingModel === counting.model)).toBe(
      true,
    );
  });

  it('without a provider passages carry no vector', async () => {
    const { repository, inserted } = setup(new Map());
    const job = new KnowledgeIndexJob(database, repository, null, true);
    await job.pass();
    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted.every((c) => c.embedding === null && c.embeddingModel === null)).toBe(true);
  });
});
