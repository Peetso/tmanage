import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlatformPermission } from '@tmanage/domain';
import { ensureRequestState } from '../../../common/http/request-state.js';
import { PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminLookup } from '../platform-admin.guard.js';
import type { CapacityReading } from './capacity-budget.js';
import { PlatformCapacityController, readCapacity } from './capacity.controller.js';
import type { CapacityStore } from './capacity.repository.js';

const USER = '0199aa00-0000-7000-8000-0000000000c1';

/** The real guard over the real route metadata, with a team row holding `permissions`. */
async function guardStatus(permissions: PlatformPermission[]): Promise<number> {
  const lookup: PlatformAdminLookup = {
    findAccount: async () => ({
      userId: USER,
      email: 'ops@example.com',
      displayName: 'O',
      emailVerified: true,
      mfaEnabled: true,
    }),
    findLiveStepUp: async () => ({ expiresAt: new Date(Date.now() + 600_000), mfaVerified: true }),
    findPlatformAdmin: async () => ({
      id: 'admin-1',
      userId: USER,
      preset: 'support',
      customPermissions: null,
      permissions,
      status: 'active',
    }),
    hasActivePlatformAdmins: async () => true,
  };
  const guard = new PlatformAdminGuard(new Reflector(), [], lookup);
  const request = { headers: {} };
  const state = ensureRequestState(request);
  state.session = { sessionId: 's', userId: USER };
  state.authScheme = 'cookie';
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => PlatformCapacityController.prototype.read,
    getClass: () => PlatformCapacityController,
  } as unknown as ExecutionContext;
  return guard.canActivate(context).then(
    () => 200,
    (error: { status: number }) => error.status,
  );
}

function reading(source: 'sample' | 'nightly', day: number, rssMb: number): CapacityReading {
  return {
    takenAt: new Date(Date.UTC(2026, 9, 29 - day, 3, 30)),
    source,
    rssMb,
    heapMb: 100,
    loopLagMs: 10,
    sockets: 20,
    inodes: source === 'nightly' ? 100_000 : null,
    diskMb: source === 'nightly' ? 10_000 : null,
    dbMb: source === 'nightly' ? 300 : null,
    dbConnections: source === 'nightly' ? 5 : null,
  };
}

describe('GET /v1/platform/health/capacity', () => {
  it('is 403 without platform.activity.view and admitted with it', async () => {
    expect(await guardStatus(['platform.orgs.view'])).toBe(403);
    expect(await guardStatus(['platform.activity.view'])).toBe(200);
  });

  it('answers six gauges, the planning profile and a 7-day red streak from the readings', async () => {
    const nightly = Array.from({ length: 7 }, (_, d) => reading('nightly', d, 900));
    const store: CapacityStore = {
      insert: async () => undefined,
      purgeOlderThan: async () => 0,
      readDatabaseFigures: async () => ({ dbMb: null, dbConnections: null }),
      readProfileJson: async () => null,
      latest: async () => ({
        ...reading('sample', 0, 300),
        takenAt: new Date('2026-10-29T09:00Z'),
      }),
      recentNightly: async () => nightly,
    };
    const view = await readCapacity(store);
    expect(view.profile.source).toBe('planning');
    expect(view.gauges.map((g) => [g.key, g.colour])).toEqual([
      ['ram', 'green'],
      ['loop_lag', 'green'],
      ['sockets', 'green'],
      ['inodes', 'green'],
      ['disk', 'green'],
      ['db_connections', 'green'],
    ]);
    expect(view.redStreakDays).toBe(7);
    expect(view.trigger).toMatchObject({ days: 7, due: true });
    expect(view.latest.sample?.takenAt).toBe('2026-10-29T09:00:00.000Z');
  });

  it('names no path, host or environment value in the answer', async () => {
    const store: CapacityStore = {
      insert: async () => undefined,
      purgeOlderThan: async () => 0,
      readDatabaseFigures: async () => ({ dbMb: null, dbConnections: null }),
      readProfileJson: async () => null,
      latest: async () => reading('sample', 0, 300),
      recentNightly: async () => [reading('nightly', 0, 300)],
    };
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, inner] of Object.entries(value)) {
        keys.push(key);
        walk(inner);
      }
    };
    walk(await readCapacity(store));
    expect(keys.filter((key) => /path|host|root|dir|env|url/iu.test(key))).toEqual([]);
  });
});
