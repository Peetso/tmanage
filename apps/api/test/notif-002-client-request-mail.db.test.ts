import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import type { MailDelivery, Mailer, MailMessage } from '@tmanage/mail';
import {
  ClientRequestMailer,
  createWorkerDatabase,
  createWorkerOutboxHandlers,
  runOutboxBatch,
} from '@tmanage/worker';
import type { OutboxHandlers, WorkerDatabase } from '@tmanage/worker';
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
 * The relay's mail producer against a real server — the narrow client-request cut.
 *
 * `client-request-email.test.ts` proves the words and `effects.test.ts` proves the
 * after-commit rules over a fake. What only this suite can prove:
 *
 * 1. **The whole path runs.** A client submits through the real service, the real outbox row
 *    is written in that transaction, the real dispatcher claims it, and a real transport
 *    receives a message addressed to the real `users.email` of the person who asked.
 * 2. **The send happens after the batch commits.** The transport asserts, at send time, that
 *    the event it belongs to already carries `published_at` — the one ordering claim the
 *    ticket exists to make, checked against the row rather than against a log.
 * 3. **`24-EVENT-CATALOG` §6 holds for mail too.** A client membership suspended between the
 *    event and its delivery produces no message. An email has no display time at which access
 *    can be re-checked, so this is the only check there will ever be.
 * 4. **Only the three templates §3 writes are sent.** `deferred` and `declined` notify in-app
 *    and mail nobody, and `withdrawn` does neither.
 * 5. **The mail half never costs the notification half.** With no transport wired the
 *    notifications are identical, and a transport that throws leaves every notification row
 *    and every `published_at` exactly where a successful send leaves them.
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

const OPTIONS = { batchSize: 50, maxAttempts: 3, backoffBaseMs: 60_000, backoffCapMs: 900_000 };
const WEB_PUBLIC_URL = 'https://app.tmanage.test';

/**
 * A transport that records what it was handed, and — the point of the suite — checks the
 * database at the moment of the send. If an event were still unpublished then, the handler
 * would be inside the batch transaction, which is the whole thing this ticket forbids.
 */
class ObservingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  readonly unpublishedAtSendTime: number[] = [];
  fail = false;

  constructor(private readonly countUnpublished: () => Promise<number>) {}

  async send(message: MailMessage): Promise<MailDelivery> {
    this.unpublishedAtSendTime.push(await this.countUnpublished());
    if (this.fail) throw new Error('smtp refused the message');
    this.sent.push(message);
    return 'sent';
  }
}

let transport: ObservingMailer;
let handlers: OutboxHandlers;

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
    policyVersion: '2026-08-31',
    correlationId: uuidv7(),
  });

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function unpublishedCount(): Promise<number> {
  const rows = await observe(
    'select count(*) as n from outbox_events where organization_id = ? and published_at is null',
    [world.northstar.organizationId],
  );
  return Number(rows[0]?.['n']);
}

async function drain(with_: OutboxHandlers = handlers): Promise<void> {
  for (;;) {
    const report = await runOutboxBatch(workerDb, with_, OPTIONS);
    expect(report.failed, JSON.stringify(report.failures)).toBe(0);
    if (report.claimed === 0) return;
  }
}

async function notificationCount(requestId: string): Promise<number> {
  const rows = await observe(
    'select count(*) as n from notifications where organization_id = ? and object_id = ?',
    [world.northstar.organizationId, requestId],
  );
  return Number(rows[0]?.['n']);
}

/**
 * Only the rows addressed to the client who submitted. A *submission* notifies the internal
 * triage-capable people, so a plain count on the object is never zero and proves nothing about
 * what the client was or was not told.
 */
async function clientNotificationCount(requestId: string): Promise<number> {
  const rows = await observe(
    `select count(*) as n from notifications
      where organization_id = ? and object_id = ? and recipient_user_id = ?`,
    [world.northstar.organizationId, requestId, world.atlas.admin.id],
  );
  return Number(rows[0]?.['n']);
}

