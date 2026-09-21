import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import { DocumentsRepository } from '../src/modules/docs/documents.repository.js';
import { DocumentVersionsRepository } from '../src/modules/docs/document-versions.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * DOC-02/DOC-03 (x112). The document-versions repository against a real server and the adversarial
 * near-identical tenant pair the isolation corpus uses. Three things are under test: the migration
 * applies and a tenant-scoped version round-trips (append → newest-first list → find-by-number),
 * the in-transaction append bumps the parent `documents.body`, and the tenant guard is genuinely on
 * the Drizzle path (an unscoped `SELECT ... FROM document_versions` still throws). The pair's ids
 * differ only in the final hex digit, so a missing predicate would leak rather than pass.
 *
 * The service's authorize/relation logic and the 404-before-write Known-trap are proven over fakes
 * in `src/modules/docs/documents.test.ts`; this file proves the SQL layer, not that logic again.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let guardEvents: TenantGuardEvent[];
let northstar: TenantContext;
let twin: TenantContext;
const documents = new DocumentsRepository();
const versions = new DocumentVersionsRepository();

const contextFor = (organizationId: string, userId: string, membershipId: string): TenantContext =>
  createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-16',
    correlationId: uuidv7(),
  });

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  guardEvents = [];
  tenant = new TenantDatabase(db.runtime, {
    guardMode: 'enforce',
    onGuardEvent: (event) => guardEvents.push(event),
  });
  northstar = contextFor(
    world.northstar.organizationId,
    world.northstar.owner.id,
    world.northstar.owner.membershipId,
  );
  twin = contextFor(world.twin.organizationId, world.twin.owner.id, world.twin.owner.membershipId);
});

afterAll(async () => {
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

async function seedDocument(context: TenantContext, projectId: string, ownerId: string) {
  return tenant.transaction(context, (tx) =>
    documents.create(tx, context, {
      projectId,
      title: 'Kickoff brief',
      body: 'v0 body',
      createdByUserId: ownerId,
    }),
  );
}

describe('a tenant-scoped version round-trips and bumps the parent', () => {
  it('appends newest-first, finds by number, and updates the document body in one transaction', async () => {
    const document = await seedDocument(
      northstar,
      world.northstar.projectId,
      world.northstar.owner.id,
    );

    const first = await tenant.transaction(northstar, (tx) =>
      versions.append(tx, northstar, {
        documentId: document.id,
        body: 'first save',
        editedByUserId: world.northstar.owner.id,
      }),
    );
    expect(first.versionNo).toBe(1);
    expect(first.organizationId).toBe(northstar.organizationId);

    const second = await tenant.transaction(northstar, (tx) =>
      versions.append(tx, northstar, {
        documentId: document.id,
        body: 'second save',
        editedByUserId: world.northstar.owner.id,
      }),
    );
    expect(second.versionNo).toBe(2);

    // Newest-first list.
    const listed = await tenant.read(northstar, (tx) =>
      versions.list(tx, northstar, document.id),
    );
    expect(listed.map((row) => row.versionNo)).toEqual([2, 1]);

    // Compare reads one snapshot by number.
    const v1 = await tenant.read(northstar, (tx) =>
      versions.findByVersionNo(tx, northstar, document.id, 1),
    );
    expect(v1?.body).toBe('first save');

    // The parent document's current body was bumped to the newest save, in the append's txn.
    const parent = await tenant.read(northstar, (tx) =>
      documents.findById(tx, northstar, document.id),
    );
    expect(parent?.body).toBe('second save');

    // Restore is forward-append: a NEW version equal to v1, never a mutation of history.
    const restored = await tenant.transaction(northstar, (tx) =>
      versions.append(tx, northstar, {
        documentId: document.id,
        body: v1!.body,
        editedByUserId: world.northstar.owner.id,
      }),
    );
    expect(restored.versionNo).toBe(3);
    expect(restored.body).toBe('first save');
    const afterRestore = await tenant.read(northstar, (tx) =>
      versions.list(tx, northstar, document.id),
    );
    expect(afterRestore.map((row) => row.versionNo)).toEqual([3, 2, 1]);
  });
});

describe('a version never crosses a tenant boundary', () => {
  it('does not list or find another tenant’s versions', async () => {
    const twinDocument = await seedDocument(twin, world.twin.projectId, world.twin.owner.id);
    const twinVersion = await tenant.transaction(twin, (tx) =>
      versions.append(tx, twin, {
        documentId: twinDocument.id,
        body: 'twin only',
        editedByUserId: world.twin.owner.id,
      }),
    );

    // Northstar cannot see the twin's document's versions, even naming the id directly.
    const mine = await tenant.read(northstar, (tx) =>
      versions.list(tx, northstar, twinDocument.id),
    );
    expect(mine.map((row) => row.id)).not.toContain(twinVersion.id);

    const found = await tenant.read(northstar, (tx) =>
      versions.findByVersionNo(tx, northstar, twinDocument.id, 1),
    );
    expect(found).toBeNull();

    // It really does exist for its own tenant.
    const reallyExists = await tenant.read(twin, (tx) =>
      versions.findByVersionNo(tx, twin, twinDocument.id, 1),
    );
    expect(reallyExists?.id).toBe(twinVersion.id);
  });
});

describe('the Drizzle seam keeps the tenant guard on the path', () => {
  it('throws when a Drizzle query omits the tenant predicate, and names the table', async () => {
    const before = guardEvents.length;
    await expect(
      tenant.read(northstar, async (tx) => {
        const { tenantDrizzle } = await import('../src/common/database/drizzle.js');
        const { documentVersions } = await import('../src/common/database/schema.js');
        return tenantDrizzle(tx).select().from(documentVersions);
      }),
    ).rejects.toThrow(/no organization_id predicate/);

    expect(guardEvents.length).toBe(before + 1);
    expect(guardEvents.at(-1)?.tenantTables).toEqual(['document_versions']);
  });
});
