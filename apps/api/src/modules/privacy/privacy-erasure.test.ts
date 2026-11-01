import { describe, expect, it } from 'vitest';
import type { ObjectStore } from '@tmanage/storage';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PrivacyDeletionRequestRow } from '../../common/database/schema.js';
import { TENANT_TABLES } from '../../common/database/tenant-guard.js';
import type { AuditService } from '../audit/audit.service.js';
import { CompanyErasure, RETAINED_TABLES, erasableTables } from './privacy-erasure.repository.js';
import type { ErasureOutcome } from './privacy-erasure.repository.js';
import { ERASURE_DELAY_MS, PrivacyPass } from './privacy-job.js';
import type { PrivacyRepository } from './privacy.repository.js';

/**
 * H3 (audit gap 3) — the erasure after a company deletion, over fakes only: an in-memory "database"
 * of row counts per table with foreign-key rules, and a recording object store. No live data, no
 * server: every delete here is a counter going down.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const context = { organizationId: ORG, correlationId: 'c' } as unknown as TenantContext;
const NOW = new Date('2026-10-25T13:05:00.000Z');

interface FakeOptions {
  /** Rows per table for ORG. */
  readonly rows: Record<string, number>;
  /** child → parents it references: a parent cannot lose rows while the child has any. */
  readonly references?: Record<string, readonly string[]>;
  /** Tables whose deletes a trigger refuses / the credential may not run. */
  readonly refused?: readonly string[];
  readonly denied?: readonly string[];
  readonly fileKeys?: readonly string[];
  /** R4 slice 2: `file_previews.object_key` values (NULL for a derivative never written). */
  readonly previewKeys?: readonly (string | null)[];
}

function fakeDatabase(options: FakeOptions) {
  const rows = new Map(Object.entries(options.rows));
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const error = (errno: number) => Object.assign(new Error(`errno ${String(errno)}`), { errno });
  const runner = {
    execute: (sql: string, params: readonly unknown[]) => {
      statements.push({ sql, params });
      const match = /^delete from `([a-z0-9_]+)` where organization_id = \? limit (\d+)$/u.exec(
        sql,
      );
      if (!match) throw new Error(`unexpected statement: ${sql}`);
      const table = match[1] as string;
      const limit = Number(match[2]);
      if (params[0] !== ORG) return Promise.resolve({ affectedRows: 0 });
      if (!rows.has(table)) return Promise.reject(error(1146));
      if (options.refused?.includes(table)) return Promise.reject(error(1644));
      if (options.denied?.includes(table)) return Promise.reject(error(1142));
      const children = Object.entries(options.references ?? {})
        .filter(([, parents]) => parents.includes(table))
        .map(([child]) => child);
      if ((rows.get(table) ?? 0) > 0 && children.some((child) => (rows.get(child) ?? 0) > 0)) {
        return Promise.reject(error(1451));
      }
      const deleted = Math.min(limit, rows.get(table) ?? 0);
      rows.set(table, (rows.get(table) ?? 0) - deleted);
      return Promise.resolve({ affectedRows: deleted });
    },
    query: (sql: string, params: readonly unknown[]) => {
      statements.push({ sql, params });
      if (sql.includes('from `file_previews`') && params[1] === '') {
        return Promise.resolve(
          (options.previewKeys ?? []).map((key, index) => ({
            id: `p${String(index)}`,
            object_key: key,
          })),
        );
      }
      if (!sql.includes('from `file_versions`') || params[1] !== '') return Promise.resolve([]);
      return Promise.resolve(
        (options.fileKeys ?? []).map((key, index) => ({
          id: `v${String(index)}`,
          object_key: key,
        })),
      );
    },
  };
  const database = {
    read: (_c: unknown, fn: (r: unknown) => unknown) => fn(runner),
    transaction: (_c: unknown, fn: (r: unknown) => unknown) => fn(runner),
  } as unknown as TenantDatabase;
  return { database, rows, statements };
}

function recordingStore() {
  const removed: string[] = [];
  const store = {
    remove: (input: { zone: string; objectKey: string }) => {
      removed.push(`${input.zone}:${input.objectKey}`);
      return Promise.resolve();
    },
  } as unknown as Pick<ObjectStore, 'remove'>;
  return { store, removed };
}

const SMALL = { batchRows: 2, maxRowsPerRun: 1_000 };

