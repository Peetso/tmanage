import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
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
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld, SeededUser } from './seed-two-tenants.js';
import { bootHttpHarness, reseed, signIn, stopHarness } from './support/http-harness.js';
import type { InjectedResponse } from './support/http-harness.js';

/**
 * INBOX-001's proof debt (audit 2026-10-25, gap 1): the inbox is tenant-isolated, and "mark read"
 * touches only the reader's own rows — the two promises a person relies on without seeing.
 *
 * `inbox-001-inbox.db.test.ts` proves recipient-only listing inside one tenant and that marking
 * read leaves a colleague's rows alone. What it does not try is the adversarial twin
 * (`seed-two-tenants.ts` §11: adjacent id, identical titles) on the *write* side, nor a row the
 * twin holds that is addressed to a Northstar user's id. This suite does, each case written so the
 * shipped code would fail it if the tenant predicate or the recipient predicate were dropped:
 *
 * 1. A row in the twin's tenant addressed to a Northstar user never reaches that user's inbox in
 *    Northstar, and the twin's own owner sees only the twin's row.
 * 2. Marking the twin's bundle read from Northstar is a 404 that writes nothing — in either tenant.
 * 3. A colleague who may read the object marks zero rows of somebody else's bundle.
 * 4. Over HTTP, the twin's owner marking a Northstar bundle — under Northstar's slug or under the
 *    twin's own — is refused and changes nothing.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;
let work: WorkItemsService;
let inbox: InboxService;

let ownerCtx: TenantContext;
let owner: Principal;
let designerCtx: TenantContext;
let designer: Principal;
let twinCtx: TenantContext;
let twinOwner: Principal;

const BLOCKED = 'work_item.blocked.v1';

const contextFor = (organizationId: string, user: SeededUser, role: Role): TenantContext =>
  createTenantContext({
    organizationId,
    userId: user.id,
    membershipId: user.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor(role),
    policyVersion: '2026-10-25',
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

/** One notification row, written the way the worker's `insertNotification` writes it. */
async function notify(input: {
  readonly organizationId: string;
  readonly recipientUserId: string;
  readonly objectId: string;
  readonly createdAt: string;
}): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into notifications
       (id, organization_id, recipient_user_id, type, object_type, object_id, dedupe_key, read_at, created_at)
     values (?, ?, ?, ?, 'work_item', ?, ?, null, ?)`,
    [
      id,
      input.organizationId,
      input.recipientUserId,
      BLOCKED,
      input.objectId,
      `${BLOCKED}:${input.objectId}:${id}`,
      input.createdAt,
    ],
  );
  return id;
}

/** Unread rows, read as the database administrator so no tenant filter can hide a write. */
async function unread(organizationId: string, recipientUserId: string, objectId: string) {
  const [rows] = await db.admin.query<RowDataPacket[]>(
    `select count(*) as n from notifications
      where organization_id = ? and recipient_user_id = ? and object_id = ? and read_at is null`,
    [organizationId, recipientUserId, objectId],
  );
  return Number(rows[0]?.['n']);
}

async function readRowsEverywhere(): Promise<number> {
  const [rows] = await db.admin.query<RowDataPacket[]>(
    'select count(*) as n from notifications where read_at is not null',
  );
  return Number(rows[0]?.['n']);
}

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'the_inbox_isolation_suite' }));
  world = await reseed(db);
  const tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });

  ownerCtx = contextFor(world.northstar.organizationId, world.northstar.owner, 'owner');
  owner = internalPrincipal(ownerCtx, 'owner', { projectIds: [], hasOrgWideScope: true });
  designerCtx = contextFor(world.northstar.organizationId, world.northstar.designer, 'member');
  designer = internalPrincipal(designerCtx, 'member', {
    projectIds: [world.northstar.projectId],
    hasOrgWideScope: false,
  });
  twinCtx = contextFor(world.twin.organizationId, world.twin.owner, 'owner');
  twinOwner = internalPrincipal(twinCtx, 'owner', { projectIds: [], hasOrgWideScope: true });

  const audit = new AuditService(tenant, new AuditEventsRepository());
  work = new WorkItemsService(
    tenant,
    new WorkItemsRepository(),
    audit,
    new ProjectsRepository(),
    new OutboxEventsRepository(),
  );
  const requests = new ClientRequestsService(
    tenant,
    new ClientRequestsRepository(),
    audit,
    new ProjectsRepository(),
    new WorkItemsRepository(),
    new ClientOrganizationsRepository(),
    new OutboxEventsRepository(),
  );
  inbox = new InboxService(tenant, work, requests, new NotificationsRepository());
}, 300_000);

afterAll(async () => {
  await stopHarness({ app, db });
});

describe('inbox items are tenant-isolated', () => {
  it('a twin row addressed to a Northstar user id never reaches that user in Northstar', async () => {
    const northstarItem = (
      await work.create(ownerCtx, owner, {
        projectId: world.northstar.projectId,
        title: world.northstar.workItemTitle,
      })
    ).id;
    await notify({
      organizationId: world.northstar.organizationId,
      recipientUserId: world.northstar.owner.id,
      objectId: northstarItem,
      createdAt: '2026-10-25 08:00:00.000',
    });
    // The adversarial row: the twin's tenant, the twin's identically titled item, but the
    // Northstar owner's user id as recipient.
    await notify({
      organizationId: world.twin.organizationId,
      recipientUserId: world.northstar.owner.id,
      objectId: world.twin.workItemId,
      createdAt: '2026-10-25 08:01:00.000',
    });
    await notify({
      organizationId: world.twin.organizationId,
      recipientUserId: world.twin.owner.id,
      objectId: world.twin.workItemId,
      createdAt: '2026-10-25 08:02:00.000',
    });

    const northstarPage = await inbox.list(ownerCtx, owner);
    expect(northstarPage.items.map((bundle) => bundle.objectId)).toEqual([northstarItem]);
    expect(northstarPage.items[0]?.count).toBe(1);

    const twinPage = await inbox.list(twinCtx, twinOwner);
    expect(twinPage.items.map((bundle) => bundle.objectId)).toEqual([world.twin.workItemId]);
    // One row — the twin owner's — not the stray row addressed to a Northstar user id.
    expect(twinPage.items[0]?.count).toBe(1);
  });
});

describe('mark read touches only the reader’s own rows', () => {
  it('marking the twin’s bundle from Northstar is a 404 that writes nothing in either tenant', async () => {
    const before = await readRowsEverywhere();
    await expect(
      inbox.markBundleRead(ownerCtx, owner, `work_item:${world.twin.workItemId}`),
    ).rejects.toMatchObject({ status: 404 });
    expect(await readRowsEverywhere()).toBe(before);
    expect(
      await unread(world.twin.organizationId, world.twin.owner.id, world.twin.workItemId),
    ).toBe(1);
    expect(
      await unread(world.twin.organizationId, world.northstar.owner.id, world.twin.workItemId),
    ).toBe(1);
  });

  it('a colleague who may read the object marks none of somebody else’s rows', async () => {
    const itemId = (
      await work.create(ownerCtx, owner, {
        projectId: world.northstar.projectId,
        title: 'Only the owner was told',
      })
    ).id;
    await notify({
      organizationId: world.northstar.organizationId,
      recipientUserId: world.northstar.owner.id,
      objectId: itemId,
      createdAt: '2026-10-25 09:00:00.000',
    });

    // The designer is on the project, so the object read succeeds — and the recipient predicate
    // is all that stands between them and the owner's row.
    const result = await inbox.markBundleRead(designerCtx, designer, `work_item:${itemId}`);
    expect(result).toEqual({ bundleId: `work_item:${itemId}`, marked: 0 });
    expect(await unread(world.northstar.organizationId, world.northstar.owner.id, itemId)).toBe(1);

    // The owner's own mark still works afterwards: the colleague's attempt consumed nothing.
    const own = await inbox.markBundleRead(ownerCtx, owner, `work_item:${itemId}`);
    expect(own.marked).toBe(1);
  });

  it('over HTTP, the twin’s owner cannot mark a Northstar bundle under either slug', async () => {
    const itemId = (
      await work.create(ownerCtx, owner, {
        projectId: world.northstar.projectId,
        title: 'Marked over HTTP by the wrong tenant',
      })
    ).id;
    await notify({
      organizationId: world.northstar.organizationId,
      recipientUserId: world.northstar.owner.id,
      objectId: itemId,
      createdAt: '2026-10-25 10:00:00.000',
    });
    const before = await readRowsEverywhere();
    const session = await signIn(app, world.twin.owner.id);
    const bundle = encodeURIComponent(`work_item:${itemId}`);

    for (const slug of ['northstar-studio', 'northstar-studios']) {
      const response = (await app.inject({
        method: 'POST',
        url: `/v1/organizations/${slug}/inbox/${bundle}/read`,
        headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
      })) as unknown as InjectedResponse;
      expect([403, 404], `${slug}: ${response.body}`).toContain(response.statusCode);
    }

    expect(await readRowsEverywhere()).toBe(before);
    expect(await unread(world.northstar.organizationId, world.northstar.owner.id, itemId)).toBe(1);
  });
});
