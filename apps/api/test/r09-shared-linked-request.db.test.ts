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
import { WorkItemsService } from '../src/modules/work/work-items.service.js';
import { ClientRequestsRepository } from '../src/modules/requests/client-requests.repository.js';
import { ClientRequestsService } from '../src/modules/requests/client-requests.service.js';
import { ClientOrganizationsRepository } from '../src/modules/clients/client-organizations.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * R09 against a real server — two requests sharing one linked work item.
 *
 * Acceptance permits linking existing work (`ClientRequestsService.accept`'s `linkedWorkItemId`
 * path) and no migration enforces one request per linked item, so two accepted requests can
 * point at the same work item. The review found the lifecycle consumer fetched a single row
 * with `LIMIT 1`, so only one request advanced when the item moved and the other went stale.
 *
 * This drives the real relay: both requests are brought to `accepted` against the same work
 * item, the item is moved to `in_progress` and then `done`, and *both* requests must follow —
 * two NULL-actor audit rows and two transitioned outbox events per work-item transition.
 *
 * Unexecuted here (the database/e2e lock is held by another job). Run with:
 *   pnpm --filter @tmanage/api test -- --project database r09-shared-linked-request
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let workerDb: WorkerDatabase;
let ownerCtx: TenantContext;
let owner: Principal;
let clientCtx: TenantContext;
let clientAdmin: Principal;

let audit: AuditService;
let outboxRepo: OutboxEventsRepository;
let work: WorkItemsService;
let requests: ClientRequestsService;

let requestAId: string;
let requestBId: string;
let sharedWorkItemId: string;

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

async function requestState(id: string): Promise<string> {
  const rows = await observe(
    'select state from client_requests where organization_id = ? and id = ?',
    [world.northstar.organizationId, id],
  );
  return String(rows[0]?.['state']);
}

/** NULL-actor lifecycle audit rows for one request — the relay's signature in the trail. */
async function transitionAuditsFor(requestId: string): Promise<RowDataPacket[]> {
  return observe(
    `select object_id, metadata_json from audit_events
      where organization_id = ? and action = 'client_request.transitioned'
        and actor_user_id is null and object_id = ? order by id`,
    [world.northstar.organizationId, requestId],
  );
}

/** The relay's own transitioned events aimed at one request, with a given target status. */
async function transitionedEvents(requestId: string, toStatus: string): Promise<number> {
  const rows = await observe(
    `select payload_json from outbox_events
      where organization_id = ? and type = 'client_request.transitioned.v1'
        and aggregate_id = ? order by id`,
    [world.northstar.organizationId, requestId],
  );
  return rows.filter((row) => {
    const payload =
      typeof row['payload_json'] === 'string'
        ? (JSON.parse(row['payload_json']) as Record<string, unknown>)
        : (row['payload_json'] as Record<string, unknown>);
    return payload['toStatus'] === toStatus;
  }).length;
}

async function drain(): Promise<void> {
  for (;;) {
    const report = await runOutboxBatch(workerDb, WORKER_OUTBOX_HANDLERS, OPTIONS);
    if (report.claimed === 0) return;
  }
}

/** Bring a freshly submitted request to `accepted`, linking `linkTo` if given. */
async function acceptRequest(title: string, linkTo?: string): Promise<string> {
  const view = await requests.submit(clientCtx, clientAdmin, {
    projectId: world.northstar.projectId,
    title,
    description: `${title} — filed for the R09 shared-link case.`,
  });
  await requests.triage(ownerCtx, owner, view.id, 1, 'triage');
  const accepted = await requests.accept(ownerCtx, owner, view.id, 2, {
    clientSafeScopeSummary: 'Deliver the shared work item.',
    commitment: { kind: 'unscheduled' },
    ...(linkTo ? { linkedWorkItemId: linkTo } : {}),
  });
  if (!linkTo) sharedWorkItemId = accepted.workItemId;
  return view.id;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  workerDb = createWorkerDatabase({
    url: db.url,
    connectionLimit: 2,
    statementTimeoutMs: 15_000,
  });

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

  audit = new AuditService(tenant, new AuditEventsRepository());
  outboxRepo = new OutboxEventsRepository();
  work = new WorkItemsService(
    tenant,
    new WorkItemsRepository(),
    audit,
    new ProjectsRepository(),
    outboxRepo,
  );
  requests = new ClientRequestsService(
    tenant,
    new ClientRequestsRepository(),
    audit,
    new ProjectsRepository(),
    new WorkItemsRepository(),
    new ClientOrganizationsRepository(),
    outboxRepo,
  );
});

afterAll(async () => {
  await workerDb?.end();
  await db?.stop();
});

describe('two requests linked to one work item', () => {
  it('accepts a second request against the first request’s work item', async () => {
    requestAId = await acceptRequest('Rebuild the swatch pages');
    requestBId = await acceptRequest('Reissue the same swatch pages', sharedWorkItemId);

    expect(sharedWorkItemId).toBeTruthy();
    const linked = await observe(
      'select id from client_requests where organization_id = ? and linked_work_item_id = ? order by id',
      [world.northstar.organizationId, sharedWorkItemId],
    );
    expect(linked.map((row) => String(row['id'])).sort()).toEqual([requestAId, requestBId].sort());
    expect(await requestState(requestAId)).toBe('accepted');
    expect(await requestState(requestBId)).toBe('accepted');
  });

  it('advances every linked request when the shared work item starts', async () => {
    // Clear the acceptance backlog first: none of it is a work-item transition the rule reads.
    await drain();
    expect(await requestState(requestAId)).toBe('accepted');
    expect(await requestState(requestBId)).toBe('accepted');

    await work.transition(ownerCtx, owner, sharedWorkItemId, 1, 'ready');
    await work.transition(ownerCtx, owner, sharedWorkItemId, 2, 'in_progress');
    await drain();

    // R09: BOTH requests follow, not just the one LIMIT 1 would have returned.
    expect(await requestState(requestAId)).toBe('planned');
    expect(await requestState(requestBId)).toBe('planned');
    expect(await transitionAuditsFor(requestAId)).toHaveLength(1);
    expect(await transitionAuditsFor(requestBId)).toHaveLength(1);
    expect(await transitionedEvents(requestAId, 'planned')).toBe(1);
    expect(await transitionedEvents(requestBId, 'planned')).toBe(1);
  });

  it('advances every linked request again when the shared work item is done', async () => {
    await work.transition(ownerCtx, owner, sharedWorkItemId, 3, 'internal_review');
    await work.transition(ownerCtx, owner, sharedWorkItemId, 4, 'done', {
      ownerId: world.northstar.owner.id,
      completedAt: new Date().toISOString(),
    });
    await drain();

    expect(await requestState(requestAId)).toBe('delivered');
    expect(await requestState(requestBId)).toBe('delivered');
    expect(await transitionedEvents(requestAId, 'delivered')).toBe(1);
    expect(await transitionedEvents(requestBId, 'delivered')).toBe(1);
  });
});
