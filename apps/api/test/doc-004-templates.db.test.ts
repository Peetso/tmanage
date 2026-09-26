import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import { DocumentsRepository } from '../src/modules/docs/documents.repository.js';
import { DocumentTemplatesRepository } from '../src/modules/docs/document-templates.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * DOC-04/ADM-06 (x119). The document-templates repository against a real server and the adversarial
 * near-identical tenant pair the isolation corpus uses. Three things are under test: the migration
 * applies and a tenant-scoped template round-trips (create → name-ordered list → apply seeds a
 * document from the body without mutating the template), a template never crosses a tenant boundary
 * (list and find), and the tenant guard is genuinely on the Drizzle path (an unscoped
 * `SELECT ... FROM document_templates` still throws and names the table). The pair's ids differ only
 * in the final hex digit, so a missing predicate would leak rather than pass.
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
const templates = new DocumentTemplatesRepository();

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

async function seedTemplate(context: TenantContext, ownerId: string, name = 'Kickoff template') {
  return tenant.transaction(context, (tx) =>
    templates.create(tx, context, {
      name,
      purpose: 'Start a project kickoff brief',
      body: 'template body prose',
      createdByUserId: ownerId,
    }),
  );
}

describe('a tenant-scoped template round-trips and seeds a document on apply', () => {
  it('creates, lists name-ascending, and applies without mutating the template', async () => {
    const zebra = await seedTemplate(northstar, world.northstar.owner.id, 'Zebra template');
    const alpha = await seedTemplate(northstar, world.northstar.owner.id, 'Alpha template');
    expect(alpha.organizationId).toBe(northstar.organizationId);

    // Name-ascending list.
    const listed = await tenant.read(northstar, (tx) => templates.list(tx, northstar));
    expect(listed.map((row) => row.name)).toEqual(['Alpha template', 'Zebra template']);

    // Apply seeds a NEW document from the template body (the create path the service reuses).
    const document = await tenant.transaction(northstar, (tx) =>
      documents.create(tx, northstar, {
        projectId: world.northstar.projectId,
        title: alpha.name,
        body: alpha.body,
        createdByUserId: world.northstar.owner.id,
      }),
    );
    expect(document.body).toBe('template body prose');
    expect(document.title).toBe('Alpha template');

    // The template is untouched: it still reads back exactly as created.
    const reread = await tenant.read(northstar, (tx) =>
      templates.findById(tx, northstar, alpha.id),
    );
    expect(reread?.body).toBe('template body prose');
    expect(reread?.name).toBe('Alpha template');
    // The applied document is its own row, not the template.
    expect(document.id).not.toBe(alpha.id);
    void zebra;
  });
});

describe('a template never crosses a tenant boundary', () => {
  it('does not list or find another tenant’s templates', async () => {
    const twinTemplate = await seedTemplate(twin, world.twin.owner.id, 'Twin only');

    // Northstar cannot see the twin's template, even naming the id directly.
    const mine = await tenant.read(northstar, (tx) => templates.list(tx, northstar));
    expect(mine.map((row) => row.id)).not.toContain(twinTemplate.id);

    const found = await tenant.read(northstar, (tx) =>
      templates.findById(tx, northstar, twinTemplate.id),
    );
    expect(found).toBeNull();

    // It really does exist for its own tenant.
    const reallyExists = await tenant.read(twin, (tx) =>
      templates.findById(tx, twin, twinTemplate.id),
    );
    expect(reallyExists?.id).toBe(twinTemplate.id);
  });
});

describe('the Drizzle seam keeps the tenant guard on the path', () => {
  it('throws when a Drizzle query omits the tenant predicate, and names the table', async () => {
    const before = guardEvents.length;
    await expect(
      tenant.read(northstar, async (tx) => {
        const { tenantDrizzle } = await import('../src/common/database/drizzle.js');
        const { documentTemplates } = await import('../src/common/database/schema.js');
        return tenantDrizzle(tx).select().from(documentTemplates);
      }),
    ).rejects.toThrow(/no organization_id predicate/);

    expect(guardEvents.length).toBe(before + 1);
    expect(guardEvents.at(-1)?.tenantTables).toEqual(['document_templates']);
  });
});
