import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { WORKER_OUTBOX_HANDLERS, createWorkerDatabase, runOutboxBatch } from '@tmanage/worker';
import type { WorkerDatabase } from '@tmanage/worker';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { OutboxEventsRepository } from '../src/modules/platform/outbox-events.repository.js';
import { ProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { WorkItemsRepository } from '../src/modules/work/work-items.repository.js';
import { WorkGraphRepository } from '../src/modules/work/work-graph.repository.js';
import { WorkItemsService } from '../src/modules/work/work-items.service.js';
import { ApiError } from '../src/common/http/errors.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * WORK-003 against a real server — the blocker ledger, the dependency edges, and the
 * health signal.
 *
 * What only this suite can prove:
 *
 * 1. **US-B04's blocker is durable.** Entering `blocked` writes the reason, the ask, the
 *    optional owner and the since date; leaving records the resolution, once, and the 0011
 *    trigger refuses every other change. Before this ticket the machine's required facts
 *    were checked and then discarded.
 * 2. **One active blocker per item is the engine's promise**, not the service's: the
 *    generated column's unique key refuses a second open entry under any credential.
 * 3. **Edges are acyclic**, self-edges refused by trigger, longer cycles by the recursive
 *    walk — including the transitive case a single-row check cannot see.
 * 4. **The health signal is computed and explainable** — `09-MVP-PRD` §63: an active
 *    blocker, a late predecessor, and a blocked predecessor each cost the "on track"
 *    claim by name; a landed predecessor costs nothing.
 * 5. **The ask's owner is notified once** — §4's "blocker activated → notification",
 *    through the real relay, idempotent under redelivery.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let workerDb: WorkerDatabase;
let ownerCtx: TenantContext;
let owner: Principal;
let work: WorkItemsService;

const OPTIONS = { batchSize: 50, maxAttempts: 3, backoffBaseMs: 60_000, backoffCapMs: 900_000 };

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function drain(): Promise<void> {
  for (;;) {
    const report = await runOutboxBatch(workerDb, WORKER_OUTBOX_HANDLERS, OPTIONS);
    expect(report.failed, JSON.stringify(report.failures)).toBe(0);
    if (report.claimed === 0) return;
  }
}

async function newItem(title: string, dueAt?: Date): Promise<{ id: string }> {
  const view = await work.create(ownerCtx, owner, {
    projectId: world.northstar.projectId,
    title,
    ...(dueAt === undefined ? {} : { dueAt }),
  });
  return { id: view.id };
}

/** backlog → ready → in_progress, returning the version after the moves. */
async function startWork(workItemId: string): Promise<number> {
  await work.transition(ownerCtx, owner, workItemId, 1, 'ready');
  const moved = await work.transition(ownerCtx, owner, workItemId, 2, 'in_progress');
  return moved.version;
}

async function expectApiError(promise: Promise<unknown>, status: number): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    return error as ApiError;
  }
  throw new Error(`expected a ${status} refusal and got success`);
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 2, statementTimeoutMs: 15_000 });

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

  const audit = new AuditService(tenant, new AuditEventsRepository());
  work = new WorkItemsService(
    tenant,
    new WorkItemsRepository(),
    audit,
    new ProjectsRepository(),
    new OutboxEventsRepository(),
    new WorkGraphRepository(),
  );
});

afterAll(async () => {
  await workerDb?.end();
  await db?.stop();
});