describe('Company erasure — which tables', () => {
  it('empties every tenant table except the audit trail, the privacy records and the org row', () => {
    const tables = erasableTables();
    expect(tables).toContain('work_items');
    expect(tables).toContain('messages');
    expect(tables).toContain('file_versions');
    expect(tables).toContain('portal_access_log');
    for (const kept of RETAINED_TABLES) expect(tables).not.toContain(kept);
    const tenantWide = Object.entries(TENANT_TABLES).filter(([, c]) => c === 'organization_id');
    expect(tables.length).toBe(tenantWide.length - (RETAINED_TABLES.size - 1));
  });

  it('tries children first: the reverse of registration order', () => {
    expect(
      erasableTables({ a: 'organization_id', b: 'organization_id', organizations: 'id' }),
    ).toEqual(['b', 'a']);
  });
});

describe('Company erasure — running it', () => {
  it('deletes in batches, scoped to the one organization, until nothing is left', async () => {
    const { database, rows, statements } = fakeDatabase({ rows: { projects: 5, work_items: 3 } });
    const { store } = recordingStore();
    const erasure = new CompanyErasure(database, store, ['work_items', 'projects'], SMALL);
    const outcome = await erasure.run(context);
    expect(outcome).toEqual<ErasureOutcome>({
      complete: true,
      rowsErased: 8,
      objectsRemoved: 0,
      blocked: {},
    });
    expect(rows.get('projects')).toBe(0);
    const deletes = statements.filter((s) => s.sql.startsWith('delete'));
    expect(deletes.every((s) => s.params.length === 1 && s.params[0] === ORG)).toBe(true);
    expect(deletes.every((s) => s.sql.endsWith('limit 2'))).toBe(true);
    expect(deletes.some((s) => s.params.includes(OTHER))).toBe(false);
  });

  it('retries a parent after its children are gone (foreign keys stay on)', async () => {
    const { database, rows } = fakeDatabase({
      rows: { projects: 2, work_items: 2 },
      references: { work_items: ['projects'] },
    });
    const { store } = recordingStore();
    // Parent first on purpose: the first round is refused, the second succeeds.
    const outcome = await new CompanyErasure(
      database,
      store,
      ['projects', 'work_items'],
      SMALL,
    ).run(context);
    expect(outcome.complete).toBe(true);
    expect(rows.get('projects')).toBe(0);
    expect(rows.get('work_items')).toBe(0);
  });

  it('is idempotent: a second run over an erased company finds nothing', async () => {
    const { database } = fakeDatabase({ rows: { projects: 1 } });
    const { store } = recordingStore();
    const erasure = new CompanyErasure(database, store, ['projects'], SMALL);
    await erasure.run(context);
    expect(await erasure.run(context)).toEqual({
      complete: true,
      rowsErased: 0,
      objectsRemoved: 0,
      blocked: {},
    });
  });

  it('stops at its per-run budget and is incomplete, for the next pass to finish', async () => {
    const { database, rows } = fakeDatabase({ rows: { messages: 9 } });
    const { store } = recordingStore();
    const outcome = await new CompanyErasure(database, store, ['messages'], {
      batchRows: 2,
      maxRowsPerRun: 5,
    }).run(context);
    expect(outcome.complete).toBe(false);
    expect(outcome.rowsErased).toBe(5);
    expect(rows.get('messages')).toBe(4);
  });

  it('reports a refused or not-permitted table and is left incomplete rather than forced', async () => {
    const { database, rows } = fakeDatabase({
      rows: { projects: 1, portal_access_log: 1, work_items: 1 },
      references: { portal_access_log: ['projects'] },
      refused: ['portal_access_log'],
      denied: ['work_items'],
    });
    const { store } = recordingStore();
    const outcome = await new CompanyErasure(
      database,
      store,
      ['work_items', 'portal_access_log', 'projects'],
      SMALL,
    ).run(context);
    expect(outcome.complete).toBe(false);
    expect(outcome.blocked).toEqual({
      work_items: 'not_permitted',
      portal_access_log: 'refused',
      projects: 'referenced',
    });
    expect(rows.get('projects')).toBe(1);
  });

  it('treats a table that does not exist as empty', async () => {
    const { database } = fakeDatabase({ rows: {} });
    const { store } = recordingStore();
    expect((await new CompanyErasure(database, store, ['gone'], SMALL).run(context)).complete).toBe(
      true,
    );
  });

  it("removes the company's stored file bytes from both zones, and never another prefix", async () => {
    const own = `tenant/${ORG}/project/p/upload/u/object`;
    const foreign = `tenant/${OTHER}/project/p/upload/u/object`;
    const { database } = fakeDatabase({ rows: {}, fileKeys: [own, foreign] });
    const { store, removed } = recordingStore();
    const outcome = await new CompanyErasure(database, store, [], SMALL).run(context);
    expect(outcome.objectsRemoved).toBe(1);
    expect(removed).toEqual([`quarantine:${own}`, `private:${own}`]);
  });

  it('removes the derivatives TManage made of them from the derived zone (R4 slice 2)', async () => {
    const own = `tenant/${ORG}/derivative/v/p`;
    const foreign = `tenant/${OTHER}/derivative/v/p`;
    const { database } = fakeDatabase({ rows: {}, previewKeys: [own, null, foreign] });
    const { store, removed } = recordingStore();
    const outcome = await new CompanyErasure(database, store, [], SMALL).run(context);
    expect(outcome.objectsRemoved).toBe(1);
    expect(removed).toEqual([`derived:${own}`]);
  });
});

