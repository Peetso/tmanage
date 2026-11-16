import { describe, expect, it } from 'vitest';
import type { AuditRetentionPolicyRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ChainVerifier, chainRowHash, genesisHash } from '../audit/audit-chain.js';
import type { ChainedEvent } from '../audit/audit-chain.js';
import { AuditRetentionPurge } from './audit-retention-purge.js';
import { AuditRetentionRepository } from './audit-retention.repository.js';

/**
 * 56-18 follow-up — the audit-log purge over an in-memory trail of one organization (the
 * repository is faked at its seam), plus the two SQL facts that hold it to one tenant.
 */

const ORG = '00000000-0000-4000-8000-0000000000d1';
const context = { organizationId: ORG, correlationId: 'c' } as unknown as TenantContext;
const NOW = new Date('2026-11-16T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

interface Row {
  id: string;
  seq: number;
  hash: string;
  createdAt: Date;
}

function trail(retentionDays: number | null, ageDays: readonly number[], refuse = false) {
  let rows: Row[] = ageDays.map((age, i) => ({
    id: `e${String(i + 1)}`,
    seq: i + 1,
    hash: `h${String(i + 1)}`,
    createdAt: new Date(NOW.getTime() - age * DAY),
  }));
  let boundary: { chainSeq: number; rowHash: string } | null = null;
  const audits: unknown[] = [];
  const repository = {
    find: () =>
      Promise.resolve(
        retentionDays === null ? undefined : ({ retentionDays } as AuditRetentionPolicyRow),
      ),
    purgeableThrough: (_r: unknown, _c: unknown, cutoff: Date) => {
      const kept = rows.find((row) => row.createdAt >= cutoff);
      return Promise.resolve(kept ? kept.seq - 1 : (rows.at(-1)?.seq ?? 0));
    },
    chainedBatch: (_r: unknown, _c: unknown, range: { afterSeq: number; throughSeq: number }) =>
      Promise.resolve(
        rows
          .filter((row) => row.seq > range.afterSeq && row.seq <= range.throughSeq)
          .map((row) => ({ id: row.id, chainSeq: row.seq, rowHash: row.hash })),
      ),
    legacyBatch: () => Promise.resolve([]),
    deleteEvents: (_r: unknown, _c: unknown, ids: readonly string[], cutoff: Date) => {
      if (refuse && ids.length > 0)
        return Promise.reject(Object.assign(new Error('t'), { errno: 1644 }));
      const before = rows.length;
      rows = rows.filter((row) => !(ids.includes(row.id) && row.createdAt < cutoff));
      return Promise.resolve(before - rows.length);
    },
  } as unknown as AuditRetentionRepository;
  const chain = {
    readHead: () => Promise.resolve({ purgedThroughSeq: boundary?.chainSeq ?? null }),
    recordPurgeBoundary: (
      _r: unknown,
      _c: unknown,
      next: { chainSeq: number; rowHash: string },
    ) => {
      boundary = next;
      return Promise.resolve();
    },
  };
  const database = {
    read: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
    transaction: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
  } as unknown as TenantDatabase;
  const audit = { record: (_r: unknown, _c: unknown, input: unknown) => audits.push(input) };
  const purge = new AuditRetentionPurge(
    database,
    audit as never,
    repository,
    chain as never,
    () => NOW,
    { batchRows: 2, maxRowsPerRun: 100 },
  );
  return { purge, rows: () => rows, boundary: () => boundary, audits };
}

describe('56-18 audit-log purge', () => {
  it('does nothing for a workspace that never set a retention window', async () => {
    const t = trail(null, [400, 300]);
    expect(await t.purge.run(context)).toEqual({ deleted: 0, cutoff: null, blocked: null });
    expect(t.rows()).toHaveLength(2);
    expect(t.audits).toEqual([]);
  });

  it('removes only the prefix past the cutoff, moves the boundary, writes one entry', async () => {
    const t = trail(90, [400, 200, 91, 30, 1]);
    const outcome = await t.purge.run(context);
    expect(outcome.deleted).toBe(3);
    expect(t.rows().map((row) => row.id)).toEqual(['e4', 'e5']);
    expect(t.boundary()).toEqual({ chainSeq: 3, rowHash: 'h3', at: NOW });
    expect(t.audits).toEqual([
      expect.objectContaining({
        action: 'audit.purged',
        metadata: { deleted: 3, cutoff: '2026-08-18T00:00:00.000Z', retention_days: 90 },
      }),
    ]);
  });

  it('honours the floor and an engine refusal', async () => {
    expect((await trail(0, [400]).purge.run(context)).deleted).toBe(0);
    const refused = trail(30, [400, 300], true);
    expect(await refused.purge.run(context)).toMatchObject({ deleted: 0, blocked: 'refused' });
    expect(refused.audits).toEqual([]);
  });

  it('scopes every purge statement to the acting workspace', async () => {
    const seen: { sql: string; params: readonly unknown[] }[] = [];
    const runner = {
      query: (sql: string, params: readonly unknown[]) => {
        seen.push({ sql, params });
        return Promise.resolve(sql.startsWith('select') ? [] : { affectedRows: 1 });
      },
    };
    const repo = new AuditRetentionRepository();
    await repo.deleteEvents(runner as never, context, ['e1'], NOW);
    await repo.chainedBatch(
      runner as never,
      context,
      { afterSeq: 0, throughSeq: 9, cutoff: NOW },
      5,
    );
    for (const statement of seen) {
      expect(statement.sql).toMatch(
        /`(audit_events|audit_event_changes)`\.`organization_id` = \?/u,
      );
      expect(statement.params[0]).toBe(ORG);
    }
    expect(seen).toHaveLength(3);
  });

  it('verifies a trail intact after its purged prefix, and still finds a later hole', () => {
    const rows: ChainedEvent[] = [];
    let prev = genesisHash(ORG);
    for (let seq = 1; seq <= 4; seq += 1) {
      const base = {
        organizationId: ORG,
        id: `e${String(seq)}`,
        createdAt: new Date(NOW.getTime() + seq),
        actorUserId: null,
        effectiveActorId: null,
        action: 'audit.purged',
        objectType: 'organization',
        objectId: null,
        result: 'allowed',
        metadataJson: {},
        chainSeq: seq,
        prevHash: prev,
      } as unknown as ChainedEvent;
      const rowHash = chainRowHash(base, seq, prev);
      rows.push({ ...base, rowHash });
      prev = rowHash;
    }
    const head = { chainSeq: 4, headHash: prev, lastEventId: 'e4' };
    const boundary = { chainSeq: 2, rowHash: rows[1]?.rowHash ?? '' };
    const intact = new ChainVerifier(ORG, new Map(), boundary);
    rows.slice(2).forEach((row) => intact.push(row));
    expect(intact.finish(head).firstBreak).toBeNull();
    const holed = new ChainVerifier(ORG, new Map(), boundary);
    holed.push(rows[3] as ChainedEvent);
    expect(holed.finish(head).firstBreak?.reason).toBe('missing_row');
  });
});