describe('the blocker ledger', () => {
  let itemId: string;
  let blockerId: string;

  it('entering blocked persists reason, ask, owner and since', async () => {
    itemId = (await newItem('Migrate the booking engine')).id;
    const version = await startWork(itemId);
    await work.transition(ownerCtx, owner, itemId, version, 'blocked', {
      blockerReason: 'The vendor sandbox is down',
      blockerAsk: 'Chase the vendor for a restore window',
      blockerOwnerUserId: world.northstar.manager.id,
    });

    const rows = await observe(
      `select id, reason, ask, owner_user_id, created_by_user_id, resolved_at
         from work_blockers where organization_id = ? and work_item_id = ?`,
      [world.northstar.organizationId, itemId],
    );
    expect(rows).toHaveLength(1);
    blockerId = String(rows[0]?.['id']);
    expect(String(rows[0]?.['reason'])).toBe('The vendor sandbox is down');
    expect(String(rows[0]?.['ask'])).toBe('Chase the vendor for a restore window');
    expect(String(rows[0]?.['owner_user_id'])).toBe(world.northstar.manager.id);
    expect(String(rows[0]?.['created_by_user_id'])).toBe(world.northstar.owner.id);
    expect(rows[0]?.['resolved_at']).toBeNull();

    // The event travels ids only — no reason, no ask.
    const events = await observe(
      `select payload_json from outbox_events
        where organization_id = ? and type = 'work_item.blocked.v1'`,
      [world.northstar.organizationId],
    );
    expect(events).toHaveLength(1);
    const raw = events[0]?.['payload_json'];
    const payload = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    expect(payload).toEqual({
      workItemId: itemId,
      projectId: world.northstar.projectId,
      blockerId,
      ownerUserId: world.northstar.manager.id,
    });
    expect(JSON.stringify(payload)).not.toContain('vendor');
  });

  it('notifies the ask owner exactly once, through the real relay', async () => {
    await drain();
    const count = async (): Promise<number> => {
      const rows = await observe(
        `select count(*) as n from notifications
          where organization_id = ? and recipient_user_id = ? and type = 'work_item.blocked.v1'`,
        [world.northstar.organizationId, world.northstar.manager.id],
      );
      return Number(rows[0]?.['n']);
    };
    expect(await count()).toBe(1);

    // At-least-once, forced: the redelivered event writes no second row.
    await db.admin.execute(
      `update outbox_events set published_at = null,
              available_at = date_sub(utc_timestamp(3), interval 1 second)
        where organization_id = ? and type = 'work_item.blocked.v1'`,
      [world.northstar.organizationId],
    );
    await drain();
    expect(await count()).toBe(1);
  });

  it('the engine refuses a second active blocker for the same item', async () => {
    await expect(
      db.admin.execute(
        `insert into work_blockers
           (id, organization_id, work_item_id, reason, ask, created_by_user_id, created_at)
         values (?, ?, ?, 'second', 'second', ?, utc_timestamp(3))`,
        [uuidv7(), world.northstar.organizationId, itemId, world.northstar.owner.id],
      ),
    ).rejects.toThrow(/Duplicate entry/);
  });

  it('leaving blocked resolves the entry, and history cannot be rewritten', async () => {
    await work.transition(ownerCtx, owner, itemId, 4, 'in_progress', {
      blockerResolution: 'Vendor restored the sandbox overnight',
    });

    const rows = await observe(
      `select resolved_at, resolution, resolved_by_user_id from work_blockers where id = ?`,
      [blockerId],
    );
    expect(rows[0]?.['resolved_at']).not.toBeNull();
    expect(String(rows[0]?.['resolution'])).toBe('Vendor restored the sandbox overnight');
    expect(String(rows[0]?.['resolved_by_user_id'])).toBe(world.northstar.owner.id);

    // A resolved blocker is history — for every credential.
    await expect(
      db.admin.execute(`update work_blockers set resolution = 'rewritten' where id = ?`, [
        blockerId,
      ]),
    ).rejects.toThrow(/cannot change/);

    // Blocking again opens a NEW entry: the ledger grows, the history stands.
    await work.transition(ownerCtx, owner, itemId, 5, 'blocked', {
      blockerReason: 'Now the DNS cutover is stuck',
      blockerAsk: 'Get the registrar on the phone',
    });
    const ledger = await work.listBlockers(ownerCtx, owner, itemId);
    expect(ledger).toHaveLength(2);
    expect(ledger[0]?.resolvedAt).not.toBeNull();
    expect(ledger[1]?.resolvedAt).toBeNull();
    expect(ledger[1]?.ownerUserId).toBeNull();
  });

  it('refuses a blocker owner who cannot act in this organization', async () => {
    const strangerItem = (await newItem('Draft the migration runbook')).id;
    const version = await startWork(strangerItem);
    const error = await expectApiError(
      work.transition(ownerCtx, owner, strangerItem, version, 'blocked', {
        blockerReason: 'Waiting on review',
        blockerAsk: 'Review the draft',
        blockerOwnerUserId: world.twin.owner.id,
      }),
      422,
    );
    expect(error.message).toContain('not a member');
  });
});

