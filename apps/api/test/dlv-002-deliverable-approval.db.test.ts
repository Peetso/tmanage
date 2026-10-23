import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import { createWorkerDatabase, createWorkerOutboxHandlers, runOutboxBatch } from '@tmanage/worker';
import type { OutboxHandlers, WorkerDatabase } from '@tmanage/worker';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { ApiError } from '../src/common/http/errors.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { OutboxEventsRepository } from '../src/modules/platform/outbox-events.repository.js';
import { ProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { ApprovalsRepository } from '../src/modules/approvals/approvals.repository.js';
import { DeliverableVersionsRepository } from '../src/modules/approvals/deliverable-versions.repository.js';
import { ClientProjectionsRepository } from '../src/modules/approvals/client-projections.repository.js';
import { DeliverablesRepository } from '../src/modules/approvals/deliverables.repository.js';
import { DeliverablesService } from '../src/modules/approvals/deliverables.service.js';
import { ApprovalsService } from '../src/modules/approvals/approvals.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * BG2 (0211) + Q3 over a real server — the whole studio→client approval chain.
 *
 * `deliverables.service.test.ts` and `approvals.service.test.ts` prove the decisions over fakes.
 * Only this suite proves, against MariaDB and the runtime credential, that a deliverable created
 * through the scoped `TenantDatabase` takes versions, is sent (projection + approval + outbox +
 * audit in one transaction), that only the client organization the project is shared with can see
 * and decide it, that a decision happens once, and that the worker turns the events into team and
 * approver notifications. The adversarial twin and the second client (Meridian) prove isolation.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let workerDb: WorkerDatabase;
let handlers: OutboxHandlers;
let deliverables: DeliverablesService;
let approvals: ApprovalsService;

let managerCtx: TenantContext;
let designerCtx: TenantContext;
let twinCtx: TenantContext;
let reviewerCtx: TenantContext;
let adminCtx: TenantContext;
let viewerCtx: TenantContext;
let meridianCtx: TenantContext;

const OPTIONS = { batchSize: 50, maxAttempts: 3, backoffBaseMs: 60_000, backoffCapMs: 900_000 };

function contextFor(
  organizationId: string,
  userId: string,
  membershipId: string,
  kind: 'internal' | 'client',
  role: Role,
): TenantContext {
  return createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: kind,
    capabilities: capabilitiesFor(role),
    policyVersion: '2026-10-23',
    correlationId: uuidv7(),
  });
}

function internal(
  context: TenantContext,
  role: Role,
  projectIds: readonly string[],
  hasOrgWideScope: boolean,
): Principal {
  return {
    userId: context.userId,
    organizationId: context.organizationId,
    kind: 'internal',
    role,
    membershipId: context.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope,
  };
}

function client(
  context: TenantContext,
  role: Role,
  clientOrganizationId: string,
  projectIds: readonly string[],
): Principal {
  return {
    userId: context.userId,
    organizationId: context.organizationId,
    kind: 'client',
    role,
    membershipId: context.membershipId,
    membershipStatus: 'active',
    clientOrganizationId,
    projectIds,
    hasOrgWideScope: false,
  };
}

const manager = (): Principal =>
  internal(managerCtx, 'manager', [world.northstar.projectId], false);
const designer = (): Principal =>
  internal(designerCtx, 'member', [world.northstar.projectId], false);
const twinOwner = (): Principal => internal(twinCtx, 'owner', [], true);
const atlasReviewer = (): Principal =>
  client(reviewerCtx, 'client_reviewer', world.atlas.clientOrganizationId, [
    world.northstar.projectId,
  ]);
const atlasAdmin = (): Principal =>
  client(adminCtx, 'client_admin', world.atlas.clientOrganizationId, [world.northstar.projectId]);
const atlasViewer = (): Principal =>
  client(viewerCtx, 'client_viewer', world.atlas.clientOrganizationId, [world.northstar.projectId]);
const meridianReviewer = (): Principal =>
  client(meridianCtx, 'client_reviewer', world.meridian.clientOrganizationId, [
    world.meridian.projectId,
  ]);

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function auditRows(objectId: string, action: string): Promise<RowDataPacket[]> {
  return observe(
    `select organization_id, actor_user_id, object_type, result, metadata_json
       from audit_events where object_id = ? and action = ?`,
    [objectId, action],
  );
}

