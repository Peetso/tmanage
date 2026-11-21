import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { uuidv7 } from '@tmanage/domain';
import { createServiceContext } from '../../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../../common/database/tenant-context.js';
import { chunkText } from './chunker.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { KnowledgeRepository, NewChunk } from './knowledge.repository.js';

/**
 * 62-24 — the knowledge index job: passages for every live file whose text is ready, in the
 * one Hostinger process (the text job's shape; off unless `WORKER_INPROCESS=1` or
 * `KNOWLEDGE_INDEX_INPROCESS=1`).
 *
 * One pass per workspace (IP-17 typed report, AS-6 bounded):
 * 1. **Forget** stale passages: the file deleted, purged, rejected, or its current version holds
 *    other bytes (a new upload). The soft delete and purge already delete in their transaction;
 *    this is the catch-up for every other path.
 * 2. **Re-sync** each passage's project and audience from its file (the dirty hook's catch-up).
 * 3. **Write** passages for files that have none: chunk the text, reuse the vectors of the same
 *    bytes under another file (same hash and model: paid once), embed the rest when a provider is
 *    configured, and insert them in one transaction per file. Without a provider the passages
 *    carry no vector and retrieval is keyword-only.
 *
 * A failed embedding call leaves the file without passages; the next pass tries again.
 */

export const KNOWLEDGE_INDEX_JOB = Symbol.for('tmanage.KnowledgeIndexJob');

export const KNOWLEDGE_INDEX_REASON =
  'finding which organizations hold ready file texts without passages, or passages whose file ' +
  'is gone or changed, so each can be indexed under its own service context (62-24)';

export interface KnowledgeIndexOptions {
  readonly bootDelayMs: number;
  readonly intervalMs: number;
  readonly filesPerOrganization: number;
  readonly staleBatchSize: number;
  readonly passBudgetMs: number;
  readonly log: (line: string) => void;
}

export const DEFAULT_KNOWLEDGE_INDEX_OPTIONS: KnowledgeIndexOptions = {
  bootDelayMs: 40_000,
  intervalMs: 5 * 60_000,
  filesPerOrganization: 20,
  staleBatchSize: 500,
  passBudgetMs: 120_000,
  log: (line) => console.warn(line),
};

export function knowledgeIndexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['WORKER_INPROCESS'] === '1' || env['KNOWLEDGE_INDEX_INPROCESS'] === '1';
}

export interface KnowledgeIndexReport {
  readonly organizations: number;
  readonly files: number;
  readonly chunks: number;
  readonly embedded: number;
  readonly reused: number;
  readonly forgotten: number;
  readonly resynced: number;
  readonly failed: number;
  readonly stoppedBy: 'budget' | null;
}

export function describeKnowledgeIndexPass(report: KnowledgeIndexReport): string {
  return [
    `${String(report.organizations)} organization(s)`,
    `files ${String(report.files)}`,
    `chunks ${String(report.chunks)}`,
    `embedded ${String(report.embedded)}`,
    `reused ${String(report.reused)}`,
    `forgotten ${String(report.forgotten)}`,
    `resynced ${String(report.resynced)}`,
    `failed ${String(report.failed)}`,
    ...(report.stoppedBy ? [`stopped by ${report.stoppedBy}`] : []),
  ].join(', ');
}

export function knowledgeContextFor(organizationId: string, correlationId: string): TenantContext {
  return createServiceContext({ organizationId, correlationId, policyVersion: 'knowledge-index' });
}

type Tally = {
  -readonly [K in Exclude<keyof KnowledgeIndexReport, 'organizations' | 'stoppedBy'>]: number;
};

