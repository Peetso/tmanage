import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { SearchHistoryController } from './search-history.controller.js';
import { SearchHistoryService } from './search-history.service.js';
import type { SearchHistoryRepository } from './search-history.repository.js';
import type { SearchHistoryRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Search recent history (x288). Database-free proofs of the authorization spines a
 * controller/service test can prove directly: the route ceiling is `search.use` (a caller without it
 * is a 403, the generic guard's), a blank query is a 400 with no insert, and a list is the acting
 * member's own — the service reads through the caller context, whose `membershipId` the repository
 * scopes every row by, so another membership's history never appears. The DB predicates themselves
 * are the chain's `.db.test.ts`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const context = {
  organizationId: ORG,
  membershipId: 'membership-0000-0000-0000-00000000000a',
} as TenantContext;

function row(overrides: Partial<SearchHistoryRow>): SearchHistoryRow {
  return {
    id: 'history-0000-0000-0000-000000000001',
    organizationId: ORG,
    membershipId: 'membership-0000-0000-0000-00000000000a',
    query: 'open bugs',
    createdAt: new Date('2026-03-02T09:00:00.000Z'),
    ...overrides,
  };
}

/** A service over a fake database that runs the work with a stub runner, and the given repository. */
function serviceWith(repository: Partial<SearchHistoryRepository>): SearchHistoryService {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new SearchHistoryService(database, repository as SearchHistoryRepository);
}

describe('SearchHistoryController capability wiring', () => {
  it('gates every route on search.use (the 403 for a caller without it is the guard’s)', () => {
    const reflector = new Reflector();
    for (const handler of [
      SearchHistoryController.prototype.record,
      SearchHistoryController.prototype.list,
      SearchHistoryController.prototype.clear,
    ]) {
      expect(reflector.get(REQUIRED_CAPABILITY, handler)).toBe('search.use');
    }
  });
});

describe('SearchHistoryController record validation', () => {
  it('rejects a blank query with a 400 and never records it', async () => {
    let recorded = false;
    const controller = new SearchHistoryController(
      serviceWith({
        record: async () => {
          recorded = true;
        },
        listRecent: async () => [],
      }),
    );
    await expect(controller.record(context, { query: '   ' })).rejects.toBeInstanceOf(ApiError);
    await expect(controller.record(context, {})).rejects.toMatchObject({ status: 400 });
    expect(recorded).toBe(false);
  });

  it('normalises whitespace before recording', async () => {
    let seen = '';
    const controller = new SearchHistoryController(
      serviceWith({
        record: async (_r, _c, query) => {
          seen = query;
        },
        prune: async () => {},
        listRecent: async () => [],
      }),
    );
    await controller.record(context, { query: '  open   bugs  ' });
    expect(seen).toBe('open bugs');
  });
});

describe('SearchHistoryService owner scope', () => {
  it('lists through the caller context, so only the caller-membership rows appear', async () => {
    let seenContext: TenantContext | undefined;
    const service = serviceWith({
      listRecent: async (_r, ctx) => {
        seenContext = ctx;
        return [row({ query: 'newest' }), row({ id: 'b', query: 'older' })];
      },
    });
    const history = await service.listRecent(context);
    expect(seenContext?.membershipId).toBe(context.membershipId);
    expect(history.map((h) => h.query)).toEqual(['newest', 'older']);
    expect(history[0]?.recordedAt).toBe('2026-03-02T09:00:00.000Z');
  });
});