async function submitRequest(title: string, desiredAt?: string): Promise<string> {
  const view = await requests.submit(clientCtx, clientAdmin, {
    projectId: world.northstar.projectId,
    title,
    description: 'Filed by the mail suite.',
    ...(desiredAt === undefined ? {} : { desiredAt }),
  });
  return view.id;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 2, statementTimeoutMs: 15_000 });

  transport = new ObservingMailer(unpublishedCount);
  handlers = createWorkerOutboxHandlers({
    clientRequestMailer: new ClientRequestMailer(transport, WEB_PUBLIC_URL),
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

beforeEach(() => {
  transport.sent.length = 0;
  transport.unpublishedAtSendTime.length = 0;
  transport.fail = false;
});

afterAll(async () => {
  await workerDb?.end();
  await db?.stop();
});

describe('a submitted request mails the client who submitted it', () => {
  it('reaches their real address, with §3’s subject and the portal link', async () => {
    const requestId = await submitRequest('Extend the loyalty desk hours', '2026-11-02');
    await drain();

    expect(transport.sent).toHaveLength(1);
    const message = transport.sent[0];
    expect(message?.to).toBe(world.atlas.admin.email);
    expect(message?.subject).toBe('Request received: Extend the loyalty desk hours');
    expect(message?.text).toContain('We received your request for Atlas Website Relaunch.');
    expect(message?.text).toContain('2026-11-02 is a requested date, not a confirmed commitment');
    expect(message?.text).toContain(
      `${WEB_PUBLIC_URL}/northstar-studio/portal/requests/${requestId}`,
    );

    // The ordering the ticket exists for, counted inside `send` against the real table: zero
    // unpublished events in this tenant means the batch had already committed when the
    // transport was called. A handler sending inline would see its own event still unpublished.
    expect(transport.unpublishedAtSendTime).toEqual([0]);
  });

  it('addresses only this tenant\u2019s client, and never names the adversarial twin', async () => {
    // The twin exists to be confusable: same project name, an owner whose address differs
    // from Northstar's by one character. So the assertion is about the *message*, not about
    // the twin's row count — which would be true of the seed before any handler ran.
    const twin = await observe('select slug, name from organizations where id = ?', [
      world.twin.organizationId,
    ]);
    const twinSlug = String(twin[0]?.['slug']);
    const twinName = String(twin[0]?.['name']);

    await submitRequest('Re-cut the autumn teaser');
    await drain();

    expect(transport.sent.length).toBeGreaterThan(0);
    for (const message of transport.sent) {
      expect(message.to).toBe(world.atlas.admin.email);
      expect(message.to).not.toBe(world.twin.owner.email);
      expect(message.text).not.toContain(twinSlug);
      expect(message.text).not.toContain(twinName);
      expect(message.text).toContain(`/${'northstar-studio'}/portal/requests/`);
    }

    // And the twin still produced no event of its own, so nothing about it could have been
    // claimed at all.
    const rows = await observe(
      'select count(*) as n from outbox_events where organization_id = ?',
      [world.twin.organizationId],
    );
    expect(Number(rows[0]?.['n'])).toBe(0);
  });
});

describe('the two transitions §3 writes copy for, and the ones it does not', () => {
  let requestId: string;

  it('mails the clarification the moment a manager asks one', async () => {
    requestId = await submitRequest('Rework the booking confirmation copy');
    await drain();
    transport.sent.length = 0;

    // §6 routes every request through `triage` first; there is no arrow from `submitted`.
    await requests.triage(ownerCtx, owner, requestId, 1, 'triage');
    await requests.triage(ownerCtx, owner, requestId, 2, 'needs_clarification', {
      clarificationQuestion: 'Which locale should the confirmation be written for?',
    });
    await drain();

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.subject).toBe(
      'Your input is needed for Rework the booking confirmation copy',
    );
    // The question is prose a manager wrote. It is on the row and in the portal, never here.
    expect(transport.sent[0]?.text).not.toContain('Which locale');
  });

  it('mails the acceptance with the client-safe summary and the committed date', async () => {
    await requests.triage(ownerCtx, owner, requestId, 3, 'triage');
    await drain();
    transport.sent.length = 0;

    await requests.accept(ownerCtx, owner, requestId, 4, {
      clientSafeScopeSummary: 'New confirmation copy, one round of revisions.',
      commitment: { kind: 'committed', day: '2026-12-04' },
      work: { title: 'Rewrite booking confirmation copy' },
    });
    await drain();

    const accepted = transport.sent.filter((message) =>
      message.subject.startsWith('Request accepted:'),
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.text).toContain(
      'Committed outcome: New confirmation copy, one round of revisions.',
    );
    // The DATE round-trips as the calendar day it is: no zone, no local-midnight timestamp.
    expect(accepted[0]?.text).toContain('Current committed date: 2026-12-04.');
    expect(accepted[0]?.to).toBe(world.atlas.admin.email);
  });

  it('mails nothing for a deferral, a decline, or a withdrawal', async () => {
    const deferred = await submitRequest('Add a second reporting dashboard');
    const declined = await submitRequest('Rebuild the mobile app from scratch');
    const withdrawn = await submitRequest('Change the invoice footer');
    await drain();
    transport.sent.length = 0;

    await requests.triage(ownerCtx, owner, deferred, 1, 'triage');
    await requests.triage(ownerCtx, owner, deferred, 2, 'deferred', {
      clientVisibleReason: 'Parked until the next quarter.',
    });
    await requests.triage(ownerCtx, owner, declined, 1, 'triage');
    await requests.triage(ownerCtx, owner, declined, 2, 'declined', {
      clientVisibleReason: 'Outside the current agreement.',
    });
    await requests.withdraw(clientCtx, clientAdmin, withdrawn, 1);
    await drain();

    expect(transport.sent).toEqual([]);
    // But the two that carry a client-visible reason still reached the client in-app — the
    // canonical channel is unaffected by there being no §3 template to mail.
    expect(await clientNotificationCount(deferred)).toBeGreaterThan(0);
    expect(await clientNotificationCount(declined)).toBeGreaterThan(0);
    // The withdrawal is the client's own act, and NOTIF-001 tells them nothing about it.
    expect(await clientNotificationCount(withdrawn)).toBe(0);
  });
});

describe('§6 of the event catalog, applied to a channel that cannot re-check access', () => {
  it('mails nothing to a client whose membership was suspended before delivery', async () => {
    const requestId = await submitRequest('Refresh the seasonal banner set');

    // Revoked between the event being written and the relay claiming it — the window §6 is
    // about. The notification consumer already answers this with silence; so must mail,
    // because a delivered email is never re-authorized at read time.
    await db.admin.execute(
      `update client_memberships set status = 'suspended'
        where organization_id = ? and user_id = ?`,
      [world.northstar.organizationId, world.atlas.admin.id],
    );
    await drain();

    expect(transport.sent).toEqual([]);
    expect(await clientNotificationCount(requestId)).toBe(0);

    await db.admin.execute(
      `update client_memberships set status = 'active'
        where organization_id = ? and user_id = ?`,
      [world.northstar.organizationId, world.atlas.admin.id],
    );
  });

  it('mails nothing when the project is no longer shared with the client organization', async () => {
    const requestId = await submitRequest('Swap the hero photography');
    const [share] = await observe(
      `select client_organization_id from project_clients
        where organization_id = ? and project_id = ?`,
      [world.northstar.organizationId, world.northstar.projectId],
    );
    expect(share).toBeDefined();

    await db.admin.execute(
      `delete from project_clients where organization_id = ? and project_id = ?`,
      [world.northstar.organizationId, world.northstar.projectId],
    );
    await drain();
    expect(transport.sent).toEqual([]);
    expect(await clientNotificationCount(requestId)).toBe(0);

    await db.admin.execute(
      `insert into project_clients (id, organization_id, project_id, client_organization_id)
       values (?, ?, ?, ?)`,
      [
        uuidv7(),
        world.northstar.organizationId,
        world.northstar.projectId,
        world.atlas.clientOrganizationId,
      ],
    );
  });
});

describe('the mail half never costs the notification half', () => {
  it('publishes and notifies identically when no transport is wired', async () => {
    const requestId = await submitRequest('Print a one-page campaign summary');
    // The registry built with no mailer — every database suite's default, and the shape a
    // deployment that never configured SMTP has.
    await drain(createWorkerOutboxHandlers());

    expect(transport.sent).toEqual([]);
    expect(await notificationCount(requestId)).toBeGreaterThan(0);
    expect(await unpublishedCount()).toBe(0);
  });

  it('leaves the notification and the publication intact when the transport throws', async () => {
    transport.fail = true;
    const requestId = await submitRequest('Storyboard the launch film');

    const report = await runOutboxBatch(workerDb, handlers, OPTIONS);
    expect(report.failed).toBe(0);
    expect(report.effects).toBeGreaterThan(0);
    // `ClientRequestMailer.deliver` absorbs the throw, so the dispatcher sees no failure —
    // it is the producer's job to decide what a dead mail host means, exactly as it is in
    // the API's invitation path.
    expect(report.effectFailures).toEqual([]);
    expect(transport.sent).toEqual([]);

    await drain();
    expect(await notificationCount(requestId)).toBeGreaterThan(0);
    expect(await unpublishedCount()).toBe(0);
  });
});
