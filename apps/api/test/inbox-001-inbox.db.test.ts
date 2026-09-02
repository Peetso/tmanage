import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
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
import { InboxService } from '../src/modules/inbox/inbox.service.js';
import { NotificationsRepository } from '../src/modules/inbox/notifications.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld, SeededUser } from './seed-two-tenants.js';

/**
 * INBOX-001, first half, against a real server — the read surface over NOTIF-001's rows.
 *
 * The rows are written by hand here rather than produced through the worker: NOTIF-001's
 * suite already proves who the consumers write *to*, and this one is about what a recipient
 * is shown once the rows exist. Writing them directly also lets the suite name rows the
 * running consumers do not yet produce — a bundle of three about one object, say — which is
 * exactly the shape the bundling has to handle.
 *
 * What only this suite can prove, each a sentence from a governing document:
 *
 * 1. **"Recipient only"** (`21-REQUIREMENTS-TRACEABILITY` FR-07): a person's inbox holds
 *    their rows and nobody else's, and the twin tenant's identical-looking rows never appear.
 * 2. **"Bundles show count, latest time"** (`22-SCREEN-BY-SCREEN` TM-04): three rows about
 *    one object are one bundle with a count of three, its latest time the newest row's.
 * 3. **"Delayed notifications must not reveal an object after access was revoked"**
 *    (`24-EVENT-CATALOG` §6, `35` §1's second check): a row about an object this person can no
 *    longer read is dropped without a trace — no bundle, no error, no count.
 * 4. **The four modes are the planning's, read literally**: unread, client actions, blockers.
 * 5. **"Inline actions reauthorize at execution"** (TM-04): marking read re-reads the object
 *    first, marks only this recipient's rows about it, and is a no-op the second time —
 *    forward only, as the 0010 trigger insists.
 * 6. **The guard is `work.read`**, so a client principal is refused at the door, and a bad
 *    mode is a 400 that names the field.
 * 7. **The cursor runs backwards**: a page ends at its oldest row and the next page starts
 *    below it — and a cursor that is not an id is refused, not compared as text.
 * 8. **A mode is a predicate, not a post-filter** — the review fleet's finding of 2026-09-02,
 *    written as a case that failed on the shipped shape (`[]` with a live cursor) before the
 *    filter moved into the query.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let app: NestFastifyApplication;
let work: WorkItemsService;
let requests: ClientRequestsService;
let inbox: InboxService;

let ownerCtx: TenantContext;
let owner: Principal;
let managerCtx: TenantContext;
let manager: Principal;
let designerCtx: TenantContext;
let designer: Principal;
let clientCtx: TenantContext;
let clientAdmin: Principal;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_inbox_suite_xxxxxx';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_inbox_suite_xxxxxxxxxx';

const CONFIG: ApiConfig = apiConfigFrom({
  NODE_ENV: 'test',
  SESSION_COOKIE_NAME: 'tmanage_session',
  SESSION_SECRET,
  SESSION_TTL_SECONDS: 900,
  REFRESH_TTL_SECONDS: 1_209_600,
  CSRF_SECRET,
  API_PUBLIC_URL: 'http://localhost:4000',
  AUTH_MAX_FAILURES_IN_WINDOW: 50,
  AUTH_FAILURE_WINDOW_SECONDS: 900,
  AUTH_TOTP_ISSUER: 'TManage',
  CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: 180,
});

const BLOCKED = 'work_item.blocked.v1';
const SUBMITTED = 'client_request.submitted.v1';
const TRANSITIONED = 'client_request.transitioned.v1';

interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
  json<T = unknown>(): T;
}

function setCookies(response: InjectedResponse): readonly string[] {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

function cookieHeader(cookies: readonly string[]): string {
  return cookies
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => pair.split('=').slice(1).join('=').length > 0)
    .join('; ');
}

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

async function signIn(userId: string): Promise<Session> {
  const response = (await app.inject({
    method: 'POST',
    url: '/v1/dev/sessions',
    headers: { 'content-type': 'application/json' },
    payload: { userId },
  })) as unknown as InjectedResponse;
  return {
    cookie: cookieHeader(setCookies(response)),
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
  };
}

async function get(path: string, session: Session): Promise<InjectedResponse> {
  return (await app.inject({
    method: 'GET',
    url: `/v1/organizations/northstar-studio${path}`,
    headers: { cookie: session.cookie },
  })) as unknown as InjectedResponse;
}

const contextFor = (
  organizationId: string,
  user: SeededUser,
  kind: 'internal' | 'client',
  role: Role,
): TenantContext =>
  createTenantContext({
    organizationId,
    userId: user.id,
    membershipId: user.membershipId,
    principalKind: kind,
    capabilities: capabilitiesFor(role),
    policyVersion: '2026-09-02',
    correlationId: uuidv7(),
  });

function internalPrincipal(
  context: TenantContext,
  role: Role,
  scope: { readonly projectIds: readonly string[]; readonly hasOrgWideScope: boolean },
): Principal {
  return {
    userId: context.userId,
    organizationId: context.organizationId,
    kind: 'internal',
    role,
    membershipId: context.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [...scope.projectIds],
    hasOrgWideScope: scope.hasOrgWideScope,
  };
}

/**
 * One notification row, written the way the worker's `insertNotification` writes it. Ids are
 * UUIDv7 and are minted in call order, so a later call is a newer row for the cursor; the
 * explicit `created_at` keeps "latest time" independent of how fast the inserts ran.
 */
