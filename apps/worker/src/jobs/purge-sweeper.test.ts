import { describe, expect, it } from 'vitest';
import { CONTENT_PURGE_TABLES, PURGE_HOOKS, runPurge } from './purge-sweeper.js';
import type { ContentPurgeStore, PurgeHook } from './purge-sweeper.js';
import { deleteDueContent, listDueContent } from '../common/database/content-purge-store.js';
import type { WorkerDatabase, WorkerTransaction } from '../common/database/worker-database.js';

/**
 * platform-admin v2 · PA-03 (0245): the content purge. The job runs against an in-memory store
 * whose rows carry a `purgeAfter` against a fixed "now"; the store's statements run against a
 * recording fake transaction. MariaDB itself is content-010-soft-delete.db.test.ts.
 */

interface MemoryRow {
  readonly table: string;
  readonly organizationId: string;
  readonly id: string;
  readonly deleted: boolean;
  readonly purgeAfter: number;
  readonly referenced?: boolean;
}

const NOW = 1_000;

function memoryStore(rows: MemoryRow[]) {
  const deletes: { table: string; organizationId: string; ids: readonly string[] }[] = [];
  const store: ContentPurgeStore = {
    listDue: async (table, limit) =>
      rows
        .filter((row) => row.table === table && row.deleted && row.purgeAfter <= NOW)
        .sort((a, b) => a.purgeAfter - b.purgeAfter)
        .slice(0, limit)
        .map(({ organizationId, id }) => ({ organizationId, id })),
    deleteDue: async (table, organizationId, ids) => {
      deletes.push({ table, organizationId, ids });
      let deleted = 0;
      let blocked = 0;
      for (const id of ids) {
        const index = rows.findIndex(
          (row) =>
            row.table === table &&
            row.organizationId === organizationId &&
            row.id === id &&
            row.deleted &&
            row.purgeAfter <= NOW,
        );
        if (index === -1) continue;
        if (rows[index]?.referenced === true) {
          blocked += 1;
          continue;
        }
        rows.splice(index, 1);
        deleted += 1;
      }
      return { deleted, blocked };
    },
  };
  return { store, deletes };
}

const database = {} as WorkerDatabase;

describe('PA-03 content purge', () => {
  it('removes only soft-deleted rows past purge_after, one organization per delete', async () => {
    const rows: MemoryRow[] = [
      { table: 'messages', organizationId: 'org-a', id: 'm-due', deleted: true, purgeAfter: 900 },
      { table: 'messages', organizationId: 'org-b', id: 'm-due-b', deleted: true, purgeAfter: 950 },
      {
        table: 'messages',
        organizationId: 'org-a',
        id: 'm-window',
        deleted: true,
        purgeAfter: 1_500,
      },
      { table: 'messages', organizationId: 'org-a', id: 'm-live', deleted: false, purgeAfter: 0 },
      { table: 'documents', organizationId: 'org-a', id: 'd-due', deleted: true, purgeAfter: 10 },
    ];
    const { store, deletes } = memoryStore(rows);

    const report = await runPurge(database, [], { store });

    expect(report.deleted).toBe(3);
    expect(report.blocked).toBe(0);
    expect(rows.map((row) => row.id).sort()).toEqual(['m-live', 'm-window']);
    for (const call of deletes) {
      expect(new Set(call.ids).size).toBe(call.ids.length);
    }
    expect(deletes.filter((call) => call.table === 'messages')).toEqual([
      { table: 'messages', organizationId: 'org-a', ids: ['m-due'] },
      { table: 'messages', organizationId: 'org-b', ids: ['m-due-b'] },
    ]);
  });

  it('takes at most one batch per table per run and the rest on the next', async () => {
    const rows: MemoryRow[] = Array.from({ length: 7 }, (_, index) => ({
      table: 'work_item_comments',
      organizationId: 'org-a',
      id: `c-${String(index)}`,
      deleted: true,
      purgeAfter: index,
    }));
    const { store } = memoryStore(rows);

    const first = await runPurge(database, [], { store, batch: 3 });
    expect(first.deleted).toBe(3);
    expect(rows).toHaveLength(4);
    const second = await runPurge(database, [], { store, batch: 3 });
    expect(second.deleted).toBe(3);
    const third = await runPurge(database, [], { store, batch: 3 });
    expect(third.deleted).toBe(1);
    expect(rows).toHaveLength(0);
  });

  it('is idempotent: a second run with nothing due deletes nothing', async () => {
    const rows: MemoryRow[] = [
      { table: 'decisions', organizationId: 'org-a', id: 'x', deleted: true, purgeAfter: 1 },
    ];
    const { store } = memoryStore(rows);
    expect((await runPurge(database, [], { store })).deleted).toBe(1);
    const again = await runPurge(database, [], { store });
    expect(again.deleted).toBe(0);
    expect(again.blocked).toBe(0);
  });

  it('counts a row a live row still references as blocked and keeps it', async () => {
    const rows: MemoryRow[] = [
      {
        table: 'work_items',
        organizationId: 'org-a',
        id: 'w',
        deleted: true,
        purgeAfter: 1,
        referenced: true,
      },
    ];
    const { store } = memoryStore(rows);
    const report = await runPurge(database, [], { store });
    expect(report).toMatchObject({ deleted: 0, blocked: 1 });
    expect(rows).toHaveLength(1);
  });

  it('purges children before their parents and leaves file_assets to the file purge', () => {
    const order = (table: string) => CONTENT_PURGE_TABLES.indexOf(table);
    expect(order('message_attachments')).toBeLessThan(order('messages'));
    expect(order('direct_messages')).toBeLessThan(order('direct_conversations'));
    expect(order('work_item_comments')).toBeLessThan(order('work_items'));
    expect(order('work_item_files')).toBeLessThan(order('work_items'));
    expect(order('document_comments')).toBeLessThan(order('documents'));
    expect(order('decision_comments')).toBeLessThan(order('decisions'));
    expect(order('meeting_attachments')).toBeLessThan(order('meetings'));
    expect(order('review_comments')).toBeLessThan(order('review_threads'));
    expect(CONTENT_PURGE_TABLES).toHaveLength(21);
    expect(CONTENT_PURGE_TABLES).not.toContain('file_assets');
  });

  it('runs every hook after the tables, with the database, and reports what each removed', async () => {
    const seen: string[] = [];
    const hook: PurgeHook = {
      name: 'organization-purge',
      run: async (given) => {
        expect(given).toBe(database);
        seen.push('hook');
        return 2;
      },
    };
    const { store } = memoryStore([]);
    const report = await runPurge(database, [hook], { store, tables: ['messages'] });
    expect(seen).toEqual(['hook']);
    expect(report.hooks).toEqual([{ name: 'organization-purge', removed: 2 }]);
    expect(PURGE_HOOKS).toEqual([]);
  });
});

