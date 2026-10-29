import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { authorize, capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { DEFAULT_CONTENT_PURGE_DAYS } from '../src/common/database/content-retention.js';
import { DocumentsRepository } from '../src/modules/docs/documents.repository.js';
import { WorkItemsRepository } from '../src/modules/work/work-items.repository.js';
import { WorkCommentsRepository } from '../src/modules/work/work-comments.repository.js';
import { ConversationsRepository } from '../src/modules/conversations/conversations.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * platform-admin v2 · PA-03 (0245, SPEC P7) — content soft delete on the real migrated MariaDB.
 *
 * Pins: the four soft-delete columns and both keys on all twenty content tables; a soft-deleted
 * message, work item and document leave their list read but stay readable by id (the restore
 * path); a second delete changes nothing; the append-only comment trigger refuses a body edit while
 * admitting the soft-delete columns; and the worker's purge statements remove only rows whose
 * `purge_after` has passed, one organization per DELETE.
 *
 * Dates are bound values, never the admin connection's clock (its time zone is SYSTEM).
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let northstar: TenantContext;

const documents = new DocumentsRepository();
const workItems = new WorkItemsRepository();
const comments = new WorkCommentsRepository();
const conversations = new ConversationsRepository();

const HERE = dirname(fileURLToPath(import.meta.url));
const PAST = new Date('2001-01-01T00:00:00.000Z');
const FUTURE = new Date('2999-01-01T00:00:00.000Z');

const CONTENT_TABLES = [
  'messages',
  'direct_conversations',
  'direct_messages',
  'message_attachments',
  'work_items',
  'work_item_comments',
  'work_item_files',
  'documents',
  'document_comments',
  'decisions',
  'decision_comments',
  'meetings',
  'meeting_attachments',
  'request_messages',
  'request_comments',
  'file_assets',
  'file_comments',
  'project_update_comments',
  'google_drive_attachments',
  'onedrive_attachments',
] as const;

/** The worker's purge statements, loaded at runtime (the api typecheck root is apps/api). */
interface PurgeStatements {
  listDueContent(
    tx: { query<T>(sql: string, params?: readonly unknown[]): Promise<T> },
    table: string,
    limit: number,
  ): Promise<readonly { organizationId: string; id: string }[]>;
  deleteDueContent(
    tx: { query<T>(sql: string, params?: readonly unknown[]): Promise<T> },
    table: string,
    organizationId: string,
    ids: readonly string[],
  ): Promise<{ deleted: number; blocked: number }>;
}

const adminTx = () => ({
  query: async <T>(sql: string, params: readonly unknown[] = []): Promise<T> => {
    const [result] = await db.admin.query(sql, [...params]);
    return result as T;
  },
});

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  northstar = createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: world.northstar.owner.id,
    membershipId: world.northstar.owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-16',
    correlationId: uuidv7(),
  });
}, 300_000);

afterAll(async () => {
  await db?.stop();
});

describe('0245 columns and keys', () => {
  it('adds deleted_at, deleted_by_user_id, deleted_reason and purge_after to all 20 tables', async () => {
    const [rows] = await db.admin.query<RowDataPacket[]>(
      `select table_name as t, column_name as c from information_schema.columns
        where table_schema = database()
          and column_name in ('deleted_at', 'deleted_by_user_id', 'deleted_reason', 'purge_after')`,
    );
    for (const table of CONTENT_TABLES) {
      const columns = rows.filter((row) => row['t'] === table).map((row) => String(row['c']));
      expect(columns.sort(), table).toEqual([
        'deleted_at',
        'deleted_by_user_id',
        'deleted_reason',
        'purge_after',
      ]);
    }
  });

  it('keys every table by (organization_id, deleted_at) and by purge_after', async () => {
    const [rows] = await db.admin.query<RowDataPacket[]>(
      `select table_name as t, index_name as i, group_concat(column_name order by seq_in_index) as c
         from information_schema.statistics
        where table_schema = database() and index_name like 'ix\\_%'
        group by table_name, index_name`,
    );
    for (const table of CONTENT_TABLES) {
      const own = rows.filter((row) => row['t'] === table);
      expect(
        own.find((row) => row['i'] === `ix_${table}_org_deleted`)?.['c'],
        `${table} org_deleted`,
      ).toBe('organization_id,deleted_at');
      expect(own.find((row) => row['i'] === `ix_${table}_purge`)?.['c'], `${table} purge`).toBe(
        'purge_after',
      );
    }
  });
});

