import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { ApiError } from '../src/common/http/errors.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { MeetingsService } from '../src/modules/calendar/meetings.service.js';
import { ConversationsRepository } from '../src/modules/conversations/conversations.repository.js';
import { DecisionsService } from '../src/modules/decisions/decisions.service.js';
import { DocumentsService } from '../src/modules/docs/documents.service.js';
import { ContentListsRepository } from '../src/modules/platform-admin/content/content-lists.repository.js';
import { PlatformContentService } from '../src/modules/platform-admin/content/content.service.js';
import type { ContentOrgPorts } from '../src/modules/platform-admin/content/content.service.js';
import { SupportContextResolver } from '../src/modules/platform-admin/content/support-context.js';
import type { PlatformAdminActor } from '../src/modules/platform-admin/platform-admin.guard.js';
import { PlatformAuditService } from '../src/modules/platform-admin/platform-audit.service.js';
import { SupportSessionService } from '../src/modules/platform-admin/support/support-session.service.js';
import { OutboxEventsRepository } from '../src/modules/platform/outbox-events.repository.js';
import { ProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { MembershipResolver } from '../src/modules/tenancy/membership-resolver.repository.js';
import { PrincipalRepository } from '../src/modules/tenancy/principal.repository.js';
import { WorkItemsRepository } from '../src/modules/work/work-items.repository.js';
import { WorkItemsService } from '../src/modules/work/work-items.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PLAT-018 against a real server — Content moderation (platform-admin v2, PA-08, SPEC §5.4 /
 * B5–B7), with the tenant guard enforcing.
 *
 * 1. Every read is refused with 428 `support_session_required` until a support session is live.
 * 2. With a session, the browser sees the organization's channel and its message, and nothing of
 *    the twin tenant.
 * 3. Editing a message records `message.edited` with before/after, stamped with the support
 *    session and the admin as the effective actor, and `platform.content_edited`.
 * 4. Deleting without a reason changes nothing; with one it soft-deletes (deleted_* set,
 *    `work_item.deleted`, `platform.content_deleted`), and the item shows on the trash list as
 *    deleted via support.
 * 5. Restore clears deleted_* and records `work_item.restored`.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let support: SupportSessionService;
let content: PlatformContentService;
const BROWSER = uuidv7();
const conversationId = uuidv7();
const messageId = uuidv7();
const twinConversationId = uuidv7();
let sessionId = '';

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

const actor = (): PlatformAdminActor => ({
  account: {
    userId: world.platformAdmin.id,
    email: world.platformAdmin.email,
    displayName: 'Platform',
    emailVerified: true,
    mfaEnabled: false,
  },
  sessionId: BROWSER,
  stepUp: { expiresAt: new Date(Date.now() + 10 * 60_000), mfaVerified: false },
  permissions: ['platform.orgs.enter', 'platform.content.view', 'platform.content.moderate'],
});

const request = () => ({
  correlationId: uuidv7(),
  request: { ip: '203.0.113.18', headers: { 'user-agent': 'vitest-plat-018' } },
});

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

async function seedConversation(
  organizationId: string,
  projectId: string,
  ownerId: string,
  id: string,
  body: string,
  message: string,
) {
  await db.admin.query(
    `insert into conversations (id, organization_id, project_id, name, created_by_user_id)
     values (?, ?, ?, 'support-desk', ?)`,
    [id, organizationId, projectId, ownerId],
  );
  await db.admin.query(
    `insert into messages (id, organization_id, conversation_id, author_user_id, sequence_no, body)
     values (?, ?, ?, ?, 1, ?)`,
    [message, organizationId, id, ownerId, body],
  );
  await db.admin.query('update conversations set next_sequence_no = 2 where id = ?', [id]);
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  const platformAudit = new PlatformAuditService(tenant);
  support = new SupportSessionService(tenant, platformAudit);
  const audit = new AuditService(tenant, new AuditEventsRepository());
  const workItemsRepository = new WorkItemsRepository();
  const org: ContentOrgPorts = {
    messages: new ConversationsRepository(),
    workItemsRepository,
    workItems: new WorkItemsService(
      tenant,
      workItemsRepository,
      audit,
      new ProjectsRepository(),
      new OutboxEventsRepository(),
    ) as unknown as ContentOrgPorts['workItems'],
    documents: new DocumentsService(tenant),
    decisions: new DecisionsService(tenant),
    meetings: new MeetingsService(tenant),
    downloads: {} as ContentOrgPorts['downloads'],
  };
  content = new PlatformContentService(
    tenant,
    new SupportContextResolver(tenant, new MembershipResolver(tenant), new PrincipalRepository()),
    new ContentListsRepository(),
    audit,
    platformAudit,
    org,
  );
  await seedConversation(
    world.northstar.organizationId,
    world.northstar.projectId,
    world.northstar.owner.id,
    conversationId,
    'please call me on my private number',
    messageId,
  );
  await seedConversation(
    world.twin.organizationId,
    world.twin.projectId,
    world.twin.owner.id,
    twinConversationId,
    'twin secret',
    uuidv7(),
  );
}, 300_000);

afterAll(async () => {
  await db?.stop();
});