async function outboxRows(aggregateId: string, type: string): Promise<RowDataPacket[]> {
  return observe(
    'select organization_id, payload_json from outbox_events where aggregate_id = ? and type = ?',
    [aggregateId, type],
  );
}

function json(value: unknown): Record<string, unknown> {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const caught = await promise.then(
    () => {
      throw new Error('the call resolved — it must reject');
    },
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(ApiError);
  return caught as ApiError;
}

async function drain(): Promise<void> {
  for (;;) {
    const report = await runOutboxBatch(workerDb, handlers, OPTIONS);
    expect(report.failed, JSON.stringify(report.failures)).toBe(0);
    if (report.claimed === 0) return;
  }
}

/** A deliverable with one note-only version, sent to the Atlas reviewer. */
async function sentDeliverable(title: string) {
  const created = await deliverables.create(managerCtx, manager(), {
    projectId: world.northstar.projectId,
    title,
    description: 'Created by the dlv-002 suite.',
  });
  const version = await deliverables.addVersion(managerCtx, manager(), created.id, {
    fileAssetId: null,
    note: 'First cut of the hero.',
  });
  const sent = await deliverables.send(managerCtx, manager(), created.id, version.id, {
    approverIds: [world.atlas.reviewer.id],
    dueDate: '2026-11-05',
    checkNote: 'Check the booking button copy.',
    notify: true,
  });
  return { deliverableId: created.id, versionId: version.id, approvalId: sent.approvalId, sent };
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 2, statementTimeoutMs: 15_000 });
  handlers = createWorkerOutboxHandlers({});

  const ns = world.northstar;
  managerCtx = contextFor(
    ns.organizationId,
    ns.manager.id,
    ns.manager.membershipId,
    'internal',
    'manager',
  );
  designerCtx = contextFor(
    ns.organizationId,
    ns.designer.id,
    ns.designer.membershipId,
    'internal',
    'member',
  );
  twinCtx = contextFor(
    world.twin.organizationId,
    world.twin.owner.id,
    world.twin.owner.membershipId,
    'internal',
    'owner',
  );
  reviewerCtx = contextFor(
    ns.organizationId,
    world.atlas.reviewer.id,
    world.atlas.reviewer.membershipId,
    'client',
    'client_reviewer',
  );
  adminCtx = contextFor(
    ns.organizationId,
    world.atlas.admin.id,
    world.atlas.admin.membershipId,
    'client',
    'client_admin',
  );
  viewerCtx = contextFor(
    ns.organizationId,
    world.atlas.viewer.id,
    world.atlas.viewer.membershipId,
    'client',
    'client_viewer',
  );
  meridianCtx = contextFor(
    ns.organizationId,
    world.meridian.reviewer.id,
    world.meridian.reviewer.membershipId,
    'client',
    'client_reviewer',
  );

  const audit = new AuditService(tenant, new AuditEventsRepository());
  const outbox = new OutboxEventsRepository();
  deliverables = new DeliverablesService(
    tenant,
    new DeliverablesRepository(),
    new DeliverableVersionsRepository(),
    new ApprovalsRepository(),
    new ClientProjectionsRepository(),
    new ProjectsRepository(),
    outbox,
    audit,
  );
  approvals = new ApprovalsService(
    tenant,
    new ApprovalsRepository(),
    new DeliverableVersionsRepository(),
    new ClientProjectionsRepository(),
    outbox,
    audit,
  );
});

afterAll(async () => {
  await workerDb?.end();
  await db?.stop();
});