describe('the dependency edges', () => {
  let a: string;
  let b: string;
  let c: string;

  it('adds an edge, refuses the duplicate, the self-edge and the cross-tenant predecessor', async () => {
    a = (await newItem('Design the new nav')).id;
    b = (await newItem('Approve the sitemap')).id;
    c = (await newItem('Write the copy deck')).id;

    const edge = await work.addDependency(ownerCtx, owner, a, b);
    expect(edge.workItemId).toBe(a);
    expect(edge.dependsOnWorkItemId).toBe(b);

    await expectApiError(work.addDependency(ownerCtx, owner, a, b), 409);
    await expectApiError(work.addDependency(ownerCtx, owner, a, a), 422);
    // Another tenant's row must be indistinguishable from one that does not exist.
    await expectApiError(work.addDependency(ownerCtx, owner, a, world.twin.workItemId), 404);
  });

  it('refuses the cycle a single-row check cannot see', async () => {
    await work.addDependency(ownerCtx, owner, b, c);
    // a -> b -> c stands; c -> a would close the loop two edges away.
    await expectApiError(work.addDependency(ownerCtx, owner, c, a), 422);
    // And the direct reversal.
    await expectApiError(work.addDependency(ownerCtx, owner, b, a), 422);
  });

  it('an edge is immutable at the engine; removal is audited', async () => {
    const rows = await observe(
      `select id from work_item_dependencies
        where organization_id = ? and work_item_id = ? and depends_on_work_item_id = ?`,
      [world.northstar.organizationId, b, c],
    );
    const edgeId = String(rows[0]?.['id']);

    await expect(
      db.admin.execute(
        `update work_item_dependencies set depends_on_work_item_id = ? where id = ?`,
        [a, edgeId],
      ),
    ).rejects.toThrow(/immutable/);

    await work.removeDependency(ownerCtx, owner, b, edgeId);
    const audits = await observe(
      `select object_id, metadata_json from audit_events
        where organization_id = ? and action = 'work_item.dependency_removed'`,
      [world.northstar.organizationId],
    );
    expect(audits).toHaveLength(1);
    expect(String(audits[0]?.['object_id'])).toBe(b);

    await expectApiError(work.removeDependency(ownerCtx, owner, b, edgeId), 404);
  });
});