export class KnowledgeIndexJob implements OnApplicationBootstrap, OnModuleDestroy {
  private running: Promise<void> | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: KnowledgeRepository,
    private readonly embeddings: EmbeddingProvider | null,
    private readonly enabled: boolean,
    private readonly options: KnowledgeIndexOptions = DEFAULT_KNOWLEDGE_INDEX_OPTIONS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    const boot = setTimeout(() => void this.runNow(), this.options.bootDelayMs);
    const tick = setInterval(() => void this.runNow(), this.options.intervalMs);
    boot.unref();
    tick.unref();
    this.timers = [boot, tick];
  }

  async onModuleDestroy(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    await this.running;
  }

  async runNow(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.pass()
      .then((report) => {
        if (report.files + report.forgotten + report.resynced + report.failed > 0)
          this.options.log(`[knowledge-index] pass: ${describeKnowledgeIndexPass(report)}`);
      })
      .catch((error: unknown) => {
        this.options.log(
          `[knowledge-index] pass failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  async pass(): Promise<KnowledgeIndexReport> {
    const started = Date.now();
    const correlationId = uuidv7();
    const tally: Tally = {
      files: 0,
      chunks: 0,
      embedded: 0,
      reused: 0,
      forgotten: 0,
      resynced: 0,
      failed: 0,
    };
    const organizations = await this.database.bootstrapRead(
      {
        correlationId,
        reason: KNOWLEDGE_INDEX_REASON,
        tables: ['file_assets', 'file_versions', 'ai_file_texts', 'ai_file_chunks'],
      },
      (db) => this.repository.organizationsWithWork(db),
    );
    let stoppedBy: KnowledgeIndexReport['stoppedBy'] = null;
    for (const organizationId of organizations) {
      if (Date.now() - started > this.options.passBudgetMs) {
        stoppedBy = 'budget';
        break;
      }
      await this.organization(knowledgeContextFor(organizationId, correlationId), tally);
    }
    return { organizations: organizations.length, ...tally, stoppedBy };
  }

  private async organization(context: TenantContext, tally: Tally): Promise<void> {
    tally.forgotten += await this.database.transaction(context, (tx) =>
      this.repository.deleteStale(tx, context, this.options.staleBatchSize),
    );
    tally.resynced += await this.database.transaction(context, (tx) =>
      this.repository.resyncScope(tx, context),
    );
    const assets = await this.database.read(context, (db) =>
      this.repository.listAssetsNeedingChunks(db, context, this.options.filesPerOrganization),
    );
    for (const asset of assets) {
      const pieces = chunkText(asset.body);
      if (pieces.length === 0) continue;
      let vectors: (Float32Array | null)[] = pieces.map(() => null);
      if (this.embeddings !== null) {
        const provider = this.embeddings;
        try {
          const known = await this.database.read(context, (db) =>
            this.repository.knownEmbeddings(db, context, asset.contentHash, provider.model),
          );
          const missing = pieces.filter((piece) => !known.has(piece.chunkNo));
          const fresh =
            missing.length === 0
              ? []
              : await provider.embed(
                  missing.map((piece) => piece.body),
                  'passage',
                );
          const byNo = new Map(missing.map((piece, index) => [piece.chunkNo, fresh[index]]));
          vectors = pieces.map(
            (piece) => known.get(piece.chunkNo) ?? byNo.get(piece.chunkNo) ?? null,
          );
          tally.reused += pieces.length - missing.length;
          tally.embedded += missing.length;
        } catch {
          tally.failed += 1;
          continue;
        }
      }
      const rows: NewChunk[] = pieces.map((piece, index) => ({
        id: uuidv7(),
        fileAssetId: asset.fileAssetId,
        projectId: asset.projectId,
        audience: asset.audience,
        contentHash: asset.contentHash,
        chunkNo: piece.chunkNo,
        pageNo: piece.pageNo,
        body: piece.body,
        embedding: vectors[index] ?? null,
        embeddingModel: this.embeddings?.model ?? null,
      }));
      try {
        await this.database.transaction(context, (tx) =>
          this.repository.insertChunks(tx, context, rows, this.now()),
        );
      } catch {
        // Another process wrote this file's passages first (unique asset + number): it stands.
        tally.failed += 1;
        continue;
      }
      tally.files += 1;
      tally.chunks += rows.length;
    }
  }
}
