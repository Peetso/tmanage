import { describe, expect, it, vi } from 'vitest';
import { percentageBucket } from '../../admin/feature-flags.service.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformFlagsRepository, StoredFlag } from './flags.repository.js';
import { PlatformFlagsService, foldFlagUsage, parseFlagBody } from './flags.service.js';

/** PA-10 · D2: unknown keys refused, env-locked flags, rollout. */

const ctx = { correlationId: 'c', ip: null, userAgent: null };
const actor: PlatformAdminActor = {
  account: {
    userId: 'u',
    email: 'peter@example.com',
    displayName: 'Peter',
    emailVerified: true,
    mfaEnabled: true,
  },
  sessionId: 's',
  stepUp: null,
};
const NORTHSTAR = '0199aa00-0000-7000-8000-0000000000c1';
const ORBIT = '0199aa00-0000-7000-8000-0000000000c2';

function harness(env: NodeJS.ProcessEnv = {}, stored: StoredFlag[] = []) {
  const write = vi.fn(async () => undefined);
  const repository = {
    flags: vi.fn(async () => stored),
    overrides: vi.fn(async () => []),
    organizationsWithRows: vi.fn(async () => ({
      organizations: [
        { id: NORTHSTAR, name: 'Northstar', slug: 'northstar' },
        { id: ORBIT, name: 'Orbit Labs', slug: 'orbit' },
      ],
      orgRows: [],
    })),
    organizationsById: vi.fn(async (ids: readonly string[]) =>
      ids.map((id) => ({ id, name: id, slug: id })),
    ),
    searchOrganizations: vi.fn(async () => []),
    write,
  } as unknown as PlatformFlagsRepository;
  return { service: new PlatformFlagsService(repository, env), write };
}

describe('PlatformFlagsService', () => {
  it('refuses a key that is not in OPTIONAL_MODULE_FLAGS (400, nothing written)', async () => {
    const { service, write } = harness();
    await expect(
      service.update(actor, 'ai_side_panel', { enabled: true }, ctx),
    ).rejects.toMatchObject({ status: 400 });
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a flag the server locks (409) and reports the lock in the list', async () => {
    const { service, write } = harness({ TMANAGE_FLAG_LOCKS: 'copilot=off' });
    await expect(service.update(actor, 'copilot', { enabled: true }, ctx)).rejects.toMatchObject({
      status: 409,
    });
    expect(write).not.toHaveBeenCalled();
    const view = await service.list(ctx);
    expect(view.flags.find((flag) => flag.key === 'copilot')?.lockedValue).toBe(false);
  });

  it('writes an allowlist rollout with forced organizations', async () => {
    const { service, write } = harness();
    await service.update(
      actor,
      'copilot',
      {
        enabled: true,
        rollout: 'allowlist',
        allowlistOrganizationIds: [NORTHSTAR],
        overrides: [{ organizationId: ORBIT, state: 'off' }],
      },
      ctx,
    );
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'copilot',
        layer: { enabled: true, rollout: 'allowlist', percentage: null, allowlist: [NORTHSTAR] },
      }),
      expect.objectContaining({ action: 'platform.flag_updated', targetLabel: 'copilot' }),
    );
  });

  it('counts the organizations a flag reaches', async () => {
    const stored: StoredFlag[] = [
      {
        key: 'copilot',
        enabled: true,
        rollout: 'allowlist',
        percentage: null,
        allowlist: [NORTHSTAR],
        updatedAt: null,
        updatedBy: null,
      },
    ];
    const { service } = harness({}, stored);
    const view = await service.list(ctx);
    expect(view.organizationCount).toBe(2);
    expect(view.flags.find((flag) => flag.key === 'copilot')?.usedByOrganizations).toBe(1);
    expect(view.flags.find((flag) => flag.key === 'chat')?.usedByOrganizations).toBe(2);
  });
});

describe('parseFlagBody', () => {
  it('percentage must be 0–100', () => {
    expect(() =>
      parseFlagBody({ enabled: true, rollout: 'percentage', percentage: 101 }),
    ).toThrow();
    expect(parseFlagBody({ enabled: true, rollout: 'percentage', percentage: 25 }).layer).toEqual({
      enabled: true,
      rollout: 'percentage',
      percentage: 25,
      allowlist: [],
    });
  });

  it('refuses an unknown rollout and a bad organization id', () => {
    expect(() => parseFlagBody({ enabled: true, rollout: 'some' })).toThrow();
    expect(() =>
      parseFlagBody({ enabled: true, rollout: 'allowlist', allowlistOrganizationIds: ['x'] }),
    ).toThrow();
  });
});

describe('percentage rollout is deterministic by organization id', () => {
  it('the same organization always lands in the same bucket, 0–99', () => {
    const a = percentageBucket('copilot', NORTHSTAR);
    expect(percentageBucket('copilot', NORTHSTAR)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
  });

  it('raising the percentage only adds organizations', () => {
    const organizations = Array.from({ length: 200 }, (_, index) => ({
      id: `0199aa00-0000-7000-8000-${String(index).padStart(12, '0')}`,
      name: String(index),
      slug: String(index),
    }));
    const at = (percentage: number) =>
      foldFlagUsage(
        organizations,
        [],
        [],
        [
          {
            key: 'copilot',
            enabled: true,
            rollout: 'percentage',
            percentage,
            allowlist: [],
            updatedAt: null,
            updatedBy: null,
          },
        ],
        {},
      ).get('copilot') ?? 0;
    expect(at(0)).toBe(0);
    expect(at(100)).toBe(200);
    expect(at(25)).toBeLessThanOrEqual(at(50));
    expect(at(50)).toBeGreaterThan(50);
    expect(at(50)).toBeLessThan(150);
  });
});
