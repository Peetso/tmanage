import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import {
  CapacitySampler,
  countInodes,
  nodeProbes,
} from '../src/modules/platform-admin/health/capacity-sampler.js';
import { CapacityRepository } from '../src/modules/platform-admin/health/capacity.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';

/**
 * 56-32 against a real server — `host_capacity_readings` (0254), GLOBAL, reached through the
 * identity path. The sampler persists a `sample` row and a `nightly` row (inodes from a real walk,
 * disk from a real file-size walk, the schema size and connection count from the real server) on the
 * runtime credential, and purges rows older than 90 days. The admin pool clock is SYSTEM, so every
 * row is dated from a bound `Date`.
 */

let db: TestDatabase;
let repository: CapacityRepository;
let root: string;

const NOW = new Date('2026-10-29T03:30:00.000Z');

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  await db.admin.query('DELETE FROM host_capacity_readings');
  repository = new CapacityRepository(new TenantDatabase(db.runtime, { guardMode: 'enforce' }));
  root = mkdtempSync(join(tmpdir(), 'tm-capacity-'));
  writeFileSync(join(root, 'a.txt'), 'x');
});

afterAll(async () => {
  if (root) rmSync(root, { recursive: true, force: true });
  await db?.stop();
});

describe('the capacity sampler on a real server', () => {
  it('persists a sample row and a nightly row with inodes, disk and DB figures, then purges at 90 days', async () => {
    const old = new Date(NOW.getTime() - 100 * 86_400_000);
    const recent = new Date(NOW.getTime() - 10 * 86_400_000);
    for (const takenAt of [old, recent]) {
      await db.admin.execute(
        "INSERT INTO host_capacity_readings (id, taken_at, source, rss_mb, heap_mb, loop_lag_ms) VALUES (?, ?, 'sample', 1, 1, 1)",
        [uuidv7(), takenAt],
      );
    }
    const real = nodeProbes(monitorEventLoopDelay());
    const sampler = new CapacitySampler({
      store: repository,
      alerts: null,
      appRoot: root,
      probes: {
        live: () => ({ rssMb: 210, heapMb: 90, loopLagMs: 3, sockets: 4 }),
        countInodes: (dir, exclude) => countInodes(dir, exclude),
        diskUsedMb: real.diskUsedMb,
      },
      now: () => NOW,
      autoStart: false,
    });

    await sampler.persistSample(new Date(NOW.getTime() - 60_000));
    await sampler.persistNightly(NOW);

    const sample = await rows(
      "SELECT * FROM host_capacity_readings WHERE source = 'sample' AND rss_mb = 210",
    );
    expect(sample).toHaveLength(1);
    expect(sample[0]?.['inodes']).toBeNull();

    const nightly = await rows("SELECT * FROM host_capacity_readings WHERE source = 'nightly'");
    expect(nightly).toHaveLength(1);
    expect(nightly[0]?.['inodes']).toBe(2);
    expect(Number(nightly[0]?.['disk_mb'])).toBeGreaterThan(0);
    expect(Number(nightly[0]?.['db_mb'])).toBeGreaterThanOrEqual(0);
    expect(Number(nightly[0]?.['db_connections'])).toBeGreaterThan(0);

    const left = await rows('SELECT taken_at FROM host_capacity_readings ORDER BY taken_at');
    expect(left.map((r) => new Date(r['taken_at'] as Date).getTime())).not.toContain(old.getTime());
    expect(left.map((r) => new Date(r['taken_at'] as Date).getTime())).toContain(recent.getTime());

    expect((await repository.latest('nightly'))?.inodes).toBe(2);
  });
});