describe('deliverables, versions and send for client approval (BG2)', () => {
  it('creates, versions and sends atomically: projection, approval, outbox and audit rows', async () => {
    const { deliverableId, versionId, approvalId, sent } = await sentDeliverable('Hero concept');
    expect(sent.state).toBe('requested');
    expect(sent.reviewerIds).toEqual([world.atlas.reviewer.id]);

    const detail = await deliverables.detail(managerCtx, manager(), deliverableId);
    expect(detail.state).toBe('in_review');
    expect(detail.latestVersionNo).toBe(1);
    expect(detail.versions[0]?.approval?.id).toBe(approvalId);

    const projection = await observe(
      'select organization_id from client_projections where deliverable_version_id = ?',
      [versionId],
    );
    expect(projection).toHaveLength(1);
    expect(projection[0]?.['organization_id']).toBe(world.northstar.organizationId);

    const requested = await outboxRows(approvalId, 'approval.requested.v1');
    expect(requested).toHaveLength(1);
    expect(json(requested[0]?.['payload_json'])['reviewerUserIds']).toEqual([
      world.atlas.reviewer.id,
    ]);

    for (const action of [
      'deliverable.created',
      'deliverable.version_added',
      'deliverable.sent_for_approval',
    ]) {
      const rows = await auditRows(deliverableId, action);
      expect(rows, action).toHaveLength(1);
      expect(rows[0]?.['organization_id']).toBe(world.northstar.organizationId);
      expect(rows[0]?.['actor_user_id']).toBe(world.northstar.manager.id);
      expect(rows[0]?.['result']).toBe('allowed');
    }
    const sentAudit = json(
      (await auditRows(deliverableId, 'deliverable.sent_for_approval'))[0]?.['metadata_json'],
    );
    expect(sentAudit['approval_id']).toBe(approvalId);
  });

  it('numbers versions and invalidates a pending approval when a new version lands', async () => {
    const { deliverableId, approvalId } = await sentDeliverable('Menu layout');
    const v2 = await deliverables.addVersion(managerCtx, manager(), deliverableId, {
      fileAssetId: null,
      note: 'Second cut.',
    });
    expect(v2.versionNo).toBe(2);

    const rows = await observe('select state, invalidation_reason from approvals where id = ?', [
      approvalId,
    ]);
    expect(rows[0]?.['state']).toBe('invalidated');
    expect(await auditRows(approvalId, 'approval.invalidated')).toHaveLength(1);
    expect((await deliverables.detail(managerCtx, manager(), deliverableId)).state).toBe('draft');
  });

  it('refuses a second send of a pending version, and approvers outside the shared client org', async () => {
    const { deliverableId, versionId } = await sentDeliverable('Gallery strip');
    const again = await rejection(
      deliverables.send(managerCtx, manager(), deliverableId, versionId, {
        approverIds: [world.atlas.reviewer.id],
        dueDate: null,
        checkNote: null,
        notify: false,
      }),
    );
    expect(again.status).toBe(409);
    expect(again.auditCode).toBe('approval_pending');

    const fresh = await deliverables.create(managerCtx, manager(), {
      projectId: world.northstar.projectId,
      title: 'Footer links',
      description: null,
    });
    const v1 = await deliverables.addVersion(managerCtx, manager(), fresh.id, {
      fileAssetId: null,
      note: 'Footer v1.',
    });
    // The approver picker lists only Atlas people who may decide — never the viewer or Meridian.
    const picker = (await deliverables.approvers(managerCtx, manager(), fresh.id)).map(
      (p) => p.userId,
    );
    expect(picker.sort()).toEqual([world.atlas.admin.id, world.atlas.reviewer.id].sort());

    for (const outsider of [world.meridian.reviewer.id, world.atlas.viewer.id]) {
      const refused = await rejection(
        deliverables.send(managerCtx, manager(), fresh.id, v1.id, {
          approverIds: [outsider],
          dueDate: null,
          checkNote: null,
          notify: false,
        }),
      );
      expect(refused.status).toBe(422);
    }
    expect(
      await observe('select id from approvals where deliverable_version_id = ?', [v1.id]),
    ).toHaveLength(0);
  });

  it('refuses a member without deliverable.publish to send (404, nothing written)', async () => {
    const fresh = await deliverables.create(managerCtx, manager(), {
      projectId: world.northstar.projectId,
      title: 'Room cards',
      description: null,
    });
    const v1 = await deliverables.addVersion(designerCtx, designer(), fresh.id, {
      fileAssetId: null,
      note: 'Designer upload.',
    });
    const refused = await rejection(
      deliverables.send(designerCtx, designer(), fresh.id, v1.id, {
        approverIds: [world.atlas.reviewer.id],
        dueDate: null,
        checkNote: null,
        notify: true,
      }),
    );
    expect(refused.status).toBe(404);
    expect(
      await observe('select id from approvals where deliverable_version_id = ?', [v1.id]),
    ).toHaveLength(0);
    expect(await auditRows(fresh.id, 'deliverable.sent_for_approval')).toHaveLength(0);
  });
});