describe('Content moderation (PLAT-018)', () => {
  it('refuses every read with 428 until a support session is live', async () => {
    const error = await refusal(content.home(actor(), world.northstar.organizationId, request()));
    expect(error.status).toBe(428);
    expect(error.code).toBe('support_session_required');
    const list = await refusal(
      content.list(actor(), world.northstar.organizationId, 'chats', {}, request()),
    );
    expect(list.status).toBe(428);
  });

  it('browses the organization in a session and sees nothing of the twin', async () => {
    const started = await support.start(
      actor(),
      world.northstar.organizationId,
      { minutes: 120, reason: 'Owner asked us to remove a message' },
      { correlationId: uuidv7(), ip: '203.0.113.18', userAgent: 'vitest-plat-018' },
    );
    sessionId = started.id;
    const home = await content.home(actor(), world.northstar.organizationId, request());
    expect(home.session.id).toBe(sessionId);
    expect(home.counts.chats).toBe(1);
    expect(home.counts.workItems).toBeGreaterThanOrEqual(1);

    const chats = await content.list(
      actor(),
      world.northstar.organizationId,
      'chats',
      {},
      request(),
    );
    expect(chats.rows.map((row) => row.id)).toEqual([conversationId]);

    const messages = await content.messages(
      actor(),
      world.northstar.organizationId,
      conversationId,
      {},
      request(),
    );
    expect(messages.messages.map((row) => row.id)).toEqual([messageId]);

    const twin = await content.messages(
      actor(),
      world.northstar.organizationId,
      twinConversationId,
      {},
      request(),
    );
    expect(twin.messages).toHaveLength(0);
  });

  it('edits a message with before/after, stamped with the support session', async () => {
    const written = await content.edit(
      actor(),
      world.northstar.organizationId,
      'message',
      messageId,
      { body: 'please call me (number removed by support)', reason: 'Owner request #4821' },
      request(),
    );
    expect(written.item.edited).toBe(true);
    const [row] = await observe('select body from messages where id = ?', [messageId]);
    expect(row?.['body']).toBe('please call me (number removed by support)');

    const events = await observe(
      `select id, effective_actor_id, platform_support_session_id from audit_events
        where organization_id = ? and action = 'message.edited' and object_id = ?`,
      [world.northstar.organizationId, messageId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.['effective_actor_id']).toBe(world.platformAdmin.id);
    expect(events[0]?.['platform_support_session_id']).toBe(sessionId);
    const changes = await observe(
      'select field from audit_event_changes where organization_id = ? and audit_event_id = ?',
      [world.northstar.organizationId, events[0]?.['id']],
    );
    expect(changes.map((c) => c['field'])).toContain('body');
    const platform = await observe(
      `select count(*) as n from platform_admin_audit_events
        where action = 'platform.content_edited' and target_id = ?`,
      [messageId],
    );
    expect(Number(platform[0]?.['n'])).toBe(1);
  });

  it('refuses a delete without a reason and changes nothing', async () => {
    const error = await refusal(
      content.remove(
        actor(),
        world.northstar.organizationId,
        'work_item',
        world.northstar.workItemId,
        {},
        request(),
      ),
    );
    expect(error.status).toBe(400);
    const [row] = await observe('select deleted_at from work_items where id = ?', [
      world.northstar.workItemId,
    ]);
    expect(row?.['deleted_at']).toBeNull();
  });

  it('soft-deletes with a reason, lists it in the trash as via support, and restores it', async () => {
    const orgId = world.northstar.organizationId;
    const itemId = world.northstar.workItemId;
    const removed = await content.remove(
      actor(),
      orgId,
      'work_item',
      itemId,
      { reason: 'Duplicate created by mistake' },
      request(),
    );
    expect(removed.item.deletedAt).not.toBeNull();
    const [row] = await observe(
      'select deleted_at, deleted_reason, deleted_by_user_id, purge_after from work_items where id = ?',
      [itemId],
    );
    expect(row?.['deleted_at']).not.toBeNull();
    expect(row?.['deleted_reason']).toBe('Duplicate created by mistake');
    expect(row?.['purge_after']).not.toBeNull();

    const deletedEvents = await observe(
      `select effective_actor_id, platform_support_session_id from audit_events
        where organization_id = ? and action = 'work_item.deleted' and object_id = ?`,
      [orgId, itemId],
    );
    expect(deletedEvents).toHaveLength(1);
    expect(deletedEvents[0]?.['effective_actor_id']).toBe(world.platformAdmin.id);
    expect(deletedEvents[0]?.['platform_support_session_id']).toBe(sessionId);

    const trash = await content.trash(actor(), orgId, { supportOnly: 'true' }, request());
    const listed = trash.rows.find((r) => r.id === itemId);
    expect(listed?.deletedViaSupport).toBe(true);
    expect(trash.purgeDays).toBeGreaterThan(0);

    const restored = await content.restore(actor(), orgId, 'work_item', itemId, {}, request());
    expect(restored.item.deletedAt).toBeNull();
    const [after] = await observe(
      'select deleted_at, deleted_reason from work_items where id = ?',
      [itemId],
    );
    expect(after?.['deleted_at']).toBeNull();
    expect(after?.['deleted_reason']).toBeNull();
    const restoredEvents = await observe(
      `select count(*) as n from audit_events
        where organization_id = ? and action = 'work_item.restored' and object_id = ?`,
      [orgId, itemId],
    );
    expect(Number(restoredEvents[0]?.['n'])).toBe(1);
    const empty = await content.trash(actor(), orgId, {}, request());
    expect(empty.rows.find((r) => r.id === itemId)).toBeUndefined();
  });
});