async function notify(input: {
  readonly organizationId?: string;
  readonly recipient: SeededUser;
  readonly type: string;
  readonly objectType: 'work_item' | 'client_request';
  readonly objectId: string;
  readonly createdAt: string;
  readonly readAt?: string;
}): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into notifications
       (id, organization_id, recipient_user_id, type, object_type, object_id, dedupe_key, read_at, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.organizationId ?? world.northstar.organizationId,
      input.recipient.id,
      input.type,
      input.objectType,
      input.objectId,
      // Unique per row here: the suite is about reading, and the dedupe is NOTIF-001's.
      `${input.type}:${input.objectId}:${id}`,
      input.readAt ?? null,
      input.createdAt,
    ],
  );
  return id;
}

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function unreadCountFor(userId: string, objectId: string): Promise<number> {
  const rows = await observe(
    `select count(*) as n from notifications
      where organization_id = ? and recipient_user_id = ? and object_id = ? and read_at is null`,
    [world.northstar.organizationId, userId, objectId],
  );
  return Number(rows[0]?.['n']);
}

async function createWorkItem(projectId: string, title: string): Promise<string> {
  const view = await work.create(ownerCtx, owner, { projectId, title });
  return view.id;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });

  const org = world.northstar.organizationId;
  ownerCtx = contextFor(org, world.northstar.owner, 'internal', 'owner');
  owner = internalPrincipal(ownerCtx, 'owner', { projectIds: [], hasOrgWideScope: true });
  managerCtx = contextFor(org, world.northstar.manager, 'internal', 'manager');
  manager = internalPrincipal(managerCtx, 'manager', {
    projectIds: [world.northstar.projectId],
    hasOrgWideScope: false,
  });
  // The designer is on the Atlas project and NOT on `otherProjectId` — the one fact the
  // "revoked means silent" case turns on.
  designerCtx = contextFor(org, world.northstar.designer, 'internal', 'member');
  designer = internalPrincipal(designerCtx, 'member', {
    projectIds: [world.northstar.projectId],
    hasOrgWideScope: false,
  });

  clientCtx = contextFor(org, world.atlas.admin, 'client', 'client_admin');
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
  work = new WorkItemsService(
    tenant,
    new WorkItemsRepository(),
    audit,
    new ProjectsRepository(),
    new OutboxEventsRepository(),
  );
  requests = new ClientRequestsService(
    tenant,
    new ClientRequestsRepository(),
    audit,
    new ProjectsRepository(),
    new WorkItemsRepository(),
    new ClientOrganizationsRepository(),
    new OutboxEventsRepository(),
  );
  inbox = new InboxService(tenant, work, requests, new NotificationsRepository());

  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: CONFIG,
      database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
    }),
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 300_000);

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('recipient only, and a bundle is one object', () => {
  let sharedItemId: string;

  it('a person sees their rows and nobody else’s, and the twin tenant’s never', async () => {
    sharedItemId = await createWorkItem(world.northstar.projectId, 'Shared between two inboxes');

    await notify({
      recipient: world.northstar.owner,
      type: BLOCKED,
      objectType: 'work_item',
      objectId: sharedItemId,
      createdAt: '2026-09-02 08:00:00.000',
    });
    await notify({
      recipient: world.northstar.manager,
      type: BLOCKED,
      objectType: 'work_item',
      objectId: sharedItemId,
      createdAt: '2026-09-02 08:01:00.000',
    });
    // The twin's owner, told about the twin's own identically titled work item, in the twin.
    await notify({
      organizationId: world.twin.organizationId,
      recipient: world.twin.owner,
      type: BLOCKED,
      objectType: 'work_item',
      objectId: world.twin.workItemId,
      createdAt: '2026-09-02 08:02:00.000',
    });

    const ownersPage = await inbox.list(ownerCtx, owner);
    expect(ownersPage.items.map((bundle) => bundle.objectId)).toEqual([sharedItemId]);
    expect(ownersPage.items[0]?.count).toBe(1);

    const managersPage = await inbox.list(managerCtx, manager);
    expect(managersPage.items.map((bundle) => bundle.objectId)).toEqual([sharedItemId]);
    expect(managersPage.items[0]?.count).toBe(1);

    // Nothing of the twin's leaked into either, and the designer — told nothing — has nothing.
    const designersPage = await inbox.list(designerCtx, designer);
    expect(designersPage.items).toEqual([]);
  });

  it('three rows about one object are one bundle: count, unread, types, latest time', async () => {
    const itemId = await createWorkItem(world.northstar.projectId, 'Bundled three times');

    await notify({
      recipient: world.northstar.owner,
      type: TRANSITIONED,
      objectType: 'work_item',
      objectId: itemId,
      createdAt: '2026-09-02 09:00:00.000',
      readAt: '2026-09-02 09:05:00.000',
    });
    await notify({
      recipient: world.northstar.owner,
      type: BLOCKED,
      objectType: 'work_item',
      objectId: itemId,
      createdAt: '2026-09-02 09:10:00.000',
    });
    await notify({
      recipient: world.northstar.owner,
      type: BLOCKED,
      objectType: 'work_item',
      objectId: itemId,
      createdAt: '2026-09-02 09:20:00.000',
    });

    const page = await inbox.list(ownerCtx, owner);
    const bundle = page.items.find((candidate) => candidate.objectId === itemId);
    expect(bundle).toBeDefined();
    expect(bundle?.bundleId).toBe(`work_item:${itemId}`);
    expect(bundle?.count).toBe(3);
    expect(bundle?.unreadCount).toBe(2);
    // Newest first, each type once.
    expect(bundle?.types).toEqual([BLOCKED, TRANSITIONED]);
    expect(bundle?.latestAt).toBe('2026-09-02T09:20:00.000Z');
    // The title and state are the object's, read through `WorkItemsService.get`.
    expect(bundle?.title).toBe('Bundled three times');
    expect(bundle?.state).toBe('backlog');
    expect(bundle?.projectId).toBe(world.northstar.projectId);
    expect(bundle?.action).toEqual({ kind: 'open' });

    // Most recently touched object first: this one, then the shared item from before.
    expect(page.items.map((candidate) => candidate.objectId)).toEqual([itemId, sharedItemId]);
  });

  it('a client request bundles the same way, resolved through its own service', async () => {
    const submitted = await requests.submit(clientCtx, clientAdmin, {
      projectId: world.northstar.projectId,
      title: 'Add the loyalty desk to the footer',
      description: 'Filed by the inbox suite.',
    });
    await notify({
      recipient: world.northstar.manager,
      type: SUBMITTED,
      objectType: 'client_request',
      objectId: submitted.id,
      createdAt: '2026-09-02 09:30:00.000',
    });

    const page = await inbox.list(managerCtx, manager);
    const bundle = page.items.find((candidate) => candidate.objectId === submitted.id);
    expect(bundle?.bundleId).toBe(`client_request:${submitted.id}`);
    expect(bundle?.objectType).toBe('client_request');
    expect(bundle?.title).toBe('Add the loyalty desk to the footer');
    expect(bundle?.state).toBe('submitted');
    expect(bundle?.types).toEqual([SUBMITTED]);
  });
});

