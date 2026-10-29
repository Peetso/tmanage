import { describe, expect, it } from 'vitest';
import { evaluateDeepHealth, versionsFromFilenames } from './deep-health.js';
import type { DeepHealthConfig, DeepHealthProbes } from './deep-health.js';

const NOW = new Date('2026-10-25T12:00:00.000Z');

function probes(overrides: Partial<DeepHealthProbes> = {}): DeepHealthProbes {
  return {
    readLedger: () =>
      Promise.resolve([
        { version: 1, status: 'applied' },
        { version: 2, status: 'applied' },
      ]),
    shippedVersions: () => Promise.resolve([1, 2]),
    readHeartbeat: () => Promise.resolve(new Date(NOW.getTime() - 60_000)),
    ...overrides,
  };
}

const base: DeepHealthConfig = { heartbeatMaxAgeSeconds: 900 };

describe('evaluateDeepHealth', () => {
  it('is ok with the database read, every shipped migration applied and nothing optional set', async () => {
    const report = await evaluateDeepHealth(base, probes(), NOW);
    expect(report).toEqual({
      status: 'ok',
      checks: {
        database: 'ok',
        migrations: 'ok',
        worker: 'not_configured',
        scanner: 'not_configured',
        schema: 'not_configured',
        backups: 'not_configured',
      },
      checkedAt: NOW.toISOString(),
    });
  });

  it('fails database and migrations when the ledger cannot be read', async () => {
    const report = await evaluateDeepHealth(
      base,
      probes({ readLedger: () => Promise.reject(new Error('ECONNREFUSED')) }),
      NOW,
    );
    expect(report.status).toBe('fail');
    expect(report.checks.database).toBe('fail');
    expect(report.checks.migrations).toBe('fail');
  });

  it('fails migrations when a shipped file is not applied, or one is running/failed', async () => {
    const pending = await evaluateDeepHealth(
      base,
      probes({ shippedVersions: () => Promise.resolve([1, 2, 3]) }),
      NOW,
    );
    expect(pending.checks.migrations).toBe('fail');
    const failed = await evaluateDeepHealth(
      base,
      probes({
        readLedger: () =>
          Promise.resolve([
            { version: 1, status: 'applied' },
            { version: 2, status: 'failed' },
          ]),
      }),
      NOW,
    );
    expect(failed.status).toBe('fail');
    expect(failed.checks.database).toBe('ok');
  });

  it('checks the worker heartbeat only when a heartbeat file is configured', async () => {
    const cfg = { ...base, heartbeatFile: '/var/hb.json' };
    expect((await evaluateDeepHealth(cfg, probes(), NOW)).checks.worker).toBe('ok');
    const stale = await evaluateDeepHealth(
      cfg,
      probes({ readHeartbeat: () => Promise.resolve(new Date(NOW.getTime() - 901_000)) }),
      NOW,
    );
    expect(stale.checks.worker).toBe('fail');
    expect(stale.status).toBe('fail');
    const missing = await evaluateDeepHealth(
      cfg,
      probes({ readHeartbeat: () => Promise.resolve(null) }),
      NOW,
    );
    expect(missing.checks.worker).toBe('fail');
  });

  it('reports the scanner as configured only for clamav with a host, and never fails on it', async () => {
    const on = await evaluateDeepHealth(
      { ...base, scannerDriver: 'clamav', scannerHost: 'clamd' },
      probes(),
      NOW,
    );
    expect(on.checks.scanner).toBe('ok');
    const off = await evaluateDeepHealth({ ...base, scannerDriver: 'none' }, probes(), NOW);
    expect(off.checks.scanner).toBe('not_configured');
    expect(off.status).toBe('ok');
  });
});

describe('versionsFromFilenames', () => {
  it('reads the migrator naming rule and ignores anything else', () => {
    expect(
      versionsFromFilenames(['0001_init.sql', '0230_x-y.sql', 'README.md', '12_a.sql']),
    ).toEqual([1, 230]);
  });
});