describe('the health signal', () => {
  it('a clean item is on track, and says when it was asked', async () => {
    const item = (await newItem('Publish the launch post')).id;
    const health = await work.healthOf(ownerCtx, owner, item);
    expect(health.status).toBe('on_track');
    expect(health.signals).toEqual([]);
    expect(new Date(health.computedAt).getTime()).not.toBeNaN();
  });

  it('an active blocker is the whole answer, and names its ask', async () => {
    const item = (await newItem('Cut the release')).id;
    const version = await startWork(item);
    await work.transition(ownerCtx, owner, item, version, 'blocked', {
      blockerReason: 'Staging is red',
      blockerAsk: 'Fix the failing smoke test',
    });

    const health = await work.healthOf(ownerCtx, owner, item);
    expect(health.status).toBe('blocked');
    expect(health.signals).toHaveLength(1);
    const signal = health.signals[0];
    expect(signal?.kind).toBe('blocked');
    if (signal?.kind === 'blocked') {
      expect(signal.ask).toBe('Fix the failing smoke test');
    }
  });

  it('a late predecessor costs the on-track claim by name; a landed one costs nothing', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const successor = (await newItem('Assemble the brand book')).id;
    const late = (await newItem('Deliver final photography', yesterday)).id;
    await work.addDependency(ownerCtx, owner, successor, late);

    let health = await work.healthOf(ownerCtx, owner, successor);
    expect(health.status).toBe('at_risk');
    expect(health.signals).toHaveLength(1);
    const signal = health.signals[0];
    expect(signal?.kind).toBe('predecessor_late');
    if (signal?.kind === 'predecessor_late') {
      expect(signal.workItemId).toBe(late);
      expect(signal.title).toBe('Deliver final photography');
    }

    // The predecessor lands: backlog → ready → in_progress → internal_review → done.
    const version = await startWork(late);
    await work.transition(ownerCtx, owner, late, version, 'internal_review');
    await work.transition(ownerCtx, owner, late, version + 1, 'done', {
      ownerId: world.northstar.owner.id,
      completedAt: new Date().toISOString(),
    });

    health = await work.healthOf(ownerCtx, owner, successor);
    expect(health.status).toBe('on_track');
    expect(health.signals).toEqual([]);
  });

  it('a blocked predecessor is its own signal', async () => {
    const successor = (await newItem('Ship the mobile flows')).id;
    const stuck = (await newItem('Land the API contract')).id;
    await work.addDependency(ownerCtx, owner, successor, stuck);
    const version = await startWork(stuck);
    await work.transition(ownerCtx, owner, stuck, version, 'blocked', {
      blockerReason: 'Contract review pending',
      blockerAsk: 'Schedule the review',
    });

    const health = await work.healthOf(ownerCtx, owner, successor);
    expect(health.status).toBe('at_risk');
    expect(health.signals[0]?.kind).toBe('predecessor_blocked');
  });

  /**
   * R01 (12 September code review) / F3 (tenant-isolation audit): a predecessor can be linked
   * across projects — only an org-wide principal can make the edge, but access can also be
   * revoked after it exists — and the health signal disclosed the predecessor's title, id and
   * due date to anyone who could read the *dependent* item. Here the dependent item is on the
   * Atlas project, where the designer is a member; the late predecessor is on the Brand
   * Refresh project, where seed-two-tenants deliberately leaves her out (the §11 grid case).
   */
  it('redacts a predecessor in a project the caller cannot read, per caller', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const successor = (
      await work.create(ownerCtx, owner, {
        projectId: world.northstar.projectId,
        title: 'Assemble the Atlas launch kit',
      })
    ).id;
    const hidden = (
      await work.create(ownerCtx, owner, {
        projectId: world.northstar.otherProjectId,
        title: 'CONFIDENTIAL OTHER PROJECT',
        dueAt: yesterday,
      })
    ).id;
    // Only an org-wide principal can link across projects; the owner makes the edge.
    await work.addDependency(ownerCtx, owner, successor, hidden);

    const designerCtx = createTenantContext({
      organizationId: world.northstar.organizationId,
      userId: world.northstar.designer.id,
      membershipId: world.northstar.designer.membershipId,
      principalKind: 'internal',
      capabilities: capabilitiesFor('member'),
      policyVersion: '2026-08-30',
      correlationId: uuidv7(),
    });
    const designer: Principal = {
      userId: world.northstar.designer.id,
      organizationId: world.northstar.organizationId,
      kind: 'internal',
      role: 'member',
      membershipId: world.northstar.designer.membershipId,
      membershipStatus: 'active',
      clientOrganizationId: null,
      projectIds: [world.northstar.projectId],
      hasOrgWideScope: false,
    };

    // The designer can read the dependent item, so she learns it is at risk — but nothing
    // that identifies the blocking work in the project she cannot read.
    const forDesigner = await work.healthOf(designerCtx, designer, successor);
    expect(forDesigner.status).toBe('at_risk');
    expect(forDesigner.signals).toEqual([{ kind: 'predecessor_redacted' }]);
    const serialized = JSON.stringify(forDesigner);
    expect(serialized).not.toContain('CONFIDENTIAL OTHER PROJECT');
    expect(serialized).not.toContain(hidden);
    expect(serialized).not.toContain(yesterday.toISOString());

    // The owner may read both projects, so the same call still names the predecessor in full:
    // the redaction is decided per caller, not stripped from the signal for everyone.
    const forOwner = await work.healthOf(ownerCtx, owner, successor);
    expect(forOwner.signals).toEqual([
      {
        kind: 'predecessor_late',
        workItemId: hidden,
        title: 'CONFIDENTIAL OTHER PROJECT',
        dueAt: yesterday.toISOString(),
      },
    ]);
  });
});