describe('§6: an object this person may no longer read is dropped without a trace', () => {
  it('a row about work on a project the recipient is not on produces no bundle', async () => {
    const hiddenId = await createWorkItem(world.northstar.otherProjectId, 'Not the designer’s');
    const visibleId = await createWorkItem(world.northstar.projectId, 'The designer’s to see');

    await notify({
      recipient: world.northstar.designer,
      type: BLOCKED,
      objectType: 'work_item',
      objectId: hiddenId,
      createdAt: '2026-09-02 10:00:00.000',
    });
    await notify({
      recipient: world.northstar.designer,
      type: BLOCKED,
      objectType: 'work_item',
      objectId: visibleId,
      createdAt: '2026-09-02 10:01:00.000',
    });

    const page = await inbox.list(designerCtx, designer);
    expect(page.items.map((bundle) => bundle.objectId)).toEqual([visibleId]);
    // The owner, who can read everything, sees the row was really written — it is the
    // designer's *read* that hides it, not the write that never happened.
    expect(await unreadCountFor(world.northstar.designer.id, hiddenId)).toBe(1);

    // …and marking the hidden bundle read is refused the same way the list hid it.
    await expect(
      inbox.markBundleRead(designerCtx, designer, `work_item:${hiddenId}`),
    ).rejects.toMatchObject({ status: 404 });
    expect(await unreadCountFor(world.northstar.designer.id, hiddenId)).toBe(1);
  });

  it('a soft-deleted work item reads as absent, so its bundle is gone too', async () => {
    const itemId = await createWorkItem(world.northstar.projectId, 'Deleted after the fact');
    await notify({
      recipient: world.northstar.owner,
      type: BLOCKED,
      objectType: 'work_item',
      objectId: itemId,
      createdAt: '2026-09-02 10:10:00.000',
    });
    const before = await inbox.list(ownerCtx, owner);
    expect(before.items.some((bundle) => bundle.objectId === itemId)).toBe(true);

    await db.admin.execute(`update work_items set deleted_at = utc_timestamp(3) where id = ?`, [
      itemId,
    ]);

    const after = await inbox.list(ownerCtx, owner);
    expect(after.items.some((bundle) => bundle.objectId === itemId)).toBe(false);
  });

  it('a client request reaches a member who cannot triage as nothing at all', async () => {
    // `ClientRequestsService.get` demands `client_request.triage`, which a `member` does not
    // hold; NOTIF-001's consumer would never write this row, but a row that exists anyway —
    // a role lowered after the event, say — resolves to nothing, the same as a lost project.
    const submitted = await requests.submit(clientCtx, clientAdmin, {
      projectId: world.northstar.projectId,
      title: 'Not for a member to see',
      description: 'Filed by the inbox suite.',
    });
    await notify({
      recipient: world.northstar.designer,
      type: SUBMITTED,
      objectType: 'client_request',
      objectId: submitted.id,
      createdAt: '2026-09-02 10:20:00.000',
    });

    const page = await inbox.list(designerCtx, designer, { mode: 'client_actions' });
    expect(page.items).toEqual([]);
    expect(await unreadCountFor(world.northstar.designer.id, submitted.id)).toBe(1);
  });
});

