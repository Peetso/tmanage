import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import {
  WORKER_OUTBOX_HANDLERS,
  createWorkerDatabase,
  runOutboxBatch,
  runOutboxLoop,
} from '@tmanage/worker';
import type { BatchReport, WorkerDatabase } from '@tmanage/worker';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { OutboxEventsRepository } from '../src/modules/platform/outbox-events.repository.js';
import { ProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { ProjectMembershipsRepository } from '../src/modules/projects/project-memberships.repository.js';
import { WorkItemsRepository } from '../src/modules/work/work-items.repository.js';
import { WorkItemsService } from '../src/modules/work/work-items.service.js';
import { ClientRequestsRepository } from '../src/modules/requests/client-requests.repository.js';
import { ClientRequestsService } from '../src/modules/requests/client-requests.service.js';
import { ClientOrganizationsRepository } from '../src/modules/clients/client-organizations.repository.js';
import { ConversationsRepository } from '../src/modules/conversations/conversations.repository.js';
import { ConversationsService } from '../src/modules/conversations/conversations.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PLAT-004 against a real server — the producers, the relay, and the lifecycle rule.
 *
 * The dispatcher is imported from `@tmanage/worker` and driven against the same MariaDB
 * server the rest of the corpus runs on, so what is proved is the relay itself, not a
 * restatement of it. Seven properties only this suite can hold:
 *
 * 1. **Producers write atomically.** Every state-changing command writes its catalog event
 *    in the same transaction, and a rolled-back transaction leaves no event claiming the
 *    change happened — §3 step 8's property, same as the audit suite proves for its rows.
 * 2. **Payloads are reference envelopes.** Ids and states, never bodies — asserted against
 *    the one event whose source has a body a person typed.
 * 3. **A type with no consumer is published, not held.** Dispatched to zero consumers so
 *    the backlog cannot grow without bound.
 * 4. **The lifecycle rule runs.** Work starting moves the accepted request to `planned`;
 *    work done moves it to `delivered` — with a NULL-actor audit row and a
 *    `client_request.transitioned.v1` event of the relay's own, correlation carried
 *    forward from the person who moved the work.
 * 5. **At-least-once redelivery is a no-op.** The same event delivered twice transitions
 *    once — already-there is success, not a duplicate row anywhere.
 * 6. **The rule reads exactly two states.** A declined request stays declined whatever its
 *    work item does.
 * 7. **A poison event backs off exponentially and parks at the cap** — reported in every
 *    batch, never claimed again, never able to starve the claim window.
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
let conversations: ConversationsService;

// Filled by the flow: the request the client filed and the work its acceptance created.
let requestId: string;
let acceptedWorkItemId: string;
let conversationId: string;
let messageId: string;

const OPTIONS = {
  batchSize: 50,
  maxAttempts: 3,
  // One minute base: a failed event's next attempt is always outside this suite's runtime,
  // so a backoff actually keeps it out of the next claim rather than merely usually.
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

interface ObservedEvent {
  readonly id: string;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string | null;
  readonly published: boolean;
  readonly attempts: number;
}

/** Every outbox row for one organization, oldest first, payload parsed either engine's way. */
async function observeEvents(organizationId: string, type?: string): Promise<ObservedEvent[]> {
  const rows = await observe(
    `select id, type, aggregate_type, aggregate_id, payload_json, correlation_id,
            published_at, attempts
       from outbox_events where organization_id = ? ${type ? 'and type = ?' : ''}
      order by id`,
    type ? [organizationId, type] : [organizationId],
  );
  return rows.map((row) => ({
    id: String(row['id']),
    type: String(row['type']),
    aggregateType: String(row['aggregate_type']),
    aggregateId: String(row['aggregate_id']),
    payload:
      typeof row['payload_json'] === 'string'
        ? (JSON.parse(row['payload_json']) as Record<string, unknown>)
        : (row['payload_json'] as Record<string, unknown>),
    correlationId: row['correlation_id'] === null ? null : String(row['correlation_id']),
    published: row['published_at'] !== null,
    attempts: Number(row['attempts']),
  }));
}

async function requestRow(): Promise<{ state: string; version: number }> {
  const rows = await observe(
    'select state, version from client_requests where organization_id = ? and id = ?',
    [world.northstar.organizationId, requestId],
  );
  return { state: String(rows[0]?.['state']), version: Number(rows[0]?.['version']) };
}

/** NULL-actor lifecycle audit rows — the relay's signature in the trail. */
async function systemTransitionAudits(): Promise<RowDataPacket[]> {
  return observe(
    `select object_id, correlation_id, metadata_json from audit_events
      where organization_id = ? and action = 'client_request.transitioned'
        and actor_user_id is null order by id`,
    [world.northstar.organizationId],
  );
}

/** Run batches until the backlog is empty, and hand back the aggregate. */
async function drain(): Promise<{ claimed: number; published: number; unhandled: number }> {
  let claimed = 0;
  let published = 0;
  let unhandled = 0;
  for (;;) {
    const report = await runOutboxBatch(workerDb, WORKER_OUTBOX_HANDLERS, OPTIONS);
    claimed += report.claimed;
    published += report.published;
    unhandled += report.unhandled;
    if (report.claimed === 0) return { claimed, published, unhandled };
  }
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
  conversations = new ConversationsService(
    tenant,
    new ConversationsRepository(),
    audit,
    new ProjectsRepository(),
    new ProjectMembershipsRepository(),
    new WorkItemsRepository(),
    outboxRepo,
  );
});

afterAll(async () => {
  await workerDb?.end();
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// The producers — the writer joins the command's transaction
// ─────────────────────────────────────────────────────────────────────────────

describe('the producers', () => {
  it('a submitted request writes client_request.submitted.v1 with the row', async () => {
    const view = await requests.submit(clientCtx, clientAdmin, {
      projectId: world.northstar.projectId,
      title: 'Add the retail palette to the brand book',
      description: 'The print vendor needs the extended palette before the catalogue run.',
    });
    requestId = view.id;

    const events = await observeEvents(
      world.northstar.organizationId,
      'client_request.submitted.v1',
    );
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.aggregateType).toBe('client_request');
    expect(event.aggregateId).toBe(requestId);
    expect(event.correlationId).toBe(clientCtx.correlationId);
    expect(event.published).toBe(false);
    expect(event.attempts).toBe(0);
    expect(event.payload).toEqual({
      requestId,
      projectId: world.northstar.projectId,
      clientOrganizationId: world.atlas.clientOrganizationId,
      state: 'submitted',
    });
  });

  it('a triage transition writes client_request.transitioned.v1', async () => {
    await requests.triage(ownerCtx, owner, requestId, 1, 'triage');

    const events = await observeEvents(
      world.northstar.organizationId,
      'client_request.transitioned.v1',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      requestId,
      projectId: world.northstar.projectId,
      clientOrganizationId: world.atlas.clientOrganizationId,
      fromStatus: 'submitted',
      toStatus: 'triage',
      requestVersion: 2,
      acceptedWorkItemId: null,
    });
  });

  it('an acceptance writes the same event through its own door', async () => {
    const accepted = await requests.accept(ownerCtx, owner, requestId, 2, {
      clientSafeScopeSummary: 'Extend the palette and reissue the swatch pages.',
      commitment: { kind: 'unscheduled' },
    });
    acceptedWorkItemId = accepted.workItemId;
    expect(accepted.workItemCreated).toBe(true);

    const events = await observeEvents(
      world.northstar.organizationId,
      'client_request.transitioned.v1',
    );
    expect(events).toHaveLength(2);
    expect(events[1]!.payload).toMatchObject({
      fromStatus: 'triage',
      toStatus: 'accepted',
      requestVersion: 3,
      acceptedWorkItemId,
    });
  });

  it('a posted message writes message.created.v1 carrying no body', async () => {
    const channel = await conversations.create(ownerCtx, owner, {
      projectId: world.northstar.projectId,
      name: 'brand-book',
    });
    conversationId = channel.id;

    const body = 'The vendor confirmed the extended palette proofs arrive Thursday';
    const posted = await conversations.postMessage(ownerCtx, owner, conversationId, { body });
    messageId = posted.message.id;

    const events = await observeEvents(world.northstar.organizationId, 'message.created.v1');
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.aggregateType).toBe('conversation');
    expect(event.aggregateId).toBe(conversationId);
    // §5's whole point, asserted at the byte level: the author's words never leave the row.
    expect(JSON.stringify(event.payload)).not.toContain('vendor');
    expect(Object.keys(event.payload).sort()).toEqual([
      // DM live delivery's additive fields: who posted and whom the post mentions, as
      // user ids only. Ids, never anything an author typed.
      'authorUserId',
      'conversationId',
      'mentionedUserIds',
      'messageId',
      'parentMessageId',
      'projectId',
      // RT-001's additive field (§3-compatible): the channel's own order, for gap
      // detection. A number, never anything an author typed.
      'sequenceNo',
    ]);
    expect(event.payload['messageId']).toBe(messageId);
    expect(typeof event.payload['sequenceNo']).toBe('number');
  });

  it('converting a message writes message.converted.v1', async () => {
    const converted = await conversations.convertMessageToWork(
      ownerCtx,
      owner,
      conversationId,
      messageId,
    );
    expect(converted.created).toBe(true);

    const events = await observeEvents(world.northstar.organizationId, 'message.converted.v1');
    expect(events).toHaveLength(1);
    expect(events[0]!.aggregateType).toBe('message');
    expect(events[0]!.payload).toEqual({
      messageId,
      conversationId,
      projectId: world.northstar.projectId,
      workItemId: converted.workItem.id,
      audience: 'internal',
    });
  });

  it('a work item transition writes work_item.updated.v1; a field edit does not', async () => {
    const moved = await work.transition(ownerCtx, owner, acceptedWorkItemId, 1, 'ready');
    expect(moved.state).toBe('ready');

    const events = await observeEvents(world.northstar.organizationId, 'work_item.updated.v1');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      workItemId: acceptedWorkItemId,
      projectId: world.northstar.projectId,
      fromState: 'backlog',
      toState: 'ready',
      workItemVersion: 2,
    });

    await work.update(ownerCtx, owner, acceptedWorkItemId, 2, { title: 'Retail palette pages' });
    expect(
      await observeEvents(world.northstar.organizationId, 'work_item.updated.v1'),
    ).toHaveLength(1);
  });

  it('a rolled-back transaction leaves no event claiming the change happened', async () => {
    const before = (await observeEvents(world.northstar.organizationId)).length;

    await expect(
      tenant.transaction(ownerCtx, async (tx) => {
        await outboxRepo.append(tx, ownerCtx, {
          type: 'work_item.updated.v1',
          aggregateId: acceptedWorkItemId,
          payload: {
            workItemId: acceptedWorkItemId,
            projectId: world.northstar.projectId,
            fromState: 'ready',
            toState: 'in_progress',
            workItemVersion: 99,
          },
        });
        throw new Error('deliberate failure after the append');
      }),
    ).rejects.toThrow('deliberate failure');

    expect(await observeEvents(world.northstar.organizationId)).toHaveLength(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The relay — claiming, publishing, and the lifecycle rule
// ─────────────────────────────────────────────────────────────────────────────

describe('the relay', () => {
  it('publishes the backlog, dispatching consumerless types to zero consumers', async () => {
    const backlog = await observeEvents(world.northstar.organizationId);
    expect(backlog.some((event) => !event.published)).toBe(true);

    const report = await drain();
    expect(report.claimed).toBe(backlog.filter((event) => !event.published).length);
    // Everything so far is either consumerless or a work_item event no rule reads.
    expect(report.published).toBe(report.claimed);
    expect(report.unhandled).toBeGreaterThan(0);

    for (const event of await observeEvents(world.northstar.organizationId)) {
      expect(event.published, event.type).toBe(true);
    }
    // The rule read `ready` and correctly did nothing.
    expect((await requestRow()).state).toBe('accepted');
  });

  it('moves the accepted request to planned when its work starts, as system', async () => {
    // Version 3: create (1), the ready transition (2), the field edit above (3).
    await work.transition(ownerCtx, owner, acceptedWorkItemId, 3, 'in_progress');
    const report = await runOutboxBatch(workerDb, WORKER_OUTBOX_HANDLERS, OPTIONS);
    expect(report.claimed).toBe(1);
    expect(report.published).toBe(1);
    expect(report.failed).toBe(0);

    expect(await requestRow()).toEqual({ state: 'planned', version: 4 });

    // The relay's own audit row: system-initiated, so no actor — and the correlation is
    // the one the person who moved the work carried, so the chain answers to one id.
    const audits = await systemTransitionAudits();
    expect(audits).toHaveLength(1);
    expect(String(audits[0]!['object_id'])).toBe(requestId);
    expect(String(audits[0]!['correlation_id'])).toBe(ownerCtx.correlationId);

    // And the relay's own outbox event, announcing the automatic transition like any other.
    const transitioned = await observeEvents(
      world.northstar.organizationId,
      'client_request.transitioned.v1',
    );
    const planned = transitioned.filter((event) => event.payload['toStatus'] === 'planned');
    expect(planned).toHaveLength(1);
    expect(planned[0]!.payload).toEqual({
      requestId,
      projectId: world.northstar.projectId,
      clientOrganizationId: world.atlas.clientOrganizationId,
      fromStatus: 'accepted',
      toStatus: 'planned',
      requestVersion: 4,
      acceptedWorkItemId,
    });
    expect(planned[0]!.correlationId).toBe(ownerCtx.correlationId);

    // The announcement is itself consumed — since NOTIF-001, a transitioned event has a
    // notification consumer — and the next batch delivers it without failures.
    const followUp = await runOutboxBatch(workerDb, WORKER_OUTBOX_HANDLERS, OPTIONS);
    expect(followUp.claimed).toBe(1);
    expect(followUp.published).toBe(1);
    expect(followUp.failed).toBe(0);
  });

  it('treats redelivery as success: one transition however many deliveries', async () => {
    const events = await observeEvents(world.northstar.organizationId, 'work_item.updated.v1');
    const trigger = events.find((event) => event.payload['toState'] === 'in_progress');
    expect(trigger).toBeDefined();

    // At-least-once, forced: un-publish the delivered event and let the relay find it again.
    await db.admin.execute(
      `update outbox_events set published_at = null,
              available_at = date_sub(utc_timestamp(3), interval 1 second) where id = ?`,
      [trigger!.id],
    );

    const report = await runOutboxBatch(workerDb, WORKER_OUTBOX_HANDLERS, OPTIONS);
    expect(report.claimed).toBe(1);
    expect(report.published).toBe(1);
    expect(report.failed).toBe(0);

    // Nothing moved, nothing was written twice. Already-there is success.
    expect(await requestRow()).toEqual({ state: 'planned', version: 4 });
    expect(await systemTransitionAudits()).toHaveLength(1);
    const transitioned = await observeEvents(
      world.northstar.organizationId,
      'client_request.transitioned.v1',
    );
    expect(transitioned.filter((event) => event.payload['toStatus'] === 'planned')).toHaveLength(1);
  });

  it('moves the planned request to delivered when the work is done', async () => {
    await work.transition(ownerCtx, owner, acceptedWorkItemId, 4, 'internal_review');
    await work.transition(ownerCtx, owner, acceptedWorkItemId, 5, 'done', {
      ownerId: world.northstar.owner.id,
      completedAt: new Date().toISOString(),
    });

    const report = await drain();
    expect(report.claimed).toBeGreaterThanOrEqual(2);

    expect(await requestRow()).toEqual({ state: 'delivered', version: 5 });
    expect(await systemTransitionAudits()).toHaveLength(2);

    const transitioned = await observeEvents(
      world.northstar.organizationId,
      'client_request.transitioned.v1',
    );
    const delivered = transitioned.filter((event) => event.payload['toStatus'] === 'delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload).toMatchObject({ fromStatus: 'planned', requestVersion: 5 });
  });

  it('leaves a request in any other state alone', async () => {
    // A declined request whose work item somebody later reuses. The rule reads two states
    // and this is neither, so nothing may move — least of all a resurrection.
    const otherWork = await work.create(ownerCtx, owner, {
      projectId: world.northstar.projectId,
      title: 'Archive the superseded swatch pages',
    });
    const declinedId = uuidv7();
    await db.admin.execute(
      `insert into client_requests
         (id, organization_id, project_id, client_organization_id, submitted_by_user_id,
          title, description, state, client_visible_reason, linked_work_item_id, version,
          created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, 'declined', 'Out of scope for this engagement',
               ?, 2, utc_timestamp(3), utc_timestamp(3))`,
      [
        declinedId,
        world.northstar.organizationId,
        world.northstar.projectId,
        world.atlas.clientOrganizationId,
        world.atlas.admin.id,
        'Rebuild the archive site',
        'Declined during triage; the work item was later reused for internal cleanup.',
        otherWork.id,
      ],
    );

    await work.transition(ownerCtx, owner, otherWork.id, 1, 'ready');
    await work.transition(ownerCtx, owner, otherWork.id, 2, 'in_progress');
    await drain();

    const rows = await observe(
      'select state from client_requests where organization_id = ? and id = ?',
      [world.northstar.organizationId, declinedId],
    );
    expect(String(rows[0]?.['state'])).toBe('declined');
    // Still exactly the two lifecycle audits from the real flow — the rule wrote nothing.
    expect(await systemTransitionAudits()).toHaveLength(2);
  });

  it('runs as a loop that is the batch repeated, stopping on abort', async () => {
    await db.admin.execute(
      `insert into outbox_events
         (id, organization_id, type, schema_version, aggregate_type, aggregate_id,
          payload_json, occurred_at, available_at)
       values (?, ?, 'message.created.v1', 1, 'conversation', ?, '{}', utc_timestamp(3), utc_timestamp(3))`,
      [uuidv7(), world.northstar.organizationId, conversationId],
    );

    const controller = new AbortController();
    const reports: BatchReport[] = [];
    await runOutboxLoop(workerDb, WORKER_OUTBOX_HANDLERS, {
      ...OPTIONS,
      pollIntervalMs: 10,
      signal: controller.signal,
      onBatch: (report) => {
        reports.push(report);
        if (report.claimed > 0) controller.abort();
      },
    });

    expect(reports.some((report) => report.claimed === 1 && report.published === 1)).toBe(true);
  });

  it('backs a poison event off exponentially and parks it at the cap', async () => {
    const poisonId = uuidv7();
    await db.admin.execute(
      `insert into outbox_events
         (id, organization_id, type, schema_version, aggregate_type, aggregate_id,
          payload_json, occurred_at, available_at)
       values (?, ?, 'work_item.updated.v1', 1, 'work_item', ?, '{}', utc_timestamp(3),
               date_sub(utc_timestamp(3), interval 1 second))`,
      [poisonId, world.northstar.organizationId, uuidv7()],
    );

    const poison = async (): Promise<RowDataPacket> => {
      const rows = await observe(
        `select attempts, last_error, published_at,
                (available_at > utc_timestamp(3)) as backed_off
           from outbox_events where id = ?`,
        [poisonId],
      );
      return rows[0]!;
    };
    const makeDue = () =>
      db.admin.execute(
        `update outbox_events set available_at = date_sub(utc_timestamp(3), interval 1 second)
          where id = ?`,
        [poisonId],
      );

    // First failure: counted, diagnosed, backed off — and therefore not reclaimed.
    const first = await runOutboxBatch(workerDb, WORKER_OUTBOX_HANDLERS, OPTIONS);
    expect(first.failed).toBe(1);
    expect(first.failures[0]).toMatchObject({ eventId: poisonId, attempts: 1 });
    let row = await poison();
    expect(Number(row['attempts'])).toBe(1);
    expect(String(row['last_error'])).toContain('no readable workItemId');
    expect(Number(row['backed_off'])).toBe(1);
    expect((await runOutboxBatch(workerDb, WORKER_OUTBOX_HANDLERS, OPTIONS)).claimed).toBe(0);

    // Second and third failures — the third reaches the cap and parks.
    await makeDue();
    expect((await runOutboxBatch(workerDb, WORKER_OUTBOX_HANDLERS, OPTIONS)).failed).toBe(1);
    await makeDue();
    const capping = await runOutboxBatch(workerDb, WORKER_OUTBOX_HANDLERS, OPTIONS);
    expect(capping.failed).toBe(1);
    expect(capping.failures[0]!.attempts).toBe(OPTIONS.maxAttempts);
    expect(capping.parked.map((event) => event.id)).toContain(poisonId);

    // Parked: due, unpublished, and still never claimed — but reported, every batch.
    await makeDue();
    const after = await runOutboxBatch(workerDb, WORKER_OUTBOX_HANDLERS, OPTIONS);
    expect(after.claimed).toBe(0);
    expect(after.parked.map((event) => event.id)).toContain(poisonId);
    row = await poison();
    expect(Number(row['attempts'])).toBe(OPTIONS.maxAttempts);
    expect(row['published_at']).toBeNull();
  });
});
