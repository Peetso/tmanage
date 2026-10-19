import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { SearchIndexRepository } from '../src/modules/search/search-index.repository.js';
import { SearchService } from '../src/modules/search/search.service.js';
import { SavedSearchesRepository } from '../src/modules/search/saved-searches.repository.js';
import { SearchScopesRepository } from '../src/modules/search/saved-scopes.repository.js';
import { SearchScopesService } from '../src/modules/search/saved-scopes.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * T009 — Global search (COL-04), saved searches & saved scopes against a real MySQL server.
 *
 * Global search now reads the live source tables directly (`SearchIndexRepository.searchRanked`)
 * rather than a separately-maintained `search_index`, so there is nothing to keep in sync and the
 * index was never the thing search returned. What only a real server can prove, and this suite does:
 *
 * 1. **The live read never crosses a tenant.** The §11 adversarial twin owns a work item with the
 *    *identical* title under an *adjacent* organization id; a scan that lost its `organization_id`
 *    predicate would return the twin's row into Northstar's page. Here it does not, either way —
 *    the guard (`drizzle.ts`) refuses an unscoped read, and each kind is a single-table org-scoped
 *    scan.
 * 2. **A hit the caller may not read is dropped, per caller.** The relation rule runs over the
 *    read: a member sees only the hit on the project she belongs to; the same query as the org-wide
 *    owner returns both. No cross-project hit leakage.
 * 3. **A saved search / saved scope is private to its (org, user)** — invisible to the §11 twin,
 *    unremovable by it — and the saved-search filter JSON round-trips through the engine unchanged.
 * 4. **A scope's project filter actually constrains the read** — applying it narrows the results to
 *    that project; without it both rows return.
 *
 * Fixtures are built in-test via the shared seed and direct inserts (no edit to seed-two-tenants.ts
 * or support/*). Rows that carry a timestamp are dated from a bound `new Date` where it matters —
 * the admin pool clock is SYSTEM, so a `current_timestamp` default is never relied on for an
 * assertion about ordering or value.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;

let indexRepo: SearchIndexRepository;
let search: SearchService;
let savedRepo: SavedSearchesRepository;
let scopeRepo: SearchScopesRepository;
let scopes: SearchScopesService;

let ownerCtx: TenantContext;
let owner: Principal;
let designerCtx: TenantContext;
let designer: Principal;
let twinCtx: TenantContext;

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

/**
 * Seed one real `work_items` row so the live search scan can find it. The `updated_at` is bound
 * explicitly (the admin pool clock is SYSTEM, so the default is never relied on for ordering), and
 * `state`/`type`/`version` take their column defaults.
 */
async function seedWorkItem(entry: {
  readonly organizationId: string;
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly audience?: 'internal' | 'client_visible' | 'client_action_required';
  readonly updatedAt?: Date;
}): Promise<void> {
  const updatedAt = entry.updatedAt ?? new Date('2026-02-01T00:00:00.000Z');
  await db.admin.execute(
    `insert into work_items (id, organization_id, project_id, title, audience, updated_at)
       values (?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.organizationId,
      entry.projectId,
      entry.title,
      entry.audience ?? 'internal',
      updatedAt,
    ],
  );
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });

  indexRepo = new SearchIndexRepository();
  search = new SearchService(tenant, indexRepo);
  savedRepo = new SavedSearchesRepository();
  scopeRepo = new SearchScopesRepository();
  scopes = new SearchScopesService(tenant);

  ownerCtx = createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: world.northstar.owner.id,
    membershipId: world.northstar.owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
  owner = {
    userId: ownerCtx.userId,
    organizationId: ownerCtx.organizationId,
    kind: 'internal',
    role: 'owner',
    membershipId: ownerCtx.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };

  designerCtx = createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: world.northstar.designer.id,
    membershipId: world.northstar.designer.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('member'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
  designer = {
    userId: world.northstar.designer.id,
    organizationId: world.northstar.organizationId,
    kind: 'internal',
    role: 'member',
    membershipId: world.northstar.designer.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    // A member of Atlas only — deliberately NOT of the Brand Refresh project (seed §11 grid case).
    projectIds: [world.northstar.projectId],
    hasOrgWideScope: false,
  };

  twinCtx = createTenantContext({
    organizationId: world.twin.organizationId,
    userId: world.twin.owner.id,
    membershipId: world.twin.owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
});

afterAll(async () => {
  await db?.stop();
});

describe('the live search is tenant-scoped', () => {
  const nsHit = uuidv7();
  const twinHit = uuidv7();

  it('returns only the acting tenant, even against the twin with the identical title', async () => {
    // Northstar and its §11 twin each own a work item with the SAME searchable word under adjacent
    // org ids. A scan without the tenant predicate would return both.
    await seedWorkItem({
      organizationId: world.northstar.organizationId,
      id: nsHit,
      projectId: world.northstar.projectId,
      title: 'Zephyr booking telemetry',
    });
    await seedWorkItem({
      organizationId: world.twin.organizationId,
      id: twinHit,
      projectId: world.twin.projectId,
      title: 'Zephyr booking telemetry',
    });

    const nsRows = await tenant.read(ownerCtx, (runner) =>
      indexRepo.searchRanked(runner, ownerCtx, { query: 'Zephyr', limit: 20 }),
    );
    expect(nsRows.map((r) => r.targetId)).toEqual([nsHit]);
    expect(nsRows.every((r) => r.organizationId === world.northstar.organizationId)).toBe(true);

    // And the mirror: the twin's identical query returns only the twin's row, not Northstar's.
    const twinRows = await tenant.read(twinCtx, (runner) =>
      indexRepo.searchRanked(runner, twinCtx, { query: 'Zephyr', limit: 20 }),
    );
    expect(twinRows.map((r) => r.targetId)).toEqual([twinHit]);
  });
});

describe('a hit the caller may not read is dropped, per caller', () => {
  const visibleId = uuidv7();
  const hiddenId = uuidv7();

  it('a member sees only the hit on her project; the owner sees both', async () => {
    // Two Northstar rows share a searchable word: one on Atlas (the designer is a member), one on
    // the Brand Refresh project (she is not). Both are internal audience.
    await seedWorkItem({
      organizationId: world.northstar.organizationId,
      id: visibleId,
      projectId: world.northstar.projectId,
      title: 'Marmot ridge expedition',
    });
    await seedWorkItem({
      organizationId: world.northstar.organizationId,
      id: hiddenId,
      projectId: world.northstar.otherProjectId,
      title: 'Marmot ridge expedition',
    });

    const forDesigner = await search.search(designerCtx, designer, { q: 'Marmot' });
    const designerIds = forDesigner.map((r) => r.id);
    expect(designerIds).toContain(visibleId);
    expect(designerIds).not.toContain(hiddenId);
    // Nothing identifying the project she cannot read leaks into the result.
    expect(JSON.stringify(forDesigner)).not.toContain(world.northstar.otherProjectId);

    const forOwner = await search.search(ownerCtx, owner, { q: 'Marmot' });
    const ownerIds = forOwner.map((r) => r.id);
    expect(ownerIds).toContain(visibleId);
    expect(ownerIds).toContain(hiddenId);
  });
});

describe('a saved search is private to its (org, user)', () => {
  let savedId: string;
  const filters = [
    { field: 'status', value: 'open' },
    { field: 'projectId', value: 'atlas-relaunch' },
  ] as const;

  it('is created owner-scoped and its filter JSON round-trips through the engine', async () => {
    const row = await tenant.transaction(ownerCtx, (tx) =>
      savedRepo.insertSaved(tx, ownerCtx, {
        name: 'Open on Atlas',
        query: 'overdue',
        filters,
      }),
    );
    savedId = row.id;

    const listed = await tenant.read(ownerCtx, (runner) => savedRepo.listSaved(runner, ownerCtx));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('Open on Atlas');
    expect(listed[0]?.queryText).toBe('overdue');
    // The structured filter survives the JSON column byte-for-structure.
    expect(listed[0]?.filters).toEqual(filters);

    // And the raw column really holds that array, not a stringified blob the driver re-parsed.
    const raw = await observe(`select filters from saved_searches where id = ?`, [savedId]);
    const stored = raw[0]?.['filters'];
    const parsed = (typeof stored === 'string' ? JSON.parse(stored) : stored) as unknown;
    expect(parsed).toEqual(filters);
  });

  it('is invisible to, and unremovable by, the §11 twin', async () => {
    // The twin owner, in the adjacent-id studio, sees none of Northstar's saved searches.
    const twinList = await tenant.read(twinCtx, (runner) => savedRepo.listSaved(runner, twinCtx));
    expect(twinList).toHaveLength(0);
    // The exact id resolves to nothing across the tenant boundary (the service answers 404).
    const crossRead = await tenant.read(twinCtx, (runner) =>
      savedRepo.findOwned(runner, twinCtx, savedId, 'saved'),
    );
    expect(crossRead).toBeUndefined();
    // A delete under the twin removes nothing; the row is still the owner's.
    const twinDelete = await tenant.transaction(twinCtx, (tx) =>
      savedRepo.deleteSavedOwned(tx, twinCtx, savedId),
    );
    expect(twinDelete).toBe(false);
    const stillThere = await observe(`select id from saved_searches where id = ?`, [savedId]);
    expect(stillThere).toHaveLength(1);

    // The owner can delete their own.
    const ownerDelete = await tenant.transaction(ownerCtx, (tx) =>
      savedRepo.deleteSavedOwned(tx, ownerCtx, savedId),
    );
    expect(ownerDelete).toBe(true);
  });

  it('records recents newest-first and dedupes a repeat to the front', async () => {
    await tenant.transaction(ownerCtx, (tx) =>
      savedRepo.recordRecent(tx, ownerCtx, 'quokka survey', 10),
    );
    await tenant.transaction(ownerCtx, (tx) =>
      savedRepo.recordRecent(tx, ownerCtx, 'basalt ridge', 10),
    );
    // Re-running the first query moves it back to the front rather than adding a duplicate.
    await tenant.transaction(ownerCtx, (tx) =>
      savedRepo.recordRecent(tx, ownerCtx, 'quokka survey', 10),
    );

    const recent = await tenant.read(ownerCtx, (runner) =>
      savedRepo.listRecent(runner, ownerCtx, 10),
    );
    expect(recent.map((r) => r.queryText)).toEqual(['quokka survey', 'basalt ridge']);

    // Recents are per-user too: the twin owner has none.
    const twinRecent = await tenant.read(twinCtx, (runner) =>
      savedRepo.listRecent(runner, twinCtx, 10),
    );
    expect(twinRecent).toHaveLength(0);
  });
});

describe('a saved scope is private, immutable in identity, and constrains the read', () => {
  let scopeId: string;

  it('is created owner-scoped, round-trips its filters, and is invisible to the twin', async () => {
    const view = await scopes.create(ownerCtx, {
      name: 'Atlas work items',
      filters: { objectTypes: ['work_item'], projectId: world.northstar.projectId },
    });
    scopeId = view.id;
    expect(view.filters).toEqual({
      objectTypes: ['work_item'],
      projectId: world.northstar.projectId,
    });

    const listed = await scopes.list(ownerCtx);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.filters).toEqual({
      objectTypes: ['work_item'],
      projectId: world.northstar.projectId,
    });

    const twinList = await tenant.read(twinCtx, (runner) => scopeRepo.listOwned(runner, twinCtx));
    expect(twinList).toHaveLength(0);
    const crossRead = await tenant.read(twinCtx, (runner) =>
      scopeRepo.findOwned(runner, twinCtx, scopeId),
    );
    expect(crossRead).toBeUndefined();
  });

  it('pins tenant and owner immutable (the 0200 trigger)', async () => {
    await expect(
      db.admin.execute(`update search_scopes set member_user_id = ? where id = ?`, [
        world.northstar.manager.id,
        scopeId,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.admin.execute(`update search_scopes set organization_id = ? where id = ?`, [
        world.twin.organizationId,
        scopeId,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it("the scope's project filter narrows the read to that project", async () => {
    const onAtlas = uuidv7();
    const onBrand = uuidv7();
    await seedWorkItem({
      organizationId: world.northstar.organizationId,
      id: onAtlas,
      projectId: world.northstar.projectId,
      title: 'Cedar inventory count',
    });
    await seedWorkItem({
      organizationId: world.northstar.organizationId,
      id: onBrand,
      projectId: world.northstar.otherProjectId,
      title: 'Cedar inventory count',
    });

    // Applying the scope's project filter returns only the Atlas row.
    const scoped = await tenant.read(ownerCtx, (runner) =>
      indexRepo.searchRanked(runner, ownerCtx, {
        query: 'Cedar',
        projectId: world.northstar.projectId,
        limit: 20,
      }),
    );
    expect(scoped.map((r) => r.targetId)).toEqual([onAtlas]);

    // Without the filter, both rows rank.
    const unscoped = await tenant.read(ownerCtx, (runner) =>
      indexRepo.searchRanked(runner, ownerCtx, { query: 'Cedar', limit: 20 }),
    );
    expect(unscoped.map((r) => r.targetId).sort()).toEqual([onAtlas, onBrand].sort());
  });
});