describe('the four modes', () => {
  let blockedItemId: string;
  let quietItemId: string;
  let requestId: string;

  beforeAll(async () => {
    // The manager, who can triage: a client request resolves for them. A `member` cannot
    // read one at all — `ClientRequestsService.get` demands triage — and the §6 block above
    // proves that bundle is dropped rather than shown. The manager's earlier rows are
    // still there, so every assertion below is about membership, not about a whole page.
    blockedItemId = await createWorkItem(world.northstar.projectId, 'Mode: blocked');
    quietItemId = await createWorkItem(world.northstar.projectId, 'Mode: already read');
    const submitted = await requests.submit(clientCtx, clientAdmin, {
      projectId: world.northstar.projectId,
      title: 'Mode: a client acted',
      description: 'Filed by the inbox suite.',
    });
    requestId = submitted.id;

    await notify({
      recipient: world.northstar.manager,
      type: BLOCKED,
      objectType: 'work_item',
      objectId: blockedItemId,
      createdAt: '2026-09-02 11:00:00.000',
    });
    await notify({
      recipient: world.northstar.manager,
      type: TRANSITIONED,
      objectType: 'work_item',
      objectId: quietItemId,
      createdAt: '2026-09-02 11:01:00.000',
      readAt: '2026-09-02 11:02:00.000',
    });
    await notify({
      recipient: world.northstar.manager,
      type: SUBMITTED,
      objectType: 'client_request',
      objectId: requestId,
      createdAt: '2026-09-02 11:03:00.000',
    });
  });

  it('`all` is everything readable', async () => {
    const page = await inbox.list(managerCtx, manager, { mode: 'all' });
    const ids = page.items.map((bundle) => bundle.objectId);
    expect(ids).toContain(blockedItemId);
    expect(ids).toContain(quietItemId);
    expect(ids).toContain(requestId);
  });

  it('`waiting_on_me` is what is unread', async () => {
    const page = await inbox.list(managerCtx, manager, { mode: 'waiting_on_me' });
    const ids = page.items.map((bundle) => bundle.objectId);
    expect(ids).toContain(blockedItemId);
    expect(ids).toContain(requestId);
    expect(ids).not.toContain(quietItemId);
    for (const bundle of page.items) expect(bundle.unreadCount).toBe(bundle.count);
  });

  it('`client_actions` is what a client did', async () => {
    const page = await inbox.list(managerCtx, manager, { mode: 'client_actions' });
    const ids = page.items.map((bundle) => bundle.objectId);
    expect(ids).toContain(requestId);
    expect(ids).not.toContain(blockedItemId);
    expect(ids).not.toContain(quietItemId);
    for (const bundle of page.items) expect(bundle.types).toContain(SUBMITTED);
  });

  it('`important` is a blocker affecting the recipient', async () => {
    const page = await inbox.list(managerCtx, manager, { mode: 'important' });
    const ids = page.items.map((bundle) => bundle.objectId);
    expect(ids).toContain(blockedItemId);
    expect(ids).not.toContain(quietItemId);
    expect(ids).not.toContain(requestId);
  });

  it('a mode is a predicate in the query, so a page of `limit` rows is a page of matches', async () => {
    // The newest row for the manager is the submitted request (11:03), which `important`
    // does not want. A post-filter over a one-row page would answer `[]` with a cursor
    // beneath it — "nothing important" with more to load. The predicate answers the blocker.
    const page = await inbox.list(managerCtx, manager, { mode: 'important', limit: 1 });
    expect(page.items.map((bundle) => bundle.objectId)).toEqual([blockedItemId]);

    const clients = await inbox.list(managerCtx, manager, { mode: 'client_actions', limit: 1 });
    expect(clients.items.map((bundle) => bundle.objectId)).toEqual([requestId]);
  });
});

