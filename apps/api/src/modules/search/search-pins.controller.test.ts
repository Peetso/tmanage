import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { SearchPinsController } from './search-pins.controller.js';
import { SearchPinsService } from './search-pins.service.js';
import type { SearchPinsRepository } from './search-pins.repository.js';
import type { SearchPinRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * SRCH quick-access pins (x290). Database-free proofs of the authorization spines a
 * controller/service test can prove directly: the route ceiling is `search.use` (so a caller without
 * it is a 403, the generic guard's); an `objectType` off the fixed indexed-entity allowlist is a 400
 * with **no insert** (the write is never reached); and a listing returns only the caller-membership
 * rows the repository hands back (the membership predicate is the repository's, exercised in the
 * chain's `.db.test.ts`). The DB predicates themselves are the chain's `.db.test.ts`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const context = {
  organizationId: ORG,
  membershipId: 'membership-0000-0000-0000-00000000001',
} as TenantContext;

function row(overrides: Partial<SearchPinRow>): SearchPinRow {
  return {
    id: 'pin-0000-0000-0000-0000-000000000001',
    organizationId: ORG,
    membershipId: 'membership-0000-0000-0000-00000000001',
    objectType: 'work_item',
    objectId: 'work-0000-0000-0000-0000-000000000001',
    label: 'Ship the release',
    createdAt: new Date('2026-02-02T09:00:00.000Z'),
    ...overrides,
  };
}

/** A service over a fake database that runs the work with a stub runner, and the given repository. */
function serviceWith(repository: Partial<SearchPinsRepository>): SearchPinsService {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new SearchPinsService(database, repository as SearchPinsRepository);
}

describe('SearchPinsController capability wiring', () => {
  it('gates every route on search.use (the 403 for a caller without it is the guard’s)', () => {
    const reflector = new Reflector();
    for (const handler of [
      SearchPinsController.prototype.list,
      SearchPinsController.prototype.pin,
      SearchPinsController.prototype.unpin,
    ]) {
      expect(reflector.get(REQUIRED_CAPABILITY, handler)).toBe('search.use');
    }
  });
});

describe('SearchPinsService objectType allowlist + owner scope', () => {
  it('refuses an off-allowlist objectType with a 400 and never writes', async () => {
    let upserted = false;
    const service = serviceWith({
      upsertPin: async () => {
        upserted = true;
        return row({});
      },
    });
    const rejection = service.pin(context, {
      objectType: 'secret' as never,
      objectId: 'obj-1',
      label: 'nope',
    });
    await expect(rejection).rejects.toBeInstanceOf(ApiError);
    await expect(rejection).rejects.toMatchObject({ status: 400 });
    expect(upserted).toBe(false);
  });

  it('pins an allowed objectType, projecting the stored row', async () => {
    const service = serviceWith({ upsertPin: async () => row({ id: 'a', label: 'Ship it' }) });
    const view = await service.pin(context, {
      objectType: 'document',
      objectId: 'doc-1',
      label: 'Ship it',
    });
    expect(view).toMatchObject({ id: 'a', objectType: 'work_item', label: 'Ship it' });
  });

  it('lists only the rows the (membership-scoped) repository returns, newest first', async () => {
    const service = serviceWith({
      listPins: async () => [row({ id: 'a' }), row({ id: 'b', label: 'Second' })],
    });
    const list = await service.list(context);
    expect(list.map((p) => p.id)).toEqual(['a', 'b']);
    expect(list[0]?.createdAt).toBe('2026-02-02T09:00:00.000Z');
  });

  it('unpins idempotently — an absent pin is a no-op (204), never an error', async () => {
    const service = serviceWith({ deleteOwned: async () => undefined });
    await expect(service.unpin(context, 'any-id')).resolves.toBeUndefined();
  });
});
