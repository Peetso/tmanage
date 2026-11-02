import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import { ContactSuggestionsRepository } from '../src/modules/people/contact-suggestions.repository.js';
import { ContactSuggestionsService } from '../src/modules/people/contact-suggestions.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld, SeededUser } from './seed-two-tenants.js';

/**
 * 54-11 (0295) at the engine, on the runtime credential: the `(org, user, email)` upsert refreshes
 * one row, the suggest read hides expired rows, and user B never reads user A's suggestions.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;

const ctx = (user: SeededUser) =>
  createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: user.id,
    membershipId: user.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-11-02',
    correlationId: uuidv7(),
  });

beforeAll(async () => {
  db = await startTestDatabase();
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
}, 300_000);
beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});
afterAll(async () => db.stop());

describe('INT-54-11 contact suggestions', () => {
  it('upserts on (org, user, email), hides expired rows, isolates users', async () => {
    let now = new Date('2026-11-02T10:00:00Z');
    const service = new ContactSuggestionsService(tenant, new ContactSuggestionsRepository(), {
      now: () => now,
    });
    const owner = ctx(world.northstar.owner);
    await service.importFile(owner, { format: 'csv', text: 'Name,Email\nSara,sara@x.io\n' });
    expect(
      await service.importFile(owner, { format: 'csv', text: 'Name,Email\nSara N,SARA@x.io\n' }),
    ).toMatchObject({ imported: 0, updated: 1 });
    expect(await service.suggest(owner, 'sa')).toEqual([
      { displayName: 'Sara N', email: 'sara@x.io', company: null },
    ]);
    expect(await service.suggest(ctx(world.northstar.manager), 'sa')).toEqual([]);
    now = new Date('2027-02-01T10:00:01Z'); // 91 days later
    expect(await service.suggest(owner, 'sa')).toEqual([]);
  });
});