describe('mark read: this recipient’s rows about one object, forward only', () => {
  it('marks every unread row of the bundle, leaves other people’s alone, and is a no-op twice', async () => {
    const itemId = await createWorkItem(world.northstar.projectId, 'Marked read by its owner');
    for (const createdAt of ['2026-09-02 12:00:00.000', '2026-09-02 12:01:00.000']) {
      await notify({
        recipient: world.northstar.owner,
        type: BLOCKED,
        objectType: 'work_item',
        objectId: itemId,
        createdAt,
      });
    }
    await notify({
      recipient: world.northstar.manager,
      type: BLOCKED,
      objectType: 'work_item',
      objectId: itemId,
      createdAt: '2026-09-02 12:02:00.000',
    });

    const first = await inbox.markBundleRead(ownerCtx, owner, `work_item:${itemId}`);
    expect(first).toEqual({ bundleId: `work_item:${itemId}`, marked: 2 });
    expect(await unreadCountFor(world.northstar.owner.id, itemId)).toBe(0);
    // The manager was told about the same object; their rows are theirs.
    expect(await unreadCountFor(world.northstar.manager.id, itemId)).toBe(1);

    // A redelivered "mark read" changes nothing and is not an error.
    const second = await inbox.markBundleRead(ownerCtx, owner, `work_item:${itemId}`);
    expect(second.marked).toBe(0);

    // The bundle is still listed — read is a state, not a deletion — with nothing unread.
    const page = await inbox.list(ownerCtx, owner);
    const bundle = page.items.find((candidate) => candidate.objectId === itemId);
    expect(bundle?.count).toBe(2);
    expect(bundle?.unreadCount).toBe(0);
    // …and gone from `waiting_on_me`.
    const waiting = await inbox.list(ownerCtx, owner, { mode: 'waiting_on_me' });
    expect(waiting.items.some((candidate) => candidate.objectId === itemId)).toBe(false);
  });

  it('a bundle id that names nothing, or names it badly, is a 404 that writes nothing', async () => {
    const before = await observe(
      `select count(*) as n from notifications where organization_id = ? and read_at is not null`,
      [world.northstar.organizationId],
    );
    for (const bad of ['work_item:', ':abc', 'no-separator', `deliverable:${uuidv7()}`]) {
      await expect(inbox.markBundleRead(ownerCtx, owner, bad)).rejects.toMatchObject({
        status: 404,
      });
    }
    await expect(
      inbox.markBundleRead(ownerCtx, owner, `work_item:${uuidv7()}`),
    ).rejects.toMatchObject({ status: 404 });
    const after = await observe(
      `select count(*) as n from notifications where organization_id = ? and read_at is not null`,
      [world.northstar.organizationId],
    );
    expect(Number(after[0]?.['n'])).toBe(Number(before[0]?.['n']));
  });
});

