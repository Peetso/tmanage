import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import { WORKER_OUTBOX_HANDLERS, createWorkerDatabase, runOutboxBatch } from '@tmanage/worker';
import type { WorkerDatabase } from '@tmanage/worker';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { OutboxEventsRepository } from '../src/modules/platform/outbox-events.repository.js';
import { ProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { WorkItemsRepository } from '../src/modules/work/work-items.repository.js';
import { ClientRequestsRepository } from '../src/modules/requests/client-requests.repository.js';
import { ClientRequestsService } from '../src/modules/requests/client-requests.service.js';
import { ClientOrganizationsRepository } from '../src/modules/clients/client-organizations.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * NOTIF-001 against a real server — the notification record and the two consumers.
 *
 * What only this suite can prove, and each is a sentence from a governing document:
 *
 * 1. **"Manager inbox"** (`24-EVENT-CATALOG` §4, `client_request.submitted.v1`): a
 *    submission notifies exactly the internal people whose role ceiling includes
 *    `client_request.triage` *and* who can reach the project — and nobody else. The member
 *    on the project without the capability, the client who filed it, and the adversarial
 *    twin tenant all receive nothing.
 * 2. **"Client notifications"** (§4, `client_request.transitioned.v1`): the answer reaches
 *    the person who asked — except `withdrawn`, which is their own act.
 * 3. **"Consumers deduplicate"** (§2): redelivering an event adds no second row, because
 *    `uq_notifications_dedupe` is the consumer's idempotency; a *legal state cycle* still
 *    notifies each time, because the key carries the request version.
 * 4. **"Delayed notifications must not reveal an object after access was revoked"** (§6):
 *    a client membership suspended between the event and its delivery is told nothing.
 * 5. **Only `read_at` may ever change, forward only** — the 0010 trigger, exercised from
 *    both directions.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let workerDb: WorkerDatabase;
let ownerCtx: TenantContext;
let owner: Principal;
let clientCtx: TenantContext;
let clientAdmin: Principal;
let requests: ClientRequestsService;

const OPTIONS = {
  batchSize: 50,
  maxAttempts: 3,
  backoffBaseMs: 60_000,
  backoffCapMs: 900_000,
};

const contextFor = (
  organizationId: string,
  userId: string,
  membershipId: string,
  kind: 'internal' | 'client',
  role: Role,
): TenantContext =>
  createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: kind,
    capabilities: capabilitiesFor(role),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

interface ObservedNotification {
  readonly id: string;
  readonly recipientUserId: string;
  readonly type: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly dedupeKey: string;
  readonly read: boolean;
}

async function notificationsFor(objectId: string): Promise<ObservedNotification[]> {
  const rows = await observe(
    `select id, recipient_user_id, type, object_type, object_id, dedupe_key, read_at
       from notifications where organization_id = ? and object_id = ? order by id`,
    [world.northstar.organizationId, objectId],
  );
  return rows.map((row) => ({
    id: String(row['id']),
    recipientUserId: String(row['recipient_user_id']),
    type: String(row['type']),
    objectType: String(row['object_type']),
    objectId: String(row['object_id']),
    dedupeKey: String(row['dedupe_key']),
    read: row['read_at'] !== null,
  }));
}

async function drain(): Promise<void> {
  for (;;) {
    const report = await runOutboxBatch(workerDb, WORKER_OUTBOX_HANDLERS, OPTIONS);
    expect(report.failed, JSON.stringify(report.failures)).toBe(0);
    if (report.claimed === 0) return;
  }
}

async function submitRequest(title: string): Promise<{ id: string; version: number }> {
  const view = await requests.submit(clientCtx, clientAdmin, {
    projectId: world.northstar.projectId,
    title,
    description: 'Filed by the notifications suite.',
  });
  return { id: view.id, version: 1 };
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 2, statementTimeoutMs: 15_000 });

  ownerCtx = contextFor(
    world.northstar.organizationId,
    world.northstar.owner.id,
    world.northstar.owner.membershipId,
    'internal',
    'owner',
  );
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

  clientCtx = contextFor(
    world.northstar.organizationId,
    world.atlas.admin.id,
    world.atlas.admin.membershipId,
    'client',
    'client_admin',
  );
  clientAdmin = {
    userId: clientCtx.userId,
    organizationId: clientCtx.organizationId,
    kind: 'client',
    role: 'client_admin',
    membershipId: clientCtx.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: world.atlas.clientOrganizationId,
    projectIds: [world.northstar.projectId],
    hasOrgWideScope: false,
  };

  const audit = new AuditService(tenant, new AuditEventsRepository());
  requests = new ClientRequestsService(
    tenant,
    new ClientRequestsRepository(),
    audit,
    new ProjectsRepository(),
    new WorkItemsRepository(),
    new ClientOrganizationsRepository(),
    new OutboxEventsRepository(),
  );
});

afterAll(async () => {
  await workerDb?.end();
  await db?.stop();
});