describe('a soft-deleted row leaves the list but stays readable by id', () => {
  it('work item: carries who, why and a 30-day window; a second delete changes nothing', async () => {
    const id = world.northstar.workItemId;
    await tenant.transaction(northstar, (tx) =>
      workItems.softDelete(tx, northstar, id, 'Created by mistake'),
    );

    const listed = await tenant.read(northstar, (tx) =>
      workItems.list(tx, northstar, { projectId: world.northstar.projectId }),
    );
    expect(listed.map((row) => row.id)).not.toContain(id);
    const found = await tenant.read(northstar, (tx) => workItems.findById(tx, northstar, id));
    expect(found?.deletedAt).toBeInstanceOf(Date);
    expect(found?.deletedByUserId).toBe(northstar.userId);
    expect(found?.deletedReason).toBe('Created by mistake');

    // The row read by id carries its lifecycle: authorize() refuses a write and still lets an
    // internal member read it (the restore path), exactly as services map `deletedAt`.
    const owner: Principal = {
      userId: northstar.userId,
      organizationId: northstar.organizationId,
      kind: 'internal',
      role: 'owner',
      membershipId: northstar.membershipId,
      membershipStatus: 'active',
      clientOrganizationId: null,
      projectIds: [world.northstar.projectId],
      hasOrgWideScope: true,
    };
    const resource = {
      organizationId: northstar.organizationId,
      projectId: world.northstar.projectId,
      audience: found?.audience ?? 'internal',
      lifecycle: found?.deletedAt ? ('soft_deleted' as const) : ('active' as const),
    };
    const write = authorize({ principal: owner, capability: 'work.update', resource });
    expect(write.allowed).toBe(false);
    expect(write.allowed ? null : write.code).toBe('resource_not_active');
    expect(authorize({ principal: owner, capability: 'work.read', resource }).allowed).toBe(true);

    const [window] = await db.admin.query<RowDataPacket[]>(
      'select timestampdiff(day, deleted_at, purge_after) as d from work_items where id = ?',
      [id],
    );
    expect(Number(window[0]?.['d'])).toBe(DEFAULT_CONTENT_PURGE_DAYS);

    // Deleting twice is a no-op: it neither restarts the restore window nor rewrites who or why.
    const again = await tenant.transaction(northstar, (tx) =>
      workItems.softDelete(tx, northstar, id, 'Second reason'),
    );
    expect(again.version).toBe(found?.version);
    expect(again.deletedReason).toBe('Created by mistake');
    expect(again.purgeAfter?.getTime()).toBe(found?.purgeAfter?.getTime());
  });

  it('document: hidden from the list, still found by id', async () => {
    const created = await tenant.transaction(northstar, (tx) =>
      documents.create(tx, northstar, {
        projectId: world.northstar.projectId,
        title: 'PA-03 brief',
        body: 'body',
        createdByUserId: northstar.userId,
      }),
    );
    await db.admin.query(
      `update documents set deleted_at = ?, deleted_by_user_id = ?, purge_after = ?
        where organization_id = ? and id = ?`,
      [new Date(), northstar.userId, FUTURE, northstar.organizationId, created.id],
    );
    const listed = await tenant.read(northstar, (tx) =>
      documents.list(tx, northstar, { projectId: world.northstar.projectId }),
    );
    expect(listed.map((row) => row.id)).not.toContain(created.id);
    const withDeleted = await tenant.read(northstar, (tx) =>
      documents.list(tx, northstar, { projectId: world.northstar.projectId, includeDeleted: true }),
    );
    expect(withDeleted.map((row) => row.id)).toContain(created.id);
    const found = await tenant.read(northstar, (tx) =>
      documents.findById(tx, northstar, created.id),
    );
    expect(found?.id).toBe(created.id);
  });

  it('message: a moderated message leaves the timeline, still found by id', async () => {
    const channel = await tenant.transaction(northstar, (tx) =>
      conversations.create(tx, northstar, {
        projectId: world.northstar.projectId,
        name: `pa03-${uuidv7().slice(-6)}`,
        createdByUserId: northstar.userId,
      }),
    );
    const message = await tenant.transaction(northstar, (tx) =>
      conversations.appendMessage(tx, northstar, {
        conversationId: channel.id,
        authorUserId: northstar.userId,
        body: 'to be moderated',
      }),
    );
    await tenant.transaction(northstar, (tx) =>
      conversations.moderateMessage(tx, northstar, message.id, northstar.userId, 'Spam'),
    );
    const listed = await tenant.read(northstar, (tx) =>
      conversations.listMessages(tx, northstar, channel.id),
    );
    expect(listed.map((row) => row.id)).not.toContain(message.id);
    const found = await tenant.read(northstar, (tx) =>
      conversations.findMessageById(tx, northstar, message.id),
    );
    expect(found?.deletedReason).toBe('Spam');
    expect(found?.purgeAfter).toBeInstanceOf(Date);
  });
});