describe('tenant isolation', () => {
  it('never resolves a deliverable for the adversarial twin, and writes nothing', async () => {
    const { deliverableId, versionId } = await sentDeliverable('Twin probe');
    const before = await observe(
      'select count(*) as n from deliverable_versions where deliverable_id = ?',
      [deliverableId],
    );

    const read = await rejection(deliverables.detail(twinCtx, twinOwner(), deliverableId));
    expect(read.status).toBe(404);
    expect(read.auditCode).toBe('deliverable_not_found');

    const upload = await rejection(
      deliverables.addVersion(twinCtx, twinOwner(), deliverableId, {
        fileAssetId: null,
        note: 'x',
      }),
    );
    expect(upload.status).toBe(404);

    const send = await rejection(
      deliverables.send(twinCtx, twinOwner(), deliverableId, versionId, {
        approverIds: [world.twin.owner.id],
        dueDate: null,
        checkNote: null,
        notify: false,
      }),
    );
    expect(send.status).toBe(404);

    expect(await deliverables.list(twinCtx, twinOwner(), world.northstar.projectId)).toEqual([]);

    const after = await observe(
      'select count(*) as n from deliverable_versions where deliverable_id = ?',
      [deliverableId],
    );
    expect(after[0]?.['n']).toBe(before[0]?.['n']);
    const twinAudit = await observe(
      "select count(*) as n from audit_events where organization_id = ? and action like 'deliverable.%'",
      [world.twin.organizationId],
    );
    expect(Number(twinAudit[0]?.['n'])).toBe(0);
  });
});

describe('the client sees only what was shared with it', () => {
  it('the shared client reads the sent version; an unsent version stays invisible', async () => {
    const { deliverableId, versionId } = await sentDeliverable('Shared hero');
    const view = await approvals.readProjection(reviewerCtx, atlasReviewer(), versionId);
    expect(view.projection.title).toBe('Shared hero · v1');
    expect(view.projection.summary).toBe('Check the booking button copy.');

    const v2 = await deliverables.addVersion(managerCtx, manager(), deliverableId, {
      fileAssetId: null,
      note: 'Unsent v2.',
    });
    const hidden = await rejection(approvals.readProjection(reviewerCtx, atlasReviewer(), v2.id));
    expect(hidden.status).toBe(404);
    const undecidable = await rejection(
      approvals.clientDecide(reviewerCtx, atlasReviewer(), v2.id, { decision: 'approve' }),
    );
    expect(undecidable.status).toBe(404);
  });

  it('a client never reads the internal deliverable record', async () => {
    const { deliverableId } = await sentDeliverable('Internal record');
    const refused = await rejection(
      deliverables.detail(reviewerCtx, atlasReviewer(), deliverableId),
    );
    expect(refused.status).toBe(404);
  });

  it('another client of the same studio can neither read nor decide it', async () => {
    const { versionId, approvalId } = await sentDeliverable('Meridian probe');
    expect(
      (await rejection(approvals.readProjection(meridianCtx, meridianReviewer(), versionId)))
        .status,
    ).toBe(404);
    const decide = await rejection(
      approvals.clientDecide(meridianCtx, meridianReviewer(), versionId, { decision: 'approve' }),
    );
    expect(decide.status).toBe(404);
    const rows = await observe('select state, decided_by_user_id from approvals where id = ?', [
      approvalId,
    ]);
    expect(rows[0]?.['state']).toBe('requested');
    expect(rows[0]?.['decided_by_user_id']).toBeNull();
  });

  it('a client viewer of the shared org may read but not decide', async () => {
    const { versionId, approvalId } = await sentDeliverable('Viewer probe');
    await approvals.readProjection(viewerCtx, atlasViewer(), versionId);
    const decide = await rejection(
      approvals.clientDecide(viewerCtx, atlasViewer(), versionId, { decision: 'approve' }),
    );
    expect(decide.status).toBe(404);
    const rows = await observe('select state from approvals where id = ?', [approvalId]);
    expect(rows[0]?.['state']).toBe('requested');
  });
});