describe('the cursor runs backwards', () => {
  it('a page ends at its oldest row and the next page starts below it', async () => {
    // A recipient with no other rows: the brightops owner, in their own tenant.
    const org = world.brightops.organizationId;
    const ctx = contextFor(org, world.brightops.owner, 'internal', 'owner');
    const principal = internalPrincipal(ctx, 'owner', { projectIds: [], hasOrgWideScope: true });
    const brightopsWork = new WorkItemsService(
      tenant,
      new WorkItemsRepository(),
      new AuditService(tenant, new AuditEventsRepository()),
      new ProjectsRepository(),
      new OutboxEventsRepository(),
    );
    const brightopsInbox = new InboxService(
      tenant,
      brightopsWork,
      requests,
      new NotificationsRepository(),
    );

    const ids: string[] = [];
    for (const [index, title] of ['Oldest', 'Middle', 'Newest'].entries()) {
      const item = await brightopsWork.create(ctx, principal, {
        projectId: world.brightops.projectId,
        title,
      });
      ids.push(
        await notify({
          organizationId: org,
          recipient: world.brightops.owner,
          type: BLOCKED,
          objectType: 'work_item',
          objectId: item.id,
          createdAt: `2026-09-02 13:0${index}:00.000`,
        }),
      );
    }

    const first = await brightopsInbox.list(ctx, principal, { limit: 2 });
    expect(first.items.map((bundle) => bundle.title)).toEqual(['Newest', 'Middle']);
    // The cursor is the id of the oldest row this page bundled — "Middle"'s.
    expect(first.nextCursor).toBe(ids[1]);

    const second = await brightopsInbox.list(ctx, principal, {
      limit: 2,
      ...(first.nextCursor === null ? {} : { before: first.nextCursor }),
    });
    expect(second.items.map((bundle) => bundle.title)).toEqual(['Oldest']);
    expect(second.nextCursor).toBeNull();
  });
});

describe('over HTTP: the guard, and the query', () => {
  it('an internal member reads their inbox; a client principal is refused at the door', async () => {
    const internal = await signIn(world.northstar.manager.id);
    const ok = await get('/inbox', internal);
    expect(ok.statusCode).toBe(200);
    const body = ok.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);

    const client = await signIn(world.atlas.admin.id);
    const refused = await get('/inbox', client);
    expect(refused.statusCode).toBe(403);
  });

  it('a mode the planning does not name is a 400 that says which field', async () => {
    const internal = await signIn(world.northstar.owner.id);
    const response = await get('/inbox?mode=urgent&limit=0&before=abc', internal);
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string; details: { field: string }[] } }>();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.map((detail) => detail.field).sort()).toEqual([
      'before',
      'limit',
      'mode',
    ]);
  });

  it('marking read over HTTP is the same action, reauthorized', async () => {
    const itemId = await createWorkItem(world.northstar.projectId, 'Marked read over HTTP');
    await notify({
      recipient: world.northstar.owner,
      type: BLOCKED,
      objectType: 'work_item',
      objectId: itemId,
      createdAt: '2026-09-02 14:00:00.000',
    });
    const session = await signIn(world.northstar.owner.id);

    const response = (await app.inject({
      method: 'POST',
      url: `/v1/organizations/northstar-studio/inbox/${encodeURIComponent(`work_item:${itemId}`)}/read`,
      headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    })) as unknown as InjectedResponse;
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ marked: number }>().marked).toBe(1);
    expect(await unreadCountFor(world.northstar.owner.id, itemId)).toBe(0);
  });
});
