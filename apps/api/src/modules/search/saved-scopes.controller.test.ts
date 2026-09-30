import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { SearchScopesController } from './saved-scopes.controller.js';
import { SearchScopesService } from './saved-scopes.service.js';
import type { SearchScopesRepository } from './saved-scopes.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { SearchScopeRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * SRCH saved scopes (x334). Database-free proofs of the two authorization spines: the route ceiling
 * is `search.use` (a caller without it is the guard's 403), and the surface is own-scoped (GET returns
 * the caller's rows only) with the object-type allowlist enforced before any write (an off-allowlist
 * kind is a 400 with no insert). The DB predicates themselves are the chain's `.db.test.ts`.
 */

const CALLER = 'user-0000-0000-0000-0000-000000000001';
const context = {
  organizationId: 'organization-0000-0000-0000-000000000001',
  userId: CALLER,
  membershipId: 'membership-0000-0000-0000-000000000001',
} as TenantContext;

function serviceWith(repository: Partial<SearchScopesRepository>): SearchScopesService {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const projects = { findById: async () => null } as unknown as ProjectsRepository;
  return new SearchScopesService(database, repository as SearchScopesRepository, projects);
}

function row(overrides: Partial<SearchScopeRow>): SearchScopeRow {
  return {
    id: 'scope-1',
    organizationId: context.organizationId,
    memberUserId: CALLER,
    name: 'Open work',
    filters: { objectTypes: ['work_item'] },
    createdAt: new Date('2026-03-01T09:00:00.000Z'),
    updatedAt: new Date('2026-03-01T09:00:00.000Z'),
    ...overrides,
  } as SearchScopeRow;
}

describe('SearchScopesController capability wiring', () => {
  it('gates every route on search.use (the 403 for a caller without it is the guard’s)', () => {
    const reflector = new Reflector();
    for (const handler of [
      SearchScopesController.prototype.list,
      SearchScopesController.prototype.create,
      SearchScopesController.prototype.replace,
      SearchScopesController.prototype.remove,
    ]) {
      expect(reflector.get(REQUIRED_CAPABILITY, handler)).toBe('search.use');
    }
  });
});

describe('SearchScopesController body validation', () => {
  it('rejects an off-allowlist object type with a 400 and does NOT write', async () => {
    const insert = vi.fn(async () => row({}));
    const controller = new SearchScopesController(serviceWith({ insert }));
    await expect(
      controller.create(context, { name: 'Bad', filters: { objectTypes: ['meeting'] } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects an empty name with a 400 and does NOT write', async () => {
    const insert = vi.fn(async () => row({}));
    const controller = new SearchScopesController(serviceWith({ insert }));
    await expect(
      controller.create(context, { name: '   ', filters: { objectTypes: ['work_item'] } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('SearchScopesService own scope', () => {
  it('lists the caller’s rows only (the repository read is owner-scoped)', async () => {
    const listOwned = vi.fn(async () => [row({ id: 'scope-1' }), row({ id: 'scope-2' })]);
    const controller = new SearchScopesController(serviceWith({ listOwned }));
    const result = await controller.list(context);
    expect(listOwned).toHaveBeenCalledWith(expect.anything(), context);
    expect(result.scopes.map((scope) => scope.id)).toEqual(['scope-1', 'scope-2']);
  });

  it('answers 404 when replacing a scope the caller does not own, and does NOT update', async () => {
    const updateOwned = vi.fn(async () => undefined);
    const service = serviceWith({ findOwned: async () => undefined, updateOwned });
    await expect(
      service.replace(context, 'not-mine', { name: 'X', filters: { objectTypes: [] } }),
    ).rejects.toMatchObject({ status: 404 });
    expect(updateOwned).not.toHaveBeenCalled();
  });
});
