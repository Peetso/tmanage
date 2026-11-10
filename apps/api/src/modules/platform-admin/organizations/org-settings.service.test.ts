import { describe, expect, it } from 'vitest';
import { PlatformOrganizationSettingsService } from './org-settings.service.js';

/**
 * FIX-2026-11-10 (security review L5) — whether a company's people are tracked automatically is
 * the company owner's decision. Platform staff can change other owner-only keys here, never these.
 */

function harness() {
  const writes: unknown[] = [];
  const row = { id: 'o1' };
  const service = new PlatformOrganizationSettingsService(
    { require: async () => row } as never,
    { write: async (...args: unknown[]) => void writes.push(args) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, writes };
}

describe('platform admin · organization settings', () => {
  it('refuses the automatic time tracking keys, and writes nothing', async () => {
    const { service, writes } = harness();
    for (const key of ['auto_time_tracking', 'auto_time_tracking_max_idle']) {
      await expect(
        service.setSetting({} as never, 'o1', key, { value: 'off', reason: 'x' }, {} as never),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(writes).toEqual([]);
  });
});
