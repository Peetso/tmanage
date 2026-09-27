import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { SavedSearchesController } from './saved-searches.controller.js';
import { SavedSearchesService, RECENT_LIMIT } from './saved-searches.service.js';
import type { SavedSearchesRepository } from './saved-searches.repository.js';
import type { SavedSearchRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * SRCH saved/recent searches (x214). Database-free proofs of the two authorization spines a
 * controller/service test can prove directly: the route ceiling is `search.use` (so a caller without
 * it is a 403, the generic guard's), and a saved search is private to its owner (a foreign id is a
 * 404, never a leak). Plus the recents bound/order and the create validation. The DB predicates
 * themselves are the chain's `.db.test.ts`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const context = {
  organizationId: ORG,
  userId: 'user-0000-0000-0000-0000-000000000001',
} as TenantContext;

function row(overrides: Partial<SavedSearchRow>): SavedSearchRow {
  return {
    id: 'saved-0000-0000-0000-0000-000000000001',
    organizationId: ORG,
    userId: 'user-0000-0000-0000-0000-000000000001',
    kind: 'saved',
    name: 'My open work',
    queryText: 'open',
    filters: [],
    createdAt: new Date('2026-02-02T09:00:00.000Z'),
    updatedAt: new Date('2026-02-02T09:00:00.000Z'),
    ...overrides,
  };
}

/** A service over a fake database that runs the work with a stub runner, and the given repository. */
function serviceWith(repository: Partial<SavedSearchesRepository>): SavedSearchesService {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new SavedSearchesService(database, repository as SavedSearchesRepository);
}

describe('SavedSearchesController capability wiring', () => {
  it('gates every route on search.use (the 403 for a caller without it is the guard’s)', () => {
    const reflector = new Reflector();
    for (const handler of [
      SavedSearchesController.prototype.listSaved,
      SavedSearchesController.prototype.createSaved,
      SavedSearchesController.prototype.deleteSaved,
      SavedSearchesController.prototype.listRecent,
    ]) {
      expect(reflector.get(REQUIRED_CAPABILITY, handler)).toBe('search.use');
    }
  });
});

describe('SavedSearchesController create validation', () => {
  const controller = new SavedSearchesController(serviceWith({}));

  it('rejects an empty name or query with a 400', async () => {
    await expect(controller.createSaved(context, { name: ' ', query: 'x' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(controller.createSaved(context, { name: 'x', query: '' })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe('SavedSearchesService owner scope + recents', () => {
  it('maps a saved list, newest first as the repository returns it', async () => {
    const service = serviceWith({ listSaved: async () => [row({ id: 'a' }), row({ id: 'b' })] });
    const list = await service.listSaved(context);
    expect(list.map((s) => s.id)).toEqual(['a', 'b']);
    expect(list[0]).toMatchObject({ name: 'My open work', query: 'open', filters: [] });
  });

  it('answers 404 when deleting an id that is not the caller’s own saved search', async () => {
    const service = serviceWith({ deleteSavedOwned: async () => false });
    await expect(service.deleteSaved(context, 'someone-elses-id')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('deletes when the id is the caller’s own', async () => {
    const service = serviceWith({ deleteSavedOwned: async () => true });
    await expect(service.deleteSaved(context, 'own-id')).resolves.toBeUndefined();
  });

  it('returns recents bounded by RECENT_LIMIT and in the repository’s order', async () => {
    let askedLimit = -1;
    const service = serviceWith({
      listRecent: async (_r, _c, limit) => {
        askedLimit = limit;
        return [
          row({
            kind: 'recent',
            name: null,
            queryText: 'newest',
            createdAt: new Date('2026-02-03T00:00:00Z'),
          }),
          row({
            kind: 'recent',
            name: null,
            queryText: 'older',
            createdAt: new Date('2026-02-01T00:00:00Z'),
          }),
        ];
      },
    });
    const recent = await service.listRecent(context);
    expect(askedLimit).toBe(RECENT_LIMIT);
    expect(recent.map((r) => r.query)).toEqual(['newest', 'older']);
    expect(recent[0]?.searchedAt).toBe('2026-02-03T00:00:00.000Z');
  });
});
