import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { DeliverableVersionsRepository } from '../src/modules/approvals/deliverable-versions.repository.js';
import { PortalFeedbackRepository } from '../src/modules/portal/feedback.repository.js';
import { ClientMessagesRepository } from '../src/modules/clients/client-messages.repository.js';
import { PortalBrandingRepository } from '../src/modules/portal/branding.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * Portal sub-pages (migrations 0189 portal_feedback, 0190 portal_client_messages, 0191
 * portal_branding) against a real MySQL server, through the tenant-scoped repositories and the
 * admin connection.
 *
 * On MySQL the tenant guarantee lives in application-layer controls (ADR-0001), so the repository
 * paths prove tenant isolation, CRUD and portal-user (client-org) scoping; the admin connection
 * then proves the three things only the engine enforces for a direct SQL session: the feedback
 * rating CHECK, and the immutability / append-only triggers each migration installs.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let northstar: TenantContext;
let twin: TenantContext;

const versions = new DeliverableVersionsRepository();
const feedback = new PortalFeedbackRepository();
const messages = new ClientMessagesRepository();
const branding = new PortalBrandingRepository();

function contextFor(organizationId: string, userId: string, membershipId: string): TenantContext {
  return createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-09-20',
    correlationId: uuidv7(),
  });
}

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

/** A fresh published version in the Northstar tenant for feedback to hang off. */
async function createVersion(): Promise<string> {
  const row = await tenant.transaction(northstar, (tx) =>
    versions.create(tx, northstar, {
      projectId: world.northstar.projectId,
      deliverableId: uuidv7(),
      contentHash: 'c'.repeat(64),
      createdByUserId: world.northstar.manager.id,
    }),
  );
  return row.id;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  northstar = contextFor(
    world.northstar.organizationId,
    world.northstar.manager.id,
    world.northstar.manager.membershipId,
  );
  twin = contextFor(world.twin.organizationId, world.twin.owner.id, world.twin.owner.membershipId);
}, 300_000);

beforeEach(async () => {
  await db.admin.query('DELETE FROM portal_feedback');
  await db.admin.query('DELETE FROM portal_client_messages');
  await db.admin.query('DELETE FROM portal_branding');
  await db.admin.query('DELETE FROM deliverable_versions');
});

afterAll(async () => {
  await db?.stop();
});

// ─── 0189 portal_feedback ────────────────────────────────────────────────────

