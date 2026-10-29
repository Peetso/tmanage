import { describe, expect, it } from 'vitest';
import { customRoleKey } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import {
  OVERRIDES_PER_MEMBER_MAX,
  OWNER_OVERRIDE_MESSAGE,
  parseOverrides,
  requireMayOverride,
} from './override-ceiling.js';

/** platform-admin v2 · PA-01 — the per-member override rules (SPEC §3.3). */

const ORG = '0199cc00-0000-7000-8000-0000000000c1';
const NOW = new Date('2026-10-28T10:00:00.000Z');

function caller(role: string, over: Partial<Principal> = {}): Principal {
  return {
    userId: '0199cc00-0000-7000-8000-0000000000a1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: '0199cc00-0000-7000-8000-0000000000b1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
    ...over,
  } as Principal;
}

function thrown(run: () => unknown): ApiError {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected an ApiError');
}

describe('parseOverrides', () => {
  it('accepts a valid list and normalises reason and expiry', () => {
    const parsed = parseOverrides(
      {
        overrides: [
          { capability: 'report.export', effect: 'allow', reason: 'quarter close' },
          { capability: 'work.delete', effect: 'deny', expiresAt: '2026-12-01T00:00:00.000Z' },
        ],
      },
      NOW,
    );
    expect(parsed).toEqual([
      { capability: 'report.export', effect: 'allow', reason: 'quarter close', expiresAt: null },
      {
        capability: 'work.delete',
        effect: 'deny',
        reason: null,
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      },
    ]);
  });

  it('accepts an empty list (removes every override)', () => {
    expect(parseOverrides({ overrides: [] }, NOW)).toEqual([]);
  });

  it.each([
    ['not an object', null],
    ['no list', {}],
    ['unknown capability', { overrides: [{ capability: 'nope.nope', effect: 'allow' }] }],
    ['bad effect', { overrides: [{ capability: 'work.read', effect: 'maybe' }] }],
    [
      'duplicate capability',
      {
        overrides: [
          { capability: 'work.read', effect: 'allow' },
          { capability: 'work.read', effect: 'deny' },
        ],
      },
    ],
    [
      'expiry in the past',
      {
        overrides: [
          { capability: 'work.read', effect: 'deny', expiresAt: '2026-10-27T00:00:00.000Z' },
        ],
      },
    ],
    [
      'reason too long',
      { overrides: [{ capability: 'work.read', effect: 'deny', reason: 'x'.repeat(501) }] },
    ],
  ])('refuses %s with a 400', (_label, body) => {
    const error = thrown(() => parseOverrides(body, NOW));
    expect(error.status).toBe(400);
    expect(error.code).toBe('validation_failed');
  });

  it('refuses more entries than there are capabilities to name', () => {
    expect(OVERRIDES_PER_MEMBER_MAX).toBeGreaterThanOrEqual(56);
    const overrides = Array.from({ length: OVERRIDES_PER_MEMBER_MAX + 1 }, () => ({
      capability: 'work.read',
      effect: 'allow',
    }));
    expect(thrown(() => parseOverrides({ overrides }, NOW)).status).toBe(400);
  });
});

describe('requireMayOverride', () => {
  const allow = (capability: string) =>
    parseOverrides({ overrides: [{ capability, effect: 'allow' }] }, NOW);
  const deny = (capability: string) =>
    parseOverrides({ overrides: [{ capability, effect: 'deny' }] }, NOW);

  it('refuses any override on an owner with the owner sentence', () => {
    const error = thrown(() =>
      requireMayOverride(
        caller('owner'),
        { role: 'owner', audience: 'internal' },
        deny('work.read'),
        ORG,
        'x',
      ),
    );
    expect(error.status).toBe(400);
    expect(error.message).toBe(OWNER_OVERRIDE_MESSAGE);
  });

  it('refuses a deny on TManage support', () => {
    const error = thrown(() =>
      requireMayOverride(
        caller('owner'),
        { role: 'platform_support', audience: 'internal' },
        deny('work.read'),
        ORG,
        'x',
      ),
    );
    expect(error.status).toBe(400);
  });

  it('refuses an internal-only capability for a client member', () => {
    const error = thrown(() =>
      requireMayOverride(
        caller('owner'),
        { role: 'client_reviewer', audience: 'client' },
        allow('work.read'),
        ORG,
        'x',
      ),
    );
    expect(error.status).toBe(400);
  });

  it('lets an org admin allow a capability they hold', () => {
    expect(() =>
      requireMayOverride(
        caller('org_admin'),
        { role: 'member', audience: 'internal' },
        allow('report.export'),
        ORG,
        'x',
      ),
    ).not.toThrow();
  });

  it('refuses an allow the caller does not hold (403, no escalation)', () => {
    const delegate = caller(
      customRoleKey('0199cc00-0000-7000-8000-0000000000f1', ['roles.assign', 'work.read']),
    );
    const error = thrown(() =>
      requireMayOverride(
        delegate,
        { role: 'member', audience: 'internal' },
        allow('billing.manage'),
        ORG,
        'x',
      ),
    );
    expect(error.status).toBe(403);
  });

  it('lets anyone with roles.assign place a deny', () => {
    const delegate = caller(
      customRoleKey('0199cc00-0000-7000-8000-0000000000f1', ['roles.assign']),
    );
    expect(() =>
      requireMayOverride(
        delegate,
        { role: 'member', audience: 'internal' },
        deny('billing.manage'),
        ORG,
        'x',
      ),
    ).not.toThrow();
  });
});
