import { describe, expect, it } from 'vitest';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { KNOWN_SCOPES, SCOPE_AGENT } from '../oauth/scopes.js';
import {
  AGENT_KEY_ROTATION_OVERLAP_MS,
  AgentKeysService,
  parseAgentKeyRequest,
} from './agent-keys.js';
import { hashPersonalAccessToken, parseStoredScopes } from './personal-access-token.js';
import { resolvePatCreate } from './personal-access-tokens.service.js';
import { MemoryTokens } from './test-fakes.js';

/**
 * 60-05 (plan 60 v2 §4.5) — agent keys: the request parser, the service over an in-memory token
 * store (IP-14), and the fail-closed scope. The SQL and the grants are proved by the DB test
 * `apps/api/test/t-60-05-agent-keys.db.test.ts` (test phase).
 */

const RUNNER = {} as TenantQueryRunner;
const CONTEXT = { organizationId: '00000000-0000-4000-8000-000000000001' } as TenantContext;
const OWNER = { membershipId: 'm-ai', userId: 'u-ai' };
const T0 = new Date('2026-11-21T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('parseAgentKeyRequest', () => {
  it('takes a name, 30/60/90 days and an optional allowlist', () => {
    expect(parseAgentKeyRequest({ name: ' Mat ', lifetimeDays: 60 })).toEqual({
      ok: true,
      value: { name: 'Mat', lifetimeDays: 60, ipAllowlistJson: null },
    });
    const limited = parseAgentKeyRequest({
      name: 'Mat',
      lifetimeDays: 30,
      ipAllowlist: ['10.0.0.0/8'],
    });
    expect(limited.ok && limited.value.ipAllowlistJson).toBe('["10.0.0.0/8"]');
  });

  it('refuses a missing or other lifetime, no-expiry, hidden characters and unknown fields', () => {
    for (const body of [
      { name: 'Mat' },
      { name: 'Mat', lifetimeDays: 365 },
      { name: 'Mat', lifetimeDays: null },
      { name: 'Mat', lifetimeDays: '30' },
      { name: 'Ma‮t', lifetimeDays: 30 },
      { name: '', lifetimeDays: 30 },
      { name: 'Mat', lifetimeDays: 30, scopes: 'tmanage:manage' },
      { name: 'Mat', lifetimeDays: 30, ipAllowlist: ['not an address'] },
      null,
      [],
    ]) {
      expect(parseAgentKeyRequest(body).ok, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('AgentKeysService', () => {
  it('mints an agent-scoped key that expires, stores only the hash and shows the token once', async () => {
    const store = new MemoryTokens();
    const service = new AgentKeysService(store);
    const created = await service.mint(
      RUNNER,
      CONTEXT,
      OWNER,
      { name: 'Mat', lifetimeDays: 30, ipAllowlistJson: null },
      'm-sponsor',
      T0,
    );
    const [row] = store.rows;
    expect(row?.scopes).toBe(SCOPE_AGENT);
    expect(row?.expiresAt?.getTime()).toBe(T0.getTime() + 30 * DAY);
    expect(row?.createdByMembershipId).toBe('m-sponsor');
    expect(row?.tokenHash).toBe(hashPersonalAccessToken(created.token));
    expect(JSON.stringify(row)).not.toContain(created.token);
    const listed = await service.list(RUNNER, CONTEXT, OWNER, T0);
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('token');
    expect(listed[0]?.live).toBe(true);
  });

  it('rotation ends the old key within 24 hours, never later than it already ends', async () => {
    const store = new MemoryTokens();
    const service = new AgentKeysService(store);
    const a = await service.mint(
      RUNNER,
      CONTEXT,
      OWNER,
      { name: 'a', lifetimeDays: 90, ipAllowlistJson: null },
      'm',
      T0,
    );
    await service.endWithinOverlap(RUNNER, CONTEXT, OWNER, a.id, T0);
    expect(store.rows[0]?.expiresAt?.getTime()).toBe(T0.getTime() + AGENT_KEY_ROTATION_OVERLAP_MS);
    // A key already ending sooner keeps its end.
    const soon = new Date(T0.getTime() + 60_000);
    (store.rows[0] as { expiresAt: Date }).expiresAt = soon;
    await service.endWithinOverlap(RUNNER, CONTEXT, OWNER, a.id, T0);
    expect(store.rows[0]?.expiresAt).toBe(soon);
  });

  it('revoke is immediate and only for this AI employee', async () => {
    const store = new MemoryTokens();
    const service = new AgentKeysService(store);
    const a = await service.mint(
      RUNNER,
      CONTEXT,
      OWNER,
      { name: 'a', lifetimeDays: 30, ipAllowlistJson: null },
      'm',
      T0,
    );
    expect(
      await service.revoke(RUNNER, CONTEXT, { membershipId: 'm-other', userId: 'u' }, a.id, T0),
    ).toBe(false);
    expect(await service.revoke(RUNNER, CONTEXT, OWNER, a.id, T0)).toBe(true);
    expect(await service.countLive(RUNNER, CONTEXT, OWNER, T0)).toBe(0);
    expect(await service.revoke(RUNNER, CONTEXT, OWNER, a.id, T0)).toBe(false);
  });

  it('revokeAll (retire) marks every unrevoked key of this AI employee, expired ones too', async () => {
    const store = new MemoryTokens();
    const service = new AgentKeysService(store);
    const request = { name: 'k', lifetimeDays: 30 as const, ipAllowlistJson: null };
    const live = await service.mint(RUNNER, CONTEXT, OWNER, request, 'm', T0);
    const expired = await service.mint(RUNNER, CONTEXT, OWNER, request, 'm', T0);
    const done = await service.mint(RUNNER, CONTEXT, OWNER, request, 'm', T0);
    const other = { membershipId: 'm-other', userId: 'u-other' };
    const theirs = await service.mint(RUNNER, CONTEXT, other, request, 'm', T0);
    (store.rows.find((r) => r.id === expired.id) as { expiresAt: Date }).expiresAt = T0;
    await service.revoke(RUNNER, CONTEXT, OWNER, done.id, T0);
    const later = new Date(T0.getTime() + DAY);

    expect(await service.revokeAll(RUNNER, CONTEXT, OWNER, later)).toEqual([live.id, expired.id]);
    const at = (id: string) => store.rows.find((r) => r.id === id)?.revokedAt;
    expect([at(live.id), at(expired.id), at(done.id)]).toEqual([later, later, T0]);
    expect(at(theirs.id)).toBeNull();
    expect(await service.revokeAll(RUNNER, CONTEXT, OWNER, later)).toEqual([]);
  });
});

describe('the agent scope stays fail-closed until 60-06', () => {
  it('is not a scope a person can ask for', () => {
    expect(KNOWN_SCOPES).not.toContain(SCOPE_AGENT);
    expect(() =>
      resolvePatCreate(
        { scopes: [SCOPE_AGENT] },
        { maxExpiryDays: 365, allowNoExpiry: false, allowedScopes: [...KNOWN_SCOPES] },
        false,
        T0,
      ),
    ).toThrow();
  });

  it('a stored agent key parses to no human scope at all', () => {
    expect(parseStoredScopes(SCOPE_AGENT)).toEqual([]);
  });
});
