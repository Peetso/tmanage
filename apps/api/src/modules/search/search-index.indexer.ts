import { uuidv7 } from '@tmanage/domain';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { SearchIndexRepository } from './search-index.repository.js';
import type { SearchIndexEntry } from './search-index.repository.js';

/**
 * SRCH ranking (x148). The indexing helper that keeps `search_index` in step with its source rows.
 *
 * The two `*Entry` builders are the whole of the source-shape knowledge — pure functions that
 * project a work item or a document into the index's row shape. They are separated from the writes
 * so the projection is testable without a database (the acceptance proofs), and so the deferred
 * incremental-reindex job (NS-13) that wires these onto every source write can reuse them.
 *
 * Population this slice is the 0054 migration's backfill; keeping the index live on write is the
 * deferred job's work, which calls `indexWorkItem` / `indexDocument` / `remove` inside the same unit
 * of work as the source write. The helper is provided now so that wiring is a call, not a rebuild.
 */

/** Project a work item into an index entry. Work items have no body, so the title is the body. */
export function workItemEntry(row: {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly audience: 'internal' | 'client_visible' | 'client_action_required';
  readonly updatedAt: Date;
}): SearchIndexEntry {
  return {
    targetKind: 'work_item',
    targetId: row.id,
    projectId: row.projectId,
    title: row.title,
    bodyText: row.title,
    audience: row.audience,
    updatedAt: row.updatedAt,
  };
}

/** Project a document into an index entry. Documents are internal by construction. */
export function documentEntry(row: {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  readonly updatedAt: Date;
}): SearchIndexEntry {
  return {
    targetKind: 'document',
    targetId: row.id,
    projectId: row.projectId,
    title: row.title,
    bodyText: row.body,
    audience: 'internal',
    updatedAt: row.updatedAt,
  };
}

export class SearchIndexer {
  constructor(private readonly repository: SearchIndexRepository = new SearchIndexRepository()) {}

  /** Index (or refresh) one entry, minting a fresh id for a new row. */
  async index(
    runner: TenantQueryRunner,
    context: TenantContext,
    entry: SearchIndexEntry,
  ): Promise<void> {
    await this.repository.upsert(runner, context, entry, uuidv7());
  }

  /** Remove a source row's index row (source deleted). */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    targetKind: SearchIndexEntry['targetKind'],
    targetId: string,
  ): Promise<void> {
    await this.repository.deleteForTarget(runner, context, targetKind, targetId);
  }
}
