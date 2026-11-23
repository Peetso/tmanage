import { describe, expect, it, vi } from 'vitest';
import { McpOAuthAuthenticator } from './mcp-auth.js';
import { platformBindingOf } from './mcp-endpoint.controller.js';
import { platformConsentCheckFrom, platformRightsFrom } from './platform-rights.js';
import type { PlatformAdminLookup } from '../platform-admin/platform-admin.guard.js';
import { PLATFORM_CONSENT_STEP_UP_FRESH_MS } from '../oauth/consent.js';

/**
 * ADR-0015 part 2 — where an AI principal's platform reach comes from (F1, F2, F11): the OAuth
 * grant's recorded binding, its own window, never a personal access token, and the consent's
 * "fresh step-up + two-step" rule. Fakes only; no database.
 */

const RESOURCE = 'https://tmanage.example/mcp';
const NOW = Date.parse('2026-11-23T10:00:00Z');

function authenticatorFor(grant: object): McpOAuthAuthenticator {
  const database = {
    identityRead: vi
      .fn()
      .mockImplementationOnce(async (_o: unknown, work: (db: unknown) => Promise<unknown>) =>
        work({}),
      )
      .mockImplementationOnce(async () => 'Claude'),
    bootstrapRead: vi.fn(async (_o: unknown, work: (db: unknown) => Promise<unknown>) => work({})),
  };
  const repo = {
    findLiveAccessTokenByHash: vi.fn(async () => ({
      grantId: 'g1',
      audience: RESOURCE,
      scopes: 'tmanage:read tmanage:platform',
    })),
    findGrantById: vi.fn(async () => grant),
  };
  return new McpOAuthAuthenticator(database as never, RESOURCE, repo as never);
}

const GRANT = {
  id: 'g1',
  organizationId: 'org-a',
  clientPk: 'client-1',
  membershipId: 'm-a',
  userId: 'u1',
  scopes: 'tmanage:read tmanage:platform',
  revokedAt: null,
};

describe('the OAuth grant carries a platform binding only as recorded at consent', () => {
  it('reads the stepped-up session and the window end from the grant row', async () => {
    const access = await authenticatorFor({
      ...GRANT,
      platformStepUpSessionId: 'browser-1',
      platformUntil: new Date(NOW + 3_600_000),
    }).authenticate('token', 'c1');
    expect(access.platform).toEqual({ stepUpSessionId: 'browser-1', until: NOW + 3_600_000 });
  });

  it('has none without the scope on the grant, or without the recorded binding', async () => {
    const noScope = await authenticatorFor({
      ...GRANT,
      scopes: 'tmanage:read',
      platformStepUpSessionId: 'browser-1',
      platformUntil: new Date(NOW + 3_600_000),
    }).authenticate('token', 'c1');
    expect(noScope.platform).toBeUndefined();
    const noBinding = await authenticatorFor(GRANT).authenticate('token', 'c1');
    expect(noBinding.platform).toBeUndefined();
  });
});

describe('platformBindingOf (F1, F2)', () => {
  const platform = { stepUpSessionId: 'browser-1', until: NOW + 60_000 };

  it('never binds a personal access token', () => {
    expect(platformBindingOf(true, { platform }, NOW)).toBeUndefined();
    expect(platformBindingOf(true, undefined, NOW)).toBeUndefined();
  });

  it('binds an OAuth grant inside its window only: the scope expires', () => {
    expect(platformBindingOf(false, { platform }, NOW)).toEqual(platform);
    expect(platformBindingOf(false, { platform }, NOW + 60_000)).toBeUndefined();
    expect(platformBindingOf(false, { platform }, NOW + 61_000)).toBeUndefined();
    expect(platformBindingOf(false, {}, NOW)).toBeUndefined();
  });
});

function lookupWith(o: {
  email?: string;
  mfaEnabled?: boolean;
  stepUpAgeMs?: number | null;
}): PlatformAdminLookup {
  return {
    findAccount: async () => ({
      userId: 'u1',
      email: o.email ?? 'peter@example.com',
      displayName: 'P',
      emailVerified: true,
      mfaEnabled: o.mfaEnabled ?? true,
    }),
    findLiveStepUp: async () =>
      o.stepUpAgeMs === null || o.stepUpAgeMs === undefined
        ? null
        : {
            expiresAt: new Date(NOW + 3_600_000),
            mfaVerified: true,
            createdAt: new Date(NOW - o.stepUpAgeMs),
          },
    findPlatformAdmin: async () => null,
    hasActivePlatformAdmins: async () => false,
  };
}

describe('platformRightsFrom (point 6)', () => {
  it('gives a listed admin their permissions and a non-admin none at all', async () => {
    const admin = await platformRightsFrom(['peter@example.com'], lookupWith({})).permissionsFor(
      'u1',
      'c1',
    );
    expect(admin?.has('platform.orgs.view')).toBe(true);
    expect(
      await platformRightsFrom(
        ['peter@example.com'],
        lookupWith({ email: 'owner@x.test' }),
      ).permissionsFor('u1', 'c1'),
    ).toBeUndefined();
    expect(await platformRightsFrom([], lookupWith({})).permissionsFor('u1', 'c1')).toBeUndefined();
  });
});

describe('platformConsentCheckFrom (F11)', () => {
  const now = () => new Date(NOW);
  const check = (o: Parameters<typeof lookupWith>[0], twoStep = true) =>
    platformConsentCheckFrom(['peter@example.com'], lookupWith(o), twoStep, now).standing(
      'u1',
      'session-a',
      'c1',
    );

  it('is not offered to a non-admin', async () => {
    expect(await check({ email: 'owner@x.test', stepUpAgeMs: 0 })).toEqual({
      offered: false,
      ready: false,
      stepUpExpiresAt: null,
    });
  });

  it('is ready only with a step-up minutes old and two-step on', async () => {
    expect(await check({ stepUpAgeMs: 60_000 })).toMatchObject({ offered: true, ready: true });
    expect(await check({ stepUpAgeMs: PLATFORM_CONSENT_STEP_UP_FRESH_MS + 1 })).toMatchObject({
      offered: true,
      ready: false,
    });
    expect(await check({ stepUpAgeMs: null })).toMatchObject({ offered: true, ready: false });
    expect(await check({ stepUpAgeMs: 0, mfaEnabled: false })).toMatchObject({ ready: false });
    expect((await check({ stepUpAgeMs: 0 })).stepUpExpiresAt).toEqual(new Date(NOW + 3_600_000));
  });
});
