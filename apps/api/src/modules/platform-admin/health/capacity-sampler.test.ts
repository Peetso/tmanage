import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CapacityReading } from './capacity-budget.js';
import { CapacitySampler, countInodes, nextNightlyAt, sumFileBytes } from './capacity-sampler.js';
import type { HostProbes } from './capacity-sampler.js';
import type { CapacityStore } from './capacity.repository.js';

function fakeStore(profileJson: string | null = null) {
  const inserted: CapacityReading[] = [];
  const purged: Date[] = [];
  const store: CapacityStore = {
    insert: async (r) => void inserted.push(r),
    purgeOlderThan: async (cutoff) => (purged.push(cutoff), 0),
    readDatabaseFigures: async () => ({ dbMb: 42, dbConnections: 3 }),
    readProfileJson: async () => profileJson,
    latest: async () => null,
    recentNightly: async () => [],
  };
  return { store, inserted, purged };
}

const probes = (rssMb: number): HostProbes => ({
  live: () => ({ rssMb, heapMb: 50, loopLagMs: 4, sockets: 2 }),
  countInodes: async () => ({ count: 1234, truncated: false }),
  diskUsedMb: async () => 777,
});

describe('CapacitySampler', () => {
  it('persists a sample every 5 minutes and a nightly row at 03:30 UTC, then purges at 90 days', async () => {
    let now = new Date('2026-10-29T03:00:00Z');
    const { store, inserted, purged } = fakeStore();
    const sampler = new CapacitySampler({
      store,
      alerts: null,
      probes: probes(200),
      now: () => now,
      autoStart: false,
    });
    await sampler.tick();
    expect(inserted).toHaveLength(0);
    now = new Date('2026-10-29T03:05:00Z');
    await sampler.tick();
    expect(inserted.map((r) => r.source)).toEqual(['sample']);
    expect(inserted[0]).toMatchObject({ rssMb: 200, inodes: null, dbMb: null });
    now = new Date('2026-10-29T03:30:00Z');
    await sampler.tick();
    expect(inserted[1]).toMatchObject({
      source: 'nightly',
      inodes: 1234,
      diskMb: 777,
      dbMb: 42,
      dbConnections: 3,
    });
    expect(purged[0]?.toISOString()).toBe('2026-07-31T03:30:00.000Z');
  });

  it('never throws out of a tick, and alerts a red gauge once per UTC day', async () => {
    const { store } = fakeStore('{"ramMb":100}');
    const kinds: string[] = [];
    let now = new Date('2026-10-29T10:00:00Z');
    const sampler = new CapacitySampler({
      store: {
        ...store,
        insert: async () => {
          throw new Error('db down');
        },
      },
      alerts: { notify: async (kind) => (kinds.push(kind), 'sent') },
      probes: probes(90),
      now: () => now,
      log: () => undefined,
      autoStart: false,
    });
    now = new Date('2026-10-29T10:05:00Z');
    await expect(sampler.tick()).resolves.toBeUndefined();
    const ok = new CapacitySampler({
      store,
      alerts: { notify: async (kind) => (kinds.push(kind), 'sent') },
      probes: probes(90),
      now: () => now,
      autoStart: false,
    });
    await ok.persistSample(new Date('2026-10-29T10:05:00Z'));
    await ok.persistSample(new Date('2026-10-29T10:10:00Z'));
    expect(kinds).toEqual(['capacity:red:ram']);
  });

  it('counts inodes under a root, skipping excluded paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tm-inodes-'));
    try {
      mkdirSync(join(root, 'a'));
      mkdirSync(join(root, 'skip'));
      writeFileSync(join(root, 'a', 'f1'), 'x');
      writeFileSync(join(root, 'skip', 'f2'), 'x');
      writeFileSync(join(root, 'f3'), 'x');
      expect(await countInodes(root, [join(root, 'skip')])).toEqual({ count: 4, truncated: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sums the bytes of the files under the root, not the volume, skipping excluded paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tm-bytes-'));
    try {
      mkdirSync(join(root, 'a'));
      mkdirSync(join(root, 'skip'));
      writeFileSync(join(root, 'a', 'f1'), 'x'.repeat(100));
      writeFileSync(join(root, 'skip', 'f2'), 'x'.repeat(5000));
      writeFileSync(join(root, 'f3'), 'x'.repeat(20));
      expect(await sumFileBytes(root, [join(root, 'skip')])).toEqual({
        bytes: 120,
        truncated: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('schedules the nightly reading at the next 03:30 UTC', () => {
    expect(nextNightlyAt(new Date('2026-10-29T03:30:00Z')).toISOString()).toBe(
      '2026-10-30T03:30:00.000Z',
    );
  });
});
