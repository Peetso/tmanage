import { describe, expect, it, vi } from 'vitest';
import { createTenantGuardChecks } from './tenant-context.guard.js';
import { createAiAccessSwitchesFrom } from '../../../modules/oauth/ai-access.js';
import { idleBeyondLimit } from '../../../modules/identity/session.service.js';

/** R3 — "Sign out after inactivity": idle is measured from the last refresh (database clock). */
function lapse(idleMinutes: number, idleSeconds: number) {
  const stampIdleLimit = vi.fn(async () => {});
  const findById = vi.fn(async () => ({
    session: { createdAt: new Date(0), idleLimitMinutes: null },
    idleSeconds,
  }));
  const work = async (_o: unknown, run: (runner: unknown) => Promise<unknown>) => run({});
  const switches = createAiAccessSwitchesFrom({
    environmentDisabled: false,
    readPlatform: async () => null,
    readOrganization: async () => null,
  });
  const database = { identityRead: work, identityTransaction: work } as never;
  const rows = { findById, stampIdleLimit } as never;
  const checks = createTenantGuardChecks(database, switches, undefined, undefined, rows, () => 0);
  const limits = { maxHours: null, idleMinutes };
  return { verdict: checks.sessionLapse!('s1', limits, 'c'), stampIdleLimit };
}

describe('R3 — idle sign-out', () => {
  it('refuses a session idle past the limit, on the guard and on the refresh path', async () => {
    await expect(lapse(30, 31 * 60).verdict).resolves.toMatchObject({ lapsed: 'idle' });
    expect(idleBeyondLimit({ session: { idleLimitMinutes: 30 }, idleSeconds: 31 * 60 })).toBe(true);
  });

  it('accepts a recently refreshed session and stamps the limit for the refresh path', async () => {
    const { verdict, stampIdleLimit } = lapse(30, 60);
    await expect(verdict).resolves.toEqual({
      lapsed: null,
      idleLimitMinutes: 30,
      idleRemainingSeconds: 29 * 60,
    });
    expect(stampIdleLimit).toHaveBeenCalledWith({}, 's1', 30);
  });

  it('does nothing when the policy is Off', async () => {
    const { verdict, stampIdleLimit } = lapse(0, 48 * 3600);
    await expect(verdict).resolves.toMatchObject({ lapsed: null, idleLimitMinutes: 0 });
    expect(stampIdleLimit).not.toHaveBeenCalled();
    expect(idleBeyondLimit({ session: { idleLimitMinutes: null }, idleSeconds: 9e9 })).toBe(false);
  });
});