describe('PA-03 content purge store statements', () => {
  function recordingTx(answer: (sql: string, params: readonly unknown[]) => unknown) {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const tx: WorkerTransaction = {
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        return answer(sql, params) as T;
      },
    };
    return { tx, calls };
  }

  it('reads due rows by the database clock, oldest first, bounded', async () => {
    const { tx, calls } = recordingTx(() => [{ organization_id: 'org-a', id: 'r1' }]);
    const rows = await listDueContent(tx, 'messages', 500);
    expect(rows).toEqual([{ organizationId: 'org-a', id: 'r1' }]);
    expect(calls[0]?.sql).toMatch(/FROM messages/);
    expect(calls[0]?.sql).toMatch(/deleted_at IS NOT NULL/);
    expect(calls[0]?.sql).toMatch(/purge_after <= current_timestamp\(3\)/);
    expect(calls[0]?.sql).toMatch(/LIMIT 500/);
  });

  it('deletes one organization at a time and repeats the purge predicate', async () => {
    const { tx, calls } = recordingTx(() => ({ affectedRows: 2 }));
    const result = await deleteDueContent(tx, 'documents', 'org-a', ['d1', 'd2']);
    expect(result).toEqual({ deleted: 2, blocked: 0 });
    expect(calls[0]?.sql).toMatch(/DELETE FROM documents/);
    expect(calls[0]?.sql).toMatch(/organization_id = \? AND id IN \(\?, \?\)/);
    expect(calls[0]?.sql).toMatch(/purge_after <= current_timestamp\(3\)/);
    expect(calls[0]?.params).toEqual(['org-a', 'd1', 'd2']);
  });

  it('falls back row by row on errno 1451 and counts the referenced row as blocked', async () => {
    const referenced = Object.assign(new Error('referenced'), { errno: 1451 });
    const { tx, calls } = recordingTx((_sql, params) => {
      if (params.length > 2 || params[1] === 'w1') throw referenced;
      return { affectedRows: 1 };
    });
    const result = await deleteDueContent(tx, 'work_items', 'org-a', ['w1', 'w2']);
    expect(result).toEqual({ deleted: 1, blocked: 1 });
    expect(calls).toHaveLength(3);
  });

  it('rethrows any other error and refuses an unexpected table name', async () => {
    const { tx } = recordingTx(() => {
      throw Object.assign(new Error('gone'), { errno: 2013 });
    });
    await expect(deleteDueContent(tx, 'messages', 'org-a', ['m'])).rejects.toThrow('gone');
    await expect(listDueContent(tx, 'messages; DROP TABLE x', 1)).rejects.toThrow(/refusing/);
  });
});
