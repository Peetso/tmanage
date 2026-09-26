import { describe, expect, it } from 'vitest';
import { documentEntry, workItemEntry } from './search-index.indexer.js';

/**
 * SRCH ranking (x148) indexer proofs, database-free. The FULLTEXT ranking, the upsert and the
 * tenant-scoped read are MySQL/SQL behaviour proven by the chain's DB suites (no DB test in-slice);
 * the unit-testable substance here is the pure projection from a source row into the index's row
 * shape — the whole of the source-shape knowledge the deferred reindex job (NS-13) reuses.
 */
describe('search index projections', () => {
  const updatedAt = new Date('2026-01-02T03:04:05.678Z');

  it('projects a work item, using the title as its own body (no body column) and carrying audience', () => {
    const entry = workItemEntry({
      id: 'w1',
      projectId: 'p1',
      title: 'Ship the thing',
      audience: 'client_visible',
      updatedAt,
    });
    expect(entry).toEqual({
      targetKind: 'work_item',
      targetId: 'w1',
      projectId: 'p1',
      title: 'Ship the thing',
      bodyText: 'Ship the thing',
      audience: 'client_visible',
      updatedAt,
    });
  });

  it('projects a document with its body as body_text and an internal audience by construction', () => {
    const entry = documentEntry({
      id: 'd1',
      projectId: 'p1',
      title: 'Spec',
      body: 'The full specification body.',
      updatedAt,
    });
    expect(entry).toEqual({
      targetKind: 'document',
      targetId: 'd1',
      projectId: 'p1',
      title: 'Spec',
      bodyText: 'The full specification body.',
      audience: 'internal',
      updatedAt,
    });
  });
});
