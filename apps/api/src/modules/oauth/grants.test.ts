import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FeatureFlagsRepository } from '../admin/feature-flags.repository.js';
import {
  AI_APPS_OFF_FLAG,
  AI_SWITCH_CACHE_MS,
  createAiAccessSwitchesFrom,
  environmentAiDisabled,
} from './ai-access.js';
import type { AiAccessSwitches } from './ai-access.js';
import { requireBrowserSession } from './grants.controller.js';
import type { GrantsRepository } from './grants.repository.js';
import { ConnectedAppsService, isAiOwner, orderedScopes } from './grants.service.js';
import type { OauthTokensRepository } from './oauth-tokens.repository.js';

const context = {
  organizationId: 'org-1',
  userId: 'user-1',
  membershipId: 'mem-1',
} as TenantContext;
const database = {
  read: (_c: unknown, fn: (runner: unknown) => unknown) => fn({}),
  transaction: (_c: unknown, fn: (runner: unknown) => unknown) => fn({}),
} as unknown as TenantDatabase;

function switchesWith(stored: { platform: string | null; orgOff: boolean | null }, env = false) {
  let clock = 0;
  const readPlatform = vi.fn(async () => stored.platform);
  const readOrganization = vi.fn(async () =>
    stored.orgOff === null ? null : { enabled: stored.orgOff },
  );
  const switches = createAiAccessSwitchesFrom({
    readPlatform,
    readOrganization,
    environmentDisabled: env,
    now: () => clock,
  });
  return { switches, readOrganization, tick: (ms: number) => (clock += ms) };
}

function service(changed: number) {
  const grants = { revokeGrant: vi.fn(async () => changed) } as unknown as GrantsRepository;
  const tokens = {
    revokeTokensByGrant: vi.fn(async () => undefined),
  } as unknown as OauthTokensRepository;
  const flags = { upsert: vi.fn(async () => ({})) } as unknown as FeatureFlagsRepository;
  const switches = { forget: vi.fn() } as unknown as AiAccessSwitches;
  return {
    apps: new ConnectedAppsService(database, switches, grants, tokens, flags),
    grants,
    tokens,
    flags,
    switches,
  };
}

describe('AI kill switches (S11, T-KILL-01)', () => {
  it('platform: the environment or a stored "off" turns AI off; anything else leaves it on', async () => {
    expect(await switchesWith({ platform: null, orgOff: null }).switches.platformOn('c')).toBe(
      true,
    );
    expect(await switchesWith({ platform: 'off', orgOff: null }).switches.platformOn('c')).toBe(
      false,
    );
    expect(
      await switchesWith({ platform: 'on', orgOff: null }, true).switches.platformOn('c'),
    ).toBe(false);
    expect(environmentAiDisabled('1')).toBe(true);
    expect(environmentAiDisabled(undefined)).toBe(false);
  });

  it('workspace: no row is allowed, an ai_apps_off row turns it off, and a flip lands within 1 s', async () => {
    const stored = { platform: null, orgOff: null as boolean | null };
    const { switches, tick } = switchesWith(stored);
    expect(await switches.organizationOn('org-1', 'c')).toBe(true);
    stored.orgOff = true;
    tick(AI_SWITCH_CACHE_MS);
    expect(AI_SWITCH_CACHE_MS).toBeLessThan(1000);
    expect(await switches.organizationOn('org-1', 'c')).toBe(false);
    stored.orgOff = false;
    switches.forget();
    expect(await switches.organizationOn('org-1', 'c')).toBe(true);
  });

  it('fails closed when the switch cannot be read', async () => {
    const switches = createAiAccessSwitchesFrom({
      readPlatform: async () => {
        throw new Error('db down');
      },
      readOrganization: async () => {
        throw new Error('db down');
      },
      environmentDisabled: false,
    });
    expect(await switches.platformOn('c')).toBe(false);
    expect(await switches.organizationOn('org-1', 'c')).toBe(false);
  });
});

describe('Connected apps (S11)', () => {
  it('only a browser session may use the page; an AI credential is refused', () => {
    expect(() => requireBrowserSession('cookie')).not.toThrow();
    expect(() => requireBrowserSession('personal_access_token')).toThrow();
    expect(() => requireBrowserSession('ai_grant')).toThrow();
  });

  it('the owner is whoever holds org.security.manage', () => {
    expect(isAiOwner('owner')).toBe(true);
    expect(isAiOwner('member')).toBe(false);
    expect(isAiOwner(undefined)).toBe(false);
  });

  it('a member revokes only their own grant; the grant and all its tokens go together', async () => {
    const { apps, grants, tokens } = service(1);
    await apps.revoke(context, false, 'g-1');
    expect(grants.revokeGrant).toHaveBeenCalledWith({}, context, 'g-1', 'mem-1');
    expect(tokens.revokeTokensByGrant).toHaveBeenCalledWith({}, 'g-1');
    const owner = service(1);
    await owner.apps.revoke(context, true, 'g-2');
    expect(owner.grants.revokeGrant).toHaveBeenCalledWith({}, context, 'g-2', null);
  });

  it("someone else's, unknown or already revoked grant is a 404 and revokes nothing", async () => {
    const { apps, tokens } = service(0);
    await expect(apps.revoke(context, false, 'g-x')).rejects.toMatchObject({ status: 404 });
    expect(tokens.revokeTokensByGrant).not.toHaveBeenCalled();
  });

  it('the workspace switch stores ai_apps_off and is forgotten by the cache at once', async () => {
    const { apps, flags, switches } = service(1);
    await expect(apps.setAiAccess(context, 'no')).rejects.toMatchObject({ status: 400 });
    expect(await apps.setAiAccess(context, false)).toEqual({ aiAccessEnabled: false });
    expect(flags.upsert).toHaveBeenCalledWith({}, context, {
      flagKey: AI_APPS_OFF_FLAG,
      enabled: true,
      updatedBy: 'mem-1',
    });
    expect(switches.forget).toHaveBeenCalled();
  });

  it('scopes come back in the canonical order', () => {
    expect(orderedScopes('tmanage:write tmanage:read')).toEqual(['tmanage:read', 'tmanage:write']);
  });
});
