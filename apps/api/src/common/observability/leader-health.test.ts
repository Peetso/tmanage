import { describe, expect, it } from 'vitest';
import { evaluateDeepHealth } from './deep-health.js';
import { leaderCheckOf } from './leader-health.js';
import { LEADER_HEALTH_SQL, readLeaderHealth } from './leader-health.repository.js';
import type { TenantDatabase } from '../database/tenant-context.js';

const NOW = new Date('2026-11-20T12:00:00.000Z');

describe('DC-3 leader reading of /healthz/deep', () => {
  it('names the live holder by its opaque tag', () => {
    expect(
      leaderCheckOf({ holder: 'a1b2c3d4e5f6', expiresAt: new Date(NOW.getTime() + 1) }, NOW),
    ).toEqual({
      state: 'held',
      instance: 'a1b2c3d4e5f6',
    });
  });

  it('is vacant with no row, an empty holder or an expired lease', () => {
    expect(leaderCheckOf(null, NOW)).toEqual({ state: 'vacant' });
    expect(leaderCheckOf({ holder: '', expiresAt: new Date(NOW.getTime() + 1) }, NOW)).toEqual({
      state: 'vacant',
    });
    expect(leaderCheckOf({ holder: 'x', expiresAt: new Date(NOW.getTime() - 1) }, NOW)).toEqual({
      state: 'vacant',
    });
  });

  it('reads the row on the identity path with a bound name, and never throws', async () => {
    const seen: { tables: readonly string[]; sql: string; params: unknown }[] = [];
    const database = {
      identityRead: async (
        scope: { tables: readonly string[] },
        work: (runner: { query: (sql: string, params: unknown) => Promise<unknown[]> }) => unknown,
      ) =>
        work({
          query: (sql, params) => {
            seen.push({ tables: scope.tables, sql, params });
            return Promise.resolve([
              { holder: 'abc', expires_at: new Date(NOW.getTime() + 5_000) },
            ]);
          },
        }),
    } as unknown as TenantDatabase;
    expect(await readLeaderHealth(database, NOW)).toEqual({ state: 'held', instance: 'abc' });
    expect(seen).toEqual([
      { tables: ['runtime_leases'], sql: LEADER_HEALTH_SQL, params: ['leader'] },
    ]);
    expect(LEADER_HEALTH_SQL).not.toMatch(/now\(|current_timestamp/iu);

    const broken = {
      identityRead: () => Promise.reject(new Error("Table 'runtime_leases' doesn't exist")),
    } as unknown as TenantDatabase;
    expect(await readLeaderHealth(broken, NOW)).toEqual({ state: 'not_configured' });
  });

  it('is info only: a vacant lease never turns the answer into a 503', async () => {
    const report = await evaluateDeepHealth(
      { heartbeatMaxAgeSeconds: 900 },
      {
        readLedger: () => Promise.resolve([{ version: 1, status: 'applied' }]),
        shippedVersions: () => Promise.resolve([1]),
        readHeartbeat: () => Promise.resolve(null),
      },
      NOW,
      'not_configured',
      'not_configured',
      { state: 'not_configured' },
      'not_configured',
      { state: 'vacant' },
    );
    expect(report.status).toBe('ok');
    expect(report.checks.leader).toEqual({ state: 'vacant' });
  });
});