describe('a submitted request notifies the people who can answer it', () => {
  let requestId: string;

  it('reaches every triage-capable member with a relation, and nobody else', async () => {
    const submitted = await submitRequest('Extend the loyalty desk hours');
    requestId = submitted.id;
    await drain();

    const rows = await notificationsFor(requestId);
    const submissions = rows.filter((row) => row.type === 'client_request.submitted.v1');
    const recipients = submissions.map((row) => row.recipientUserId).sort();

    // The owner (org-wide) and the manager (triage-capable, on the project). The designer
    // is on the project too, and receives nothing: the `member` ceiling has no
    // `client_request.triage` — this is the assertion that the capability half runs.
    expect(recipients).toEqual([world.northstar.manager.id, world.northstar.owner.id].sort());
    expect(recipients).not.toContain(world.northstar.designer.id);
    expect(recipients).not.toContain(world.atlas.admin.id);

    for (const row of submissions) {
      expect(row.objectType).toBe('client_request');
      expect(row.dedupeKey).toBe(`client_request.submitted:${requestId}`);
      expect(row.read).toBe(false);
    }

    // The adversarial twin heard nothing about it.
    const twinRows = await observe(
      'select count(*) as n from notifications where organization_id = ?',
      [world.twin.organizationId],
    );
    expect(Number(twinRows[0]?.['n'])).toBe(0);
  });

  it('redelivery adds no second row', async () => {
    const before = (await notificationsFor(requestId)).length;

    await db.admin.execute(
      `update outbox_events set published_at = null,
              available_at = date_sub(utc_timestamp(3), interval 1 second)
        where organization_id = ? and type = 'client_request.submitted.v1'`,
      [world.northstar.organizationId],
    );
    await drain();

    expect(await notificationsFor(requestId)).toHaveLength(before);
  });

  it('a transition notifies the submitter, and a legal cycle notifies each time', async () => {
    await requests.triage(ownerCtx, owner, requestId, 1, 'triage');
    await requests.triage(ownerCtx, owner, requestId, 2, 'needs_clarification', {
      clarificationQuestion: 'Which desk, and which hours?',
    });
    await drain();

    const transitions = (await notificationsFor(requestId)).filter(
      (row) => row.type === 'client_request.transitioned.v1',
    );
    // Both moves reached the one person who asked — and only that person.
    expect(transitions.map((row) => row.recipientUserId)).toEqual([
      world.atlas.admin.id,
      world.atlas.admin.id,
    ]);
    const keys = transitions.map((row) => row.dedupeKey).sort();
    expect(keys).toEqual(
      [
        `client_request.transitioned:${requestId}:triage:2`,
        `client_request.transitioned:${requestId}:needs_clarification:3`,
      ].sort(),
    );
  });
});

describe('the transitions that must stay silent', () => {
  it('a withdrawal does not tell the submitter what they just did', async () => {
    const submitted = await submitRequest('Add a seasonal menu page');
    await requests.withdraw(clientCtx, clientAdmin, submitted.id, 1);
    await drain();

    const rows = await notificationsFor(submitted.id);
    expect(rows.filter((row) => row.type === 'client_request.transitioned.v1')).toHaveLength(0);
    // The submission notification still exists — the silence is about the withdrawal only.
    expect(rows.filter((row) => row.type === 'client_request.submitted.v1')).not.toHaveLength(0);
  });

  it('a recipient whose access was revoked between event and delivery is told nothing', async () => {
    const submitted = await submitRequest('Refresh the lobby photography');
    await drain(); // The submission notifications land while access is still live.

    await requests.triage(ownerCtx, owner, submitted.id, 1, 'triage');
    // Revoked after the event was written, before the relay delivers it — §6's exact case.
    await db.admin.execute(
      `update client_memberships set status = 'suspended'
        where organization_id = ? and user_id = ?`,
      [world.northstar.organizationId, world.atlas.admin.id],
    );
    await drain();

    const rows = await notificationsFor(submitted.id);
    expect(rows.filter((row) => row.type === 'client_request.transitioned.v1')).toHaveLength(0);

    // Restored for any case after this one.
    await db.admin.execute(
      `update client_memberships set status = 'active'
        where organization_id = ? and user_id = ?`,
      [world.northstar.organizationId, world.atlas.admin.id],
    );
  });
});

describe('the row itself', () => {
  it('only read_at may change, and only forward', async () => {
    const rows = await observe('select id from notifications where organization_id = ? limit 1', [
      world.northstar.organizationId,
    ]);
    const id = String(rows[0]?.['id']);
    expect(id).toBeTruthy();

    // Rewriting the reference is refused at the engine, for every credential.
    await expect(
      db.admin.execute(`update notifications set object_id = ? where id = ?`, [uuidv7(), id]),
    ).rejects.toThrow(/only read_at may change/);

    // Marking read is the one verb the row has…
    await db.admin.execute(`update notifications set read_at = utc_timestamp(3) where id = ?`, [
      id,
    ]);
    // …and it cannot be taken back.
    await expect(
      db.admin.execute(`update notifications set read_at = null where id = ?`, [id]),
    ).rejects.toThrow(/cannot be cleared/);
  });
});