describe('client decision, once, with team notification and audit (Q3)', () => {
  it('approves once; a second decision is 409 and leaves one event and one audit row', async () => {
    const { deliverableId, versionId, approvalId } = await sentDeliverable('Decide once');
    const decided = await approvals.clientDecide(reviewerCtx, atlasReviewer(), versionId, {
      decision: 'approve',
    });
    expect(decided.state).toBe('approved');

    const again = await rejection(
      approvals.clientDecide(adminCtx, atlasAdmin(), versionId, {
        decision: 'request_changes',
        feedback: 'Too late to change my mind.',
      }),
    );
    expect(again.status).toBe(409);
    expect(again.auditCode).toBe('approval_terminal');

    const row = await observe('select state, decided_by_user_id from approvals where id = ?', [
      approvalId,
    ]);
    expect(row[0]?.['state']).toBe('approved');
    expect(row[0]?.['decided_by_user_id']).toBe(world.atlas.reviewer.id);
    expect((await deliverables.detail(managerCtx, manager(), deliverableId)).state).toBe(
      'approved',
    );

    const events = await outboxRows(approvalId, 'approval.decided.v1');
    expect(events).toHaveLength(1);
    const payload = json(events[0]?.['payload_json']);
    expect(payload['decision']).toBe('approved');
    expect(payload['decidedByUserId']).toBe(world.atlas.reviewer.id);
    expect(payload['requestedByUserId']).toBe(world.northstar.manager.id);

    const audit = await auditRows(approvalId, 'approval.approved');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.['actor_user_id']).toBe(world.atlas.reviewer.id);
    expect(audit[0]?.['organization_id']).toBe(world.northstar.organizationId);
    expect(await auditRows(approvalId, 'approval.changes_requested')).toHaveLength(0);
  });

  it('records requested changes without copying the feedback into the event or audit', async () => {
    const { versionId, approvalId } = await sentDeliverable('Changes please');
    const feedback = 'Make the booking button larger and green.';
    const decided = await approvals.clientDecide(reviewerCtx, atlasReviewer(), versionId, {
      decision: 'request_changes',
      feedback,
    });
    expect(decided.state).toBe('changes_requested');
    expect(decided.feedback).toBe(feedback);

    const events = await outboxRows(approvalId, 'approval.decided.v1');
    expect(events).toHaveLength(1);
    expect(JSON.stringify(json(events[0]?.['payload_json']))).not.toContain('green');
    const audit = await auditRows(approvalId, 'approval.changes_requested');
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(json(audit[0]?.['metadata_json']))).not.toContain('green');
  });

  it('the worker tells the picked approver on send and the team, never a client, on the decision', async () => {
    const { versionId, approvalId } = await sentDeliverable('Notify the team');
    await approvals.clientDecide(reviewerCtx, atlasReviewer(), versionId, { decision: 'approve' });
    await drain();

    const requested = await observe(
      'select organization_id, recipient_user_id from notifications where dedupe_key = ?',
      [`approval.requested:${approvalId}`],
    );
    expect(requested.map((r) => r['recipient_user_id'])).toEqual([world.atlas.reviewer.id]);

    const decided = await observe(
      'select organization_id, recipient_user_id from notifications where dedupe_key = ?',
      [`approval.decided:${approvalId}`],
    );
    const recipients = decided.map((r) => String(r['recipient_user_id']));
    expect(recipients).toContain(world.northstar.manager.id);
    for (const r of decided) expect(r['organization_id']).toBe(world.northstar.organizationId);
    for (const clientUser of [
      world.atlas.reviewer.id,
      world.atlas.admin.id,
      world.atlas.viewer.id,
      world.meridian.reviewer.id,
      world.twin.owner.id,
    ]) {
      expect(recipients).not.toContain(clientUser);
    }
  });
});