describe('the append-only comment trigger', () => {
  it('refuses a body edit and admits the soft-delete columns', async () => {
    const comment = await tenant.transaction(northstar, (tx) =>
      comments.create(tx, northstar, {
        workItemId: world.northstar.workItemId,
        authorMembershipId: northstar.membershipId,
        body: 'original',
      }),
    );
    await expect(
      db.admin.query('update work_item_comments set body = ? where id = ?', ['edited', comment.id]),
    ).rejects.toThrow();
    await db.admin.query(
      'update work_item_comments set deleted_at = ?, deleted_reason = ?, purge_after = ? where id = ?',
      [new Date(), 'Off topic', PAST, comment.id],
    );
    const listed = await tenant.read(northstar, (tx) =>
      comments.listForWorkItem(tx, northstar, comment.workItemId),
    );
    expect(listed.map((row) => row.id)).not.toContain(comment.id);
  });
});

describe('the worker purge statements', () => {
  it('remove only rows past purge_after, one organization per delete, idempotently', async () => {
    const statements = (await import(
      pathToFileURL(resolve(HERE, '../../worker/src/common/database/content-purge-store.ts')).href
    )) as PurgeStatements;

    const due = await tenant.transaction(northstar, (tx) =>
      documents.create(tx, northstar, {
        projectId: world.northstar.projectId,
        title: 'Past its window',
        body: 'b',
        createdByUserId: northstar.userId,
      }),
    );
    const waiting = await tenant.transaction(northstar, (tx) =>
      documents.create(tx, northstar, {
        projectId: world.northstar.projectId,
        title: 'Inside its window',
        body: 'b',
        createdByUserId: northstar.userId,
      }),
    );
    const live = await tenant.transaction(northstar, (tx) =>
      documents.create(tx, northstar, {
        projectId: world.northstar.projectId,
        title: 'Not deleted',
        body: 'b',
        createdByUserId: northstar.userId,
      }),
    );
    await db.admin.query('update documents set deleted_at = ?, purge_after = ? where id = ?', [
      PAST,
      PAST,
      due.id,
    ]);
    await db.admin.query('update documents set deleted_at = ?, purge_after = ? where id = ?', [
      PAST,
      FUTURE,
      waiting.id,
    ]);
    // A purge_after on a row that is not deleted never makes it due.
    await db.admin.query('update documents set purge_after = ? where id = ?', [PAST, live.id]);

    const rows = await statements.listDueContent(adminTx(), 'documents', 500);
    expect(rows.map((row) => row.id)).toEqual([due.id]);
    const result = await statements.deleteDueContent(
      adminTx(),
      'documents',
      northstar.organizationId,
      rows.map((row) => row.id),
    );
    expect(result).toEqual({ deleted: 1, blocked: 0 });

    // The wrong organization deletes nothing even for a due id.
    const [left] = await db.admin.query<RowDataPacket[]>(
      'select id from documents where id in (?, ?, ?)',
      [due.id, waiting.id, live.id],
    );
    expect(left.map((row) => String(row['id'])).sort()).toEqual([waiting.id, live.id].sort());

    expect(await statements.listDueContent(adminTx(), 'documents', 500)).toEqual([]);
    expect(
      await statements.deleteDueContent(adminTx(), 'documents', world.twin.organizationId, [
        waiting.id,
      ]),
    ).toEqual({ deleted: 0, blocked: 0 });
  });
});