describe('Privacy job — erasing a closed company', () => {
  const executed = {
    id: 'r1',
    kind: 'company',
    status: 'executed',
    subjectUserId: null,
    requestedByUserId: 'u1',
    scheduledFor: NOW,
    executedAt: NOW,
  } as unknown as PrivacyDeletionRequestRow;

  function pass(outcome: ErasureOutcome) {
    const calls: string[] = [];
    const logs: string[] = [];
    const database = {
      read: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
      transaction: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
    } as unknown as TenantDatabase;
    const repository = {
      listPurgeableExports: () => Promise.resolve([]),
      markErased: () => {
        calls.push('marked');
        return Promise.resolve(true);
      },
    } as unknown as PrivacyRepository;
    const audit = {
      record: (_r: unknown, _c: unknown, input: { action: string; metadata: unknown }) => {
        calls.push(`${input.action}:${JSON.stringify(input.metadata)}`);
        return Promise.resolve({});
      },
    } as unknown as AuditService;
    const privacyPass = new PrivacyPass(
      database,
      { remove: () => Promise.resolve() } as unknown as ObjectStore,
      undefined,
      audit,
      undefined,
      repository,
      { build: () => Promise.reject(new Error('not used')) },
      () => NOW,
      (line) => logs.push(line),
      {
        run: () => {
          calls.push('erase');
          return Promise.resolve(outcome);
        },
      },
    );
    return { privacyPass, calls, logs };
  }

  it('marks the request erased and audits it once nothing is left', async () => {
    const { privacyPass, calls } = pass({
      complete: true,
      rowsErased: 42,
      objectsRemoved: 3,
      blocked: {},
    });
    expect(await privacyPass.eraseCompany(context, executed)).toBe(true);
    expect(calls).toEqual([
      'erase',
      'marked',
      'privacy_deletion.executed:{"kind":"company","step":"erased","rows_erased":42,"files_removed":3}',
    ]);
  });

  it('waits, says why, and records nothing while the erasure is incomplete', async () => {
    const { privacyPass, calls, logs } = pass({
      complete: false,
      rowsErased: 1,
      objectsRemoved: 0,
      blocked: { work_items: 'not_permitted' },
    });
    expect(await privacyPass.eraseCompany(context, executed)).toBe(false);
    expect(calls).toEqual(['erase']);
    expect(logs).toEqual(['[privacy] company erasure r1 waits: work_items (not_permitted)']);
  });

  it('never erases for an account deletion or a request not carried out', async () => {
    const { privacyPass, calls } = pass({
      complete: true,
      rowsErased: 0,
      objectsRemoved: 0,
      blocked: {},
    });
    const account = { ...executed, kind: 'account' } as PrivacyDeletionRequestRow;
    const scheduled = { ...executed, status: 'scheduled' } as PrivacyDeletionRequestRow;
    expect(await privacyPass.eraseCompany(context, account)).toBe(false);
    expect(await privacyPass.eraseCompany(context, scheduled)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('starts a day after the company was closed, so the closing emails go first', () => {
    expect(ERASURE_DELAY_MS).toBe(24 * 60 * 60 * 1000);
  });
});