describe('portal_feedback (0189)', () => {
  it('upserts one feedback per contact per version, revising in place', async () => {
    const versionId = await createVersion();
    const contact = world.atlas.reviewer.id;

    const first = await tenant.transaction(northstar, (tx) =>
      feedback.upsert(tx, northstar, {
        deliverableVersionId: versionId,
        clientContactUserId: contact,
        rating: 4,
        comment: null,
      }),
    );
    expect(first.rating).toBe(4);
    expect(first.comment).toBeNull();

    const revised = await tenant.transaction(northstar, (tx) =>
      feedback.upsert(tx, northstar, {
        deliverableVersionId: versionId,
        clientContactUserId: contact,
        rating: 2,
        comment: 'Second pass, please.',
      }),
    );
    // Edit in place: same identity, revised substance, created_at preserved.
    expect(revised.id).toBe(first.id);
    expect(revised.rating).toBe(2);
    expect(revised.comment).toBe('Second pass, please.');
    expect(revised.createdAt.getTime()).toBe(first.createdAt.getTime());

    const all = await tenant.read(northstar, (runner) =>
      feedback.listByVersion(runner, northstar, versionId),
    );
    expect(all).toHaveLength(1);
    const rows = await observe('SELECT COUNT(*) AS n FROM portal_feedback');
    expect(Number(rows[0]?.['n'])).toBe(1);
  });

  it('scopes feedback to the tenant: the adversarial twin reads nothing', async () => {
    const versionId = await createVersion();
    await tenant.transaction(northstar, (tx) =>
      feedback.upsert(tx, northstar, {
        deliverableVersionId: versionId,
        clientContactUserId: world.atlas.reviewer.id,
        rating: 5,
        comment: null,
      }),
    );

    // Same version id, the twin tenant whose org id differs by one hex digit — scoped out.
    const seenByTwin = await tenant.read(twin, (runner) =>
      feedback.listByVersion(runner, twin, versionId),
    );
    expect(seenByTwin).toHaveLength(0);
    const found = await tenant.read(twin, (runner) =>
      feedback.find(runner, twin, versionId, world.atlas.reviewer.id),
    );
    expect(found).toBeNull();
  });

  it('refuses a rating outside 1–5 at the engine (chk_portal_feedback_rating)', async () => {
    const versionId = await createVersion();
    await expect(
      db.admin.query(
        `INSERT INTO portal_feedback
           (id, organization_id, deliverable_version_id, client_contact_user_id, rating)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv7(), world.northstar.organizationId, versionId, world.atlas.reviewer.id, 6],
      ),
    ).rejects.toThrow();
  });

  it('holds version/tenant/author immutable at the engine (trigger)', async () => {
    const versionId = await createVersion();
    const otherVersionId = await createVersion();
    const saved = await tenant.transaction(northstar, (tx) =>
      feedback.upsert(tx, northstar, {
        deliverableVersionId: versionId,
        clientContactUserId: world.atlas.reviewer.id,
        rating: 3,
        comment: null,
      }),
    );

    await expect(
      db.admin.query(`UPDATE portal_feedback SET deliverable_version_id = ? WHERE id = ?`, [
        otherVersionId,
        saved.id,
      ]),
    ).rejects.toThrow(/immutable/);
  });
});

// ─── 0190 portal_client_messages ─────────────────────────────────────────────

describe('portal_client_messages (0190)', () => {
  it('appends messages and lists them per client-org scope, oldest first', async () => {
    const scope = world.atlas.clientOrganizationId;
    await tenant.transaction(northstar, (tx) =>
      messages.create(tx, northstar, {
        clientOrgScopeId: scope,
        authorUserId: world.atlas.reviewer.id,
        subject: 'Kick-off question',
        body: 'When does review start?',
      }),
    );
    await tenant.transaction(northstar, (tx) =>
      messages.create(tx, northstar, {
        clientOrgScopeId: scope,
        authorUserId: world.atlas.reviewer.id,
        subject: 'Follow-up',
        body: 'Any update?',
      }),
    );

    const thread = await tenant.read(northstar, (runner) =>
      messages.listForScope(runner, northstar, scope),
    );
    expect(thread.map((m) => m.subject)).toEqual(['Kick-off question', 'Follow-up']);
  });

  it('isolates one client-org thread from another in the same tenant', async () => {
    await tenant.transaction(northstar, (tx) =>
      messages.create(tx, northstar, {
        clientOrgScopeId: world.atlas.clientOrganizationId,
        authorUserId: world.atlas.reviewer.id,
        subject: 'Atlas only',
        body: 'This belongs to Atlas.',
      }),
    );

    // Meridian is a second client of the same studio — it must not see Atlas's thread.
    const meridianThread = await tenant.read(northstar, (runner) =>
      messages.listForScope(runner, northstar, world.meridian.clientOrganizationId),
    );
    expect(meridianThread).toHaveLength(0);
  });

  it('is append-only: a direct UPDATE is refused at the engine (trigger)', async () => {
    const created = await tenant.transaction(northstar, (tx) =>
      messages.create(tx, northstar, {
        clientOrgScopeId: world.atlas.clientOrganizationId,
        authorUserId: world.atlas.reviewer.id,
        subject: 'Original',
        body: 'As written.',
      }),
    );

    await expect(
      db.admin.query(`UPDATE portal_client_messages SET subject = ? WHERE id = ?`, [
        'Tampered',
        created.id,
      ]),
    ).rejects.toThrow(/append-only/);
  });
});

// ─── 0191 portal_branding ────────────────────────────────────────────────────

describe('portal_branding (0191)', () => {
  it('upserts one branding row per client org, replacing in place', async () => {
    const scope = world.atlas.clientOrganizationId;
    const first = await tenant.transaction(northstar, (tx) =>
      branding.upsert(tx, northstar, scope, {
        accentColor: '#111111',
        welcomeHeading: 'Welcome, Atlas',
        welcomeText: 'Your projects live here.',
        updatedBy: world.northstar.manager.id,
      }),
    );
    expect(first.accentColor).toBe('#111111');

    const replaced = await tenant.transaction(northstar, (tx) =>
      branding.upsert(tx, northstar, scope, {
        accentColor: '#222222',
        welcomeHeading: 'Hello again',
        welcomeText: null,
        updatedBy: world.northstar.owner.id,
      }),
    );
    // One row per client org: identity preserved, substance replaced.
    expect(replaced.id).toBe(first.id);
    expect(replaced.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(replaced.accentColor).toBe('#222222');
    expect(replaced.welcomeText).toBeNull();
    expect(replaced.updatedBy).toBe(world.northstar.owner.id);

    const rows = await observe('SELECT COUNT(*) AS n FROM portal_branding');
    expect(Number(rows[0]?.['n'])).toBe(1);
  });

  it('scopes branding per client org and per tenant', async () => {
    await tenant.transaction(northstar, (tx) =>
      branding.upsert(tx, northstar, world.atlas.clientOrganizationId, {
        accentColor: '#333333',
        welcomeHeading: null,
        welcomeText: null,
        updatedBy: world.northstar.manager.id,
      }),
    );

    // A sibling client of the same studio has no branding of its own.
    const meridian = await tenant.read(northstar, (runner) =>
      branding.findForClientOrg(runner, northstar, world.meridian.clientOrganizationId),
    );
    expect(meridian).toBeNull();

    // The adversarial twin tenant sees nothing, even naming Atlas's own scope id.
    const byTwin = await tenant.read(twin, (runner) =>
      branding.findForClientOrg(runner, twin, world.atlas.clientOrganizationId),
    );
    expect(byTwin).toBeNull();
  });

  it('pins identity columns at the engine (trigger)', async () => {
    const saved = await tenant.transaction(northstar, (tx) =>
      branding.upsert(tx, northstar, world.atlas.clientOrganizationId, {
        accentColor: '#444444',
        welcomeHeading: null,
        welcomeText: null,
        updatedBy: world.northstar.manager.id,
      }),
    );

    await expect(
      db.admin.query(`UPDATE portal_branding SET client_org_scope_id = ? WHERE id = ?`, [
        world.meridian.clientOrganizationId,
        saved.id,
      ]),
    ).rejects.toThrow(/immutable/);
  });
});
