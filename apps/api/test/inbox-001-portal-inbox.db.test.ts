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
import type { TenantContext, TenantQueryRunner } from '../src/common/database/tenant-context.js';
import type { ClientRequestRow } from '../src/common/database/schema.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { OutboxEventsRepository } from '../src/modules/platform/outbox-events.repository.js';
import { ProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { WorkItemsRepository } from '../src/modules/work/work-items.repository.js';
import { ClientRequestsRepository } from '../src/modules/requests/client-requests.repository.js';
import { ClientRequestsService } from '../src/modules/requests/client-requests.service.js';
import { ClientOrganizationsRepository } from '../src/modules/clients/client-organizations.repository.js';
import { PortalInboxService } from '../src/modules/inbox/portal-inbox.service.js';
import { NotificationsRepository } from '../src/modules/inbox/notifications.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld, SeededUser } from './seed-two-tenants.js';

/**
 * INBOX-001, second half, against a real server — the client's inbox as a portal projection.
 *
 * The first half's suite proves the internal read surface. This one is about the rows that
 * surface could never show: `client_request.transitioned.v1` rows written *to the client who
 * submitted*, which no `work.read` holder is the recipient of. The rows are written by hand,
 * as in the first half's suite, because NOTIF-001's suite already proves who the consumers
 * write to.
 *
 * What only this suite can prove, from both sides of the portal:
 *
 * 1. **A client reads their own rows and nobody else's** (`21-REQUIREMENTS-TRACEABILITY`
 *    FR-07): a colleague in the same client organization sees nothing of theirs, a sibling
 *    client sees nothing, the twin tenant's identical-looking rows never appear.
 * 2. **The bundle is a projection.** It carries the client-safe `status` — `triage` reads as
 *    `submitted` — and never the internal state, because it was built from `getForClient`'s
 *    view and nothing here ever saw the row.
 * 3. **"Must not reveal an object after access was revoked"** (`24-EVENT-CATALOG` §6): a row
 *    about a request in a project no longer shared with the client is dropped without a
 *    trace, and a client whose membership is suspended is refused at the door.
 * 4. **An internal principal is refused on the portal route** — at the guard over HTTP, and
 *    again by the service when the guard is not in the way.
 * 5. **Mark read is the client's own rows about one request, reauthorized first, forward only.**
 * 6. **A row about anything but a client request is skipped**, never resolved through an
 *    internal read: a client has no authorized read of a work item by id.
 * 7. **The two modes, the backwards cursor, and the 400** behave as the internal inbox's do.
 * 8. **A request submitted through the portal route leaves its event in the outbox.** E2E-07's
 *    first run found that it did not: `ClientsModule` built its `ClientRequestsService` without
 *    the outbox, and `append` is optional-chained. Without this case the whole notification
 *    loop is proved only for requests the suites submit directly.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let app: NestFastifyApplication;
let requests: ClientRequestsService;
let inbox: PortalInboxService;

let ownerCtx: TenantContext;
let owner: Principal;
let atlasAdminCtx: TenantContext;
let atlasAdmin: Principal;
let atlasReviewerCtx: TenantContext;
let atlasReviewer: Principal;
let meridianCtx: TenantContext;
let meridianReviewer: Principal;
/** The seed has no org_admin; this suite needs one, because org_admin is half of the argument. */
let orgAdminUserId: string;
/** Written to by the paging case alone, so its page arithmetic owes nothing to the other cases. */
let atlasViewerCtx: TenantContext;
let atlasViewer: Principal;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_portal_inbox_suite_x';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_portal_inbox_suite_xxxxx';

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

const TRANSITIONED = 'client_request.transitioned.v1';
const BLOCKED = 'work_item.blocked.v1';

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

async function post(
  path: string,
  session: Session,
  payload?: Record<string, unknown>,
): Promise<InjectedResponse> {
  return (await app.inject({
    method: 'POST',
    url: `/v1/organizations/northstar-studio${path}`,
    headers: {
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { payload } : {}),
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

function clientPrincipal(
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
    projectIds: [...projectIds],
    hasOrgWideScope: false,
  };
}

/** One notification row, written the way the worker's `insertNotification` writes it. */
async function notify(input: {
  readonly organizationId?: string;
  readonly recipient: SeededUser;
  readonly type?: string;
  readonly objectType?: 'work_item' | 'client_request';
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
      input.type ?? TRANSITIONED,
      input.objectType ?? 'client_request',
      input.objectId,
      `${input.type ?? TRANSITIONED}:${input.objectId}:${id}`,
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

/** The guard's refusal leaves a `security.capability_denied` row; the service's leaves none. */
async function capabilityDenials(): Promise<number> {
  const rows = await observe(
    `select count(*) as n from audit_events
      where organization_id = ? and action = 'security.capability_denied'`,
    [world.northstar.organizationId],
  );
  return Number(rows[0]?.['n']);
}

async function unreadCountFor(userId: string, objectId: string): Promise<number> {
  const rows = await observe(
    `select count(*) as n from notifications
      where organization_id = ? and recipient_user_id = ? and object_id = ? and read_at is null`,
    [world.northstar.organizationId, userId, objectId],
  );
  return Number(rows[0]?.['n']);
}

async function submitAs(
  context: TenantContext,
  principal: Principal,
  projectId: string,
  title: string,
): Promise<string> {
  const view = await requests.submit(context, principal, {
    projectId,
    title,
    description: 'Filed by the portal inbox suite.',
  });
  return view.id;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });

  const org = world.northstar.organizationId;
  ownerCtx = contextFor(org, world.northstar.owner, 'internal', 'owner');
  owner = {
    userId: ownerCtx.userId,
    organizationId: org,
    kind: 'internal',
    role: 'owner',
    membershipId: ownerCtx.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };

  atlasAdminCtx = contextFor(org, world.atlas.admin, 'client', 'client_admin');
  atlasAdmin = clientPrincipal(atlasAdminCtx, 'client_admin', world.atlas.clientOrganizationId, [
    world.northstar.projectId,
  ]);
  atlasReviewerCtx = contextFor(org, world.atlas.reviewer, 'client', 'client_reviewer');
  atlasReviewer = clientPrincipal(
    atlasReviewerCtx,
    'client_reviewer',
    world.atlas.clientOrganizationId,
    [world.northstar.projectId],
  );
  atlasViewerCtx = contextFor(org, world.atlas.viewer, 'client', 'client_viewer');
  atlasViewer = clientPrincipal(atlasViewerCtx, 'client_viewer', world.atlas.clientOrganizationId, [
    world.northstar.projectId,
  ]);
  orgAdminUserId = uuidv7();
  await db.admin.execute(
    `insert into users (id, email, display_name, email_verified_at)
     values (?, ?, ?, utc_timestamp(3))`,
    [orgAdminUserId, 'org-admin@portal-inbox.northstar.example', 'Portal inbox org_admin'],
  );
  await db.admin.execute(
    `insert into memberships (id, organization_id, user_id, role, has_org_wide_scope)
     values (?, ?, ?, 'org_admin', true)`,
    [uuidv7(), org, orgAdminUserId],
  );
  meridianCtx = contextFor(org, world.meridian.reviewer, 'client', 'client_reviewer');
  meridianReviewer = clientPrincipal(
    meridianCtx,
    'client_reviewer',
    world.meridian.clientOrganizationId,
    [world.meridian.projectId],
  );

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
  inbox = new PortalInboxService(tenant, requests, new NotificationsRepository());

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

describe('recipient only, from the client side', () => {
  let adminRequestId: string;
  let meridianRequestId: string;

  it('a client sees their rows; a colleague, a sibling client and the twin tenant see none of them', async () => {
    adminRequestId = await submitAs(
      atlasAdminCtx,
      atlasAdmin,
      world.northstar.projectId,
      'Arabic booking FAQ on the rooms page',
    );
    meridianRequestId = await submitAs(
      meridianCtx,
      meridianReviewer,
      world.meridian.projectId,
      'Meridian wants a sitemap',
    );

    await notify({
      recipient: world.atlas.admin,
      objectId: adminRequestId,
      createdAt: '2026-09-02 09:00:00.000',
    });
    await notify({
      recipient: world.atlas.admin,
      objectId: adminRequestId,
      createdAt: '2026-09-02 09:05:00.000',
    });
    await notify({
      recipient: world.meridian.reviewer,
      objectId: meridianRequestId,
      createdAt: '2026-09-02 09:10:00.000',
    });
    // The twin tenant's identical-looking row, to the same user id, about the same request id.
    await notify({
      organizationId: world.twin.organizationId,
      recipient: world.atlas.admin,
      objectId: adminRequestId,
      createdAt: '2026-09-02 09:20:00.000',
    });

    const admin = await inbox.list(atlasAdminCtx, atlasAdmin);
    expect(admin.items.map((bundle) => bundle.requestId)).toEqual([adminRequestId]);
    expect(admin.items[0]?.count).toBe(2);
    expect(admin.items[0]?.unreadCount).toBe(2);
    expect(admin.items[0]?.latestAt).toBe('2026-09-02T09:05:00.000Z');
    expect(admin.items[0]?.types).toEqual([TRANSITIONED]);
    expect(admin.items[0]?.bundleId).toBe(`client_request:${adminRequestId}`);

    // Same client organization, same shared project, a different person: nothing.
    const colleague = await inbox.list(atlasReviewerCtx, atlasReviewer);
    expect(colleague.items).toEqual([]);

    // A sibling client sees only its own.
    const sibling = await inbox.list(meridianCtx, meridianReviewer);
    expect(sibling.items.map((bundle) => bundle.requestId)).toEqual([meridianRequestId]);
  });

  it('an event type the portal does not know is dropped from the bundle, and the bundle stays', async () => {
    await notify({
      recipient: world.atlas.admin,
      type: 'client_request.mystery.v9',
      objectId: adminRequestId,
      createdAt: '2026-09-02 09:07:00.000',
    });
    const page = await inbox.list(atlasAdminCtx, atlasAdmin);
    const bundle = page.items.find((candidate) => candidate.requestId === adminRequestId);
    expect(bundle?.count).toBe(3);
    expect(bundle?.types).toEqual([TRANSITIONED]);
    expect(bundle?.latestAt).toBe('2026-09-02T09:07:00.000Z');
  });

  it('the bundle is a projection: the client-safe status, never the internal state', async () => {
    // Move the request to `triage` behind the client's back. `CL-06` says `submitted`.
    await db.admin.execute('update client_requests set state = ? where id = ?', [
      'triage',
      adminRequestId,
    ]);

    const page = await inbox.list(atlasAdminCtx, atlasAdmin);
    const bundle = page.items.find((candidate) => candidate.requestId === adminRequestId);
    expect(bundle?.status).toBe('submitted');
    expect(bundle?.title).toBe('Arabic booking FAQ on the rooms page');
    expect(bundle?.projectId).toBe(world.northstar.projectId);
    expect(Object.keys(bundle ?? {}).sort()).toEqual([
      'action',
      'bundleId',
      'count',
      'latestAt',
      'projectId',
      'requestId',
      'status',
      'title',
      'types',
      'unreadCount',
    ]);
  });

  it('a row about anything but a client request is never selected, let alone resolved', async () => {
    await notify({
      recipient: world.atlas.admin,
      type: BLOCKED,
      objectType: 'work_item',
      objectId: world.northstar.workItemId,
      createdAt: '2026-09-02 09:30:00.000',
    });

    // The object type is a predicate, not a skip after the read: with `limit: 1` the newest
    // row is the work item's, and a skip would answer `[]` beneath a live cursor. The fleet
    // found the skip shape on 2026-09-02; this is the case that failed on it.
    const narrow = await inbox.list(atlasAdminCtx, atlasAdmin, { limit: 1 });
    expect(narrow.items.map((bundle) => bundle.requestId)).toEqual([adminRequestId]);

    // Absence alone would not prove the skip: a work-item id put through `getForClient` is a
    // 404 and would be dropped anyway. So the read is watched, and the assertion is that it was
    // never asked about the work item at all.
    const asked: string[] = [];
    const watched = Object.create(requests) as ClientRequestsService;
    // The page's read is the batched one since 2026-09-03; `getForClient` stays the single
    // read `markBundleRead` reauthorizes through.
    watched.getManyForClient = (context, principal, requestIds) => {
      asked.push(...requestIds);
      return requests.getManyForClient(context, principal, requestIds);
    };
    const watchedInbox = new PortalInboxService(tenant, watched, new NotificationsRepository());

    const page = await watchedInbox.list(atlasAdminCtx, atlasAdmin);
    expect(page.items.map((bundle) => bundle.requestId)).toEqual([adminRequestId]);
    expect(page.items.every((bundle) => bundle.bundleId.startsWith('client_request:'))).toBe(true);
    expect(asked).toEqual([adminRequestId]);
  });
});

describe('§6: revoked means silent', () => {
  it('a request in a project no longer shared with the client produces no bundle', async () => {
    const requestId = await submitAs(
      atlasAdminCtx,
      atlasAdmin,
      world.northstar.projectId,
      'Dropped once the share is gone',
    );
    const rowId = await notify({
      recipient: world.atlas.admin,
      objectId: requestId,
      createdAt: '2026-09-02 10:00:00.000',
    });

    const before = await inbox.list(atlasAdminCtx, atlasAdmin);
    expect(before.items.some((bundle) => bundle.requestId === requestId)).toBe(true);

    // The revocation is in the data — the `project_clients` row goes — and the read is over
    // HTTP, so the principal's project scope is rebuilt by `PrincipalRepository` from what
    // is left, and `getForClient` answers 404 through `authorize()` rule 10. Editing the
    // principal by hand would have proved only that the service honours a list it was given.
    const session = await signIn(world.atlas.admin.id);
    await db.admin.query(
      'delete from project_clients where organization_id = ? and project_id = ? and client_organization_id = ?',
      [world.northstar.organizationId, world.northstar.projectId, world.atlas.clientOrganizationId],
    );
    try {
      // `limit: 1` with the dropped row the newest: the page is empty *and* the cursor is
      // live, which is the honest shape — "nothing you can still see on this page", not
      // "nothing". A `nextCursor` of null here would have been the default page size
      // never filling, not the drop.
      const after = await get('/portal/inbox?limit=1', session);
      expect(after.statusCode, after.body).toBe(200);
      const page = after.json<{ items: { requestId: string }[]; nextCursor: string | null }>();
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBe(rowId);

      // Nor can it be marked read: the same 404, and the row untouched.
      const marked = await post(
        `/portal/inbox/${encodeURIComponent(`client_request:${requestId}`)}/read`,
        session,
      );
      expect(marked.statusCode).toBe(404);
    } finally {
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
    }
    expect(await unreadCountFor(world.atlas.admin.id, requestId)).toBe(1);
  });

  it('a suspended client membership is refused at the door over HTTP', async () => {
    const session = await signIn(world.atlas.reviewer.id);
    expect((await get('/portal/inbox', session)).statusCode).toBe(200);

    await db.admin.query('UPDATE client_memberships SET status = ? WHERE id = ?', [
      'suspended',
      world.atlas.reviewer.membershipId,
    ]);
    try {
      // 404 from `TenantContextGuard`: the membership no longer resolves, so the organization
      // is indistinguishable from one that does not exist.
      expect((await get('/portal/inbox', session)).statusCode).toBe(404);
    } finally {
      await db.admin.query('UPDATE client_memberships SET status = ? WHERE id = ?', [
        'active',
        world.atlas.reviewer.membershipId,
      ]);
    }
  });
});

describe('an internal principal is refused on the portal route', () => {
  it('403 over HTTP for owner, org_admin, manager and member: the guard for the last two, the service for the first two', async () => {
    // The owner's and the org_admin's ceilings are every capability, `client_request.submit`
    // included, so the guard passes them and the 403 is the service's. The manager and the
    // member never reach the service. The wire cannot tell the two apart — a uniform 403 is
    // the point — but the audit trail can: the guard's refusal writes a
    // `security.capability_denied` row and the service's writes nothing.
    const cases: readonly { readonly userId: string; readonly guard: boolean }[] = [
      { userId: world.northstar.owner.id, guard: false },
      { userId: orgAdminUserId, guard: false },
      { userId: world.northstar.manager.id, guard: true },
      { userId: world.northstar.designer.id, guard: true },
    ];
    for (const { userId, guard } of cases) {
      const session = await signIn(userId);
      const denialsBefore = await capabilityDenials();
      const response = await get('/portal/inbox', session);
      expect(response.statusCode, userId).toBe(403);
      expect((await capabilityDenials()) - denialsBefore, userId).toBe(guard ? 1 : 0);
    }
  });

  it('403 from the service too, so the refusal does not rest on one declaration', async () => {
    await expect(inbox.list(ownerCtx, owner)).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    await expect(
      inbox.markBundleRead(ownerCtx, owner, 'client_request:anything'),
    ).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('mark read: this client’s rows about one request, forward only', () => {
  it('marks every unread row of the bundle, leaves a colleague’s alone, and is a no-op twice', async () => {
    const requestId = await submitAs(
      atlasAdminCtx,
      atlasAdmin,
      world.northstar.projectId,
      'Marked read',
    );
    await notify({
      recipient: world.atlas.admin,
      objectId: requestId,
      createdAt: '2026-09-02 11:00:00.000',
    });
    await notify({
      recipient: world.atlas.admin,
      objectId: requestId,
      createdAt: '2026-09-02 11:01:00.000',
    });
    await notify({
      recipient: world.atlas.admin,
      objectId: requestId,
      createdAt: '2026-09-02 11:02:00.000',
      readAt: '2026-09-02 11:03:00.000',
    });
    // A colleague told about the same request (a consumer could, one day). Not theirs to mark.
    await notify({
      recipient: world.atlas.reviewer,
      objectId: requestId,
      createdAt: '2026-09-02 11:04:00.000',
    });

    const first = await inbox.markBundleRead(
      atlasAdminCtx,
      atlasAdmin,
      `client_request:${requestId}`,
    );
    expect(first.marked).toBe(2);
    expect(await unreadCountFor(world.atlas.admin.id, requestId)).toBe(0);
    expect(await unreadCountFor(world.atlas.reviewer.id, requestId)).toBe(1);

    const second = await inbox.markBundleRead(
      atlasAdminCtx,
      atlasAdmin,
      `client_request:${requestId}`,
    );
    expect(second.marked).toBe(0);

    const unread = await inbox.list(atlasAdminCtx, atlasAdmin, { mode: 'unread' });
    expect(unread.items.some((bundle) => bundle.requestId === requestId)).toBe(false);
    const all = await inbox.list(atlasAdminCtx, atlasAdmin);
    const bundle = all.items.find((candidate) => candidate.requestId === requestId);
    expect(bundle?.count).toBe(3);
    expect(bundle?.unreadCount).toBe(0);
  });

  it('a sibling client’s request, a work item, or a malformed id is a 404 that writes nothing', async () => {
    const meridianRequestId = await submitAs(
      meridianCtx,
      meridianReviewer,
      world.meridian.projectId,
      'Not Atlas’s to mark',
    );
    await notify({
      recipient: world.atlas.admin,
      objectId: meridianRequestId,
      createdAt: '2026-09-02 11:30:00.000',
    });

    for (const bundleId of [
      `client_request:${meridianRequestId}`,
      `work_item:${world.northstar.workItemId}`,
      'client_request:',
      'nonsense',
    ]) {
      await expect(
        inbox.markBundleRead(atlasAdminCtx, atlasAdmin, bundleId),
        bundleId,
      ).rejects.toMatchObject({
        status: 404,
      });
    }
    expect(await unreadCountFor(world.atlas.admin.id, meridianRequestId)).toBe(1);
  });
});

describe('the loop starts at the portal: a submission through the route leaves its event', () => {
  it('POST /portal/requests writes client_request.submitted.v1 to the outbox, and a withdrawal its transition', async () => {
    const session = await signIn(world.atlas.admin.id);
    const submitted = await post('/portal/requests', session, {
      projectId: world.northstar.projectId,
      title: 'Submitted through the portal route',
      description: 'The event this leaves is what the worker relays.',
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const { id, version } = submitted.json<{ id: string; version: number }>();

    const events = await observe(
      'select type from outbox_events where organization_id = ? and aggregate_id = ? order by id',
      [world.northstar.organizationId, id],
    );
    expect(events.map((row) => row['type'])).toEqual(['client_request.submitted.v1']);

    const withdrawn = await post(`/portal/requests/${id}/withdrawal`, session, { version });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    const after = await observe(
      'select type from outbox_events where organization_id = ? and aggregate_id = ? order by id',
      [world.northstar.organizationId, id],
    );
    expect(after.map((row) => row['type'])).toEqual([
      'client_request.submitted.v1',
      'client_request.transitioned.v1',
    ]);
  });
});

describe('the modes, the cursor, and the query over HTTP', () => {
  it('a page ends at its oldest row and the next page starts below it; `unread` is a predicate', async () => {
    const requestId = await submitAs(
      atlasViewerCtx,
      atlasViewer,
      world.northstar.projectId,
      'Paged',
    );
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      ids.push(
        await notify({
          recipient: world.atlas.viewer,
          objectId: requestId,
          createdAt: `2026-09-02 12:0${index}:00.000`,
          ...(index === 1 ? { readAt: '2026-09-02 12:10:00.000' } : {}),
        }),
      );
    }

    const firstPage = await inbox.list(atlasViewerCtx, atlasViewer, { limit: 2 });
    expect(firstPage.nextCursor).toBe(ids[1]);
    expect(firstPage.items[0]?.count).toBe(2);
    const cursor = firstPage.nextCursor ?? '';
    const secondPage = await inbox.list(atlasViewerCtx, atlasViewer, { limit: 2, before: cursor });
    expect(secondPage.items[0]?.count).toBe(1);
    expect(secondPage.nextCursor).toBeNull();

    // `unread` with `limit: 2`: the middle of the three rows is read. A predicate returns the
    // two unread rows (12:02 and 12:00, `count: 2`); a post-filter over the newest two rows
    // would return only 12:02 (`count: 1`). The count is what tells the two shapes apart.
    const unread = await inbox.list(atlasViewerCtx, atlasViewer, { mode: 'unread', limit: 2 });
    const bundle = unread.items.find((candidate) => candidate.requestId === requestId);
    expect(bundle?.count).toBe(2);
    expect(bundle?.unreadCount).toBe(2);
    expect(bundle?.latestAt).toBe('2026-09-02T12:02:00.000Z');
    expect(unread.nextCursor).toBe(ids[0]);
  });

  it('a client reads their inbox over HTTP, marks a bundle read, and a bad query is a 400 naming the field', async () => {
    const requestId = await submitAs(
      atlasAdminCtx,
      atlasAdmin,
      world.northstar.projectId,
      'Over HTTP',
    );
    await notify({
      recipient: world.atlas.admin,
      objectId: requestId,
      createdAt: '2026-09-02 13:00:00.000',
    });
    const session = await signIn(world.atlas.admin.id);

    const ok = await get('/portal/inbox?mode=unread', session);
    expect(ok.statusCode, ok.body).toBe(200);
    const body = ok.json<{
      items: { requestId: string; status: string }[];
      nextCursor: string | null;
    }>();
    expect(body.items.some((bundle) => bundle.requestId === requestId)).toBe(true);
    expect(body.items.every((bundle) => bundle.status === 'submitted')).toBe(true);

    const marked = await post(
      `/portal/inbox/${encodeURIComponent(`client_request:${requestId}`)}/read`,
      session,
    );
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json<{ marked: number }>().marked).toBe(1);
    expect(await unreadCountFor(world.atlas.admin.id, requestId)).toBe(0);

    const bad = await get('/portal/inbox?mode=important&limit=0&before=abc', session);
    expect(bad.statusCode).toBe(400);
    const error = bad.json<{ error: { code: string; details: { field: string }[] } }>();
    expect(error.error.code).toBe('validation_failed');
    expect(error.error.details.map((detail) => detail.field).sort()).toEqual([
      'before',
      'limit',
      'mode',
    ]);
  });
});

describe('one authorized read for the page, not one per bundle', () => {
  class CountingRequests extends ClientRequestsRepository {
    many = 0;
    one = 0;
    override findManyByIds(
      runner: TenantQueryRunner,
      context: TenantContext,
      ids: readonly string[],
    ): Promise<readonly ClientRequestRow[]> {
      this.many += 1;
      return super.findManyByIds(runner, context, ids);
    }
    override findById(
      runner: TenantQueryRunner,
      context: TenantContext,
      id: string,
    ): Promise<ClientRequestRow | null> {
      this.one += 1;
      return super.findById(runner, context, id);
    }
  }

  it('a page of many requests costs one query, and answers exactly as getForClient would', async () => {
    // Five rows for the Atlas admin: three of their own requests, one of Meridian's — a
    // sibling client's, which the batch must leave out as `getForClient` does — and one that
    // never existed. Three bundles, one query.
    const own = [];
    for (const title of ['Batched one', 'Batched two', 'Batched three']) {
      own.push(await submitAs(atlasAdminCtx, atlasAdmin, world.northstar.projectId, title));
    }
    const siblings = await submitAs(
      meridianCtx,
      meridianReviewer,
      world.meridian.projectId,
      'Meridian’s, not Atlas’s',
    );
    const absent = uuidv7();

    for (const [index, id] of [...own, siblings, absent].entries()) {
      await notify({
        recipient: world.atlas.admin,
        objectId: id,
        createdAt: `2026-09-03 11:${String(index).padStart(2, '0')}:00.000`,
      });
    }

    const counting = new CountingRequests();
    const batched = new PortalInboxService(
      tenant,
      new ClientRequestsService(
        tenant,
        counting,
        new AuditService(tenant, new AuditEventsRepository()),
        new ProjectsRepository(),
        new WorkItemsRepository(),
        new ClientOrganizationsRepository(),
        new OutboxEventsRepository(),
      ),
      new NotificationsRepository(),
    );

    const page = await batched.list(atlasAdminCtx, atlasAdmin);
    const ids = page.items.map((bundle) => bundle.requestId);
    for (const id of own) expect(ids).toContain(id);
    expect(ids).not.toContain(siblings);
    expect(ids).not.toContain(absent);

    expect(counting.many).toBe(1);
    expect(counting.one).toBe(0);

    for (const bundle of page.items.filter((candidate) => own.includes(candidate.requestId))) {
      const single = await requests.getForClient(atlasAdminCtx, atlasAdmin, bundle.requestId);
      expect(bundle.title).toBe(single.title);
      expect(bundle.status).toBe(single.status);
      expect(bundle.projectId).toBe(single.projectId);
    }
    for (const id of [siblings, absent]) {
      await expect(requests.getForClient(atlasAdminCtx, atlasAdmin, id)).rejects.toMatchObject({
        status: 404,
      });
    }
  });
});
