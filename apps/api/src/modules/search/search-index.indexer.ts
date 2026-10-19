import type { SearchIndexEntry } from './search-index.repository.js';

/**
 * SRCH (COL-04). Pure projections of a source row into a flat, searchable shape.
 *
 * Global search now reads the live source tables directly (`SearchIndexRepository.searchRanked`),
 * so nothing calls these at runtime today. They are kept — and unit-tested — as the single place
 * the source-shape knowledge lives, so a future incremental-reindex job can reuse them rather than
 * re-derive the projection.
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
