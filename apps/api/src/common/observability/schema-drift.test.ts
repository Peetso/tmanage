import { describe, expect, it } from 'vitest';
import { evaluateSchemaDrift, SchemaDriftGuard, SchemaDriftMonitor } from './schema-drift.js';
import type { SchemaDriftProbes } from './schema-drift.js';

const NOW = new Date('2026-10-29T12:00:00.000Z');
const probes = (o: Partial<SchemaDriftProbes> = {}): SchemaDriftProbes => ({
  readLedger: () => Promise.resolve([{ version: 1, checksum: 'a', status: 'applied' }]),
  shippedMigrations: () => Promise.resolve([{ version: 1, checksum: 'a' }]),
  readTables: () => Promise.resolve(['projects']),
  ...o,
});
const ctx = (url: string) => ({ switchToHttp: () => ({ getRequest: () => ({ url }) }) }) as never;
const files = () =>
  Promise.resolve([
    { version: 1, checksum: 'b' },
    { version: 2, checksum: 'c' },
  ]);

describe('schema drift (56-27)', () => {
  it('is ok when everything agrees; fails on an edited file, an unrecorded file, a missing table', async () => {
    expect((await evaluateSchemaDrift(['projects'], probes(), NOW)).state).toBe('ok');
    const r = await evaluateSchemaDrift(
      ['projects', 'tasks'],
      probes({ shippedMigrations: files }),
      NOW,
    );
    expect(r.problems.map((p) => p.kind).sort()).toEqual([
      'checksum_mismatch',
      'migration_not_recorded',
      'missing_table',
    ]);
  });

  it('is not_configured, never fail, when the database cannot be read', async () => {
    const down = probes({ readTables: () => Promise.reject(new Error('down')) });
    expect((await evaluateSchemaDrift(['projects'], down, NOW)).state).toBe('not_configured');
  });

  it('refuses service on drift in enforce mode only, and never /healthz/deep', async () => {
    const enforce = new SchemaDriftGuard(new SchemaDriftMonitor(['tasks'], probes(), 'enforce'));
    await expect(enforce.canActivate(ctx('/api/projects'))).rejects.toThrow();
    await expect(enforce.canActivate(ctx('/healthz/deep'))).resolves.toBe(true);
    const report = new SchemaDriftGuard(new SchemaDriftMonitor(['tasks'], probes(), 'report'));
    await expect(report.canActivate(ctx('/api/projects'))).resolves.toBe(true);
  });
});
