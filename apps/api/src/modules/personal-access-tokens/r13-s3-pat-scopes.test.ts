import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { SessionAuthGuard } from '../../common/http/guards/session-auth.guard.js';
import { requireRequestState } from '../../common/http/request-state.js';
import {
  ipAllowed,
  mintPersonalAccessToken,
  routeScopeClass,
  scopesCover,
} from './personal-access-token.js';
import { resolvePatCreate } from './personal-access-tokens.service.js';
import {
  normalizePolicy,
  resolvePatPolicy,
  validatePolicyPatch,
} from '../admin/policies.allowlist.js';
import { OrgTokensController, OrgTokensService } from './org-tokens.controller.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/** R13 s3 (56-09): token scopes, expiry policy, IP allowlist, and the owner overview. */
const ALL = ['tmanage:read', 'tmanage:write', 'tmanage:manage', 'tmanage:billing'];
const POLICY = { maxExpiryDays: 365, allowNoExpiry: false, allowedScopes: ALL };
const NOW = new Date('2026-11-02T00:00:00Z');

describe('route classes and scope narrowing', () => {
  it('classifies by method, lifts admin/security/members to manage and billing to billing, skips the slug', () => {
    expect(routeScopeClass('GET', '/v1/organizations/acme/projects?x=1')).toBe('read');
    expect(routeScopeClass('POST', '/v1/organizations/acme/work-items')).toBe('write');
    expect(routeScopeClass('GET', '/v1/organizations/acme/admin/overview')).toBe('manage');
    expect(routeScopeClass('DELETE', '/v1/organizations/acme/projects/p/members/m')).toBe('manage');
    expect(routeScopeClass('GET', '/v1/organizations/acme/billing/invoices')).toBe('billing');
    expect(routeScopeClass('GET', '/v1/organizations/billing/projects')).toBe('read');
    expect(scopesCover(['tmanage:read'], 'write')).toBe(false);
    expect(scopesCover(['tmanage:read', 'tmanage:write'], 'manage')).toBe(false);
  });

  it('matches IPv4, IPv6 and IPv4-mapped addresses against CIDR entries; empty admits all', () => {
    expect(ipAllowed('10.1.2.3', [])).toBe(true);
    expect(ipAllowed('10.1.2.3', ['10.1.0.0/16'])).toBe(true);
    expect(ipAllowed('::ffff:10.1.2.3', ['10.1.0.0/16'])).toBe(true);
    expect(ipAllowed('10.2.0.1', ['10.1.0.0/16'])).toBe(false);
    expect(ipAllowed('2001:db8::5', ['2001:db8::/32'])).toBe(true);
    expect(ipAllowed('2001:db9::5', ['2001:db8::/32', '192.168.1.1'])).toBe(false);
    expect(ipAllowed(null, ['10.0.0.0/8'])).toBe(false);
  });
});

describe('create policy', () => {
  it('defaults to 90 days and read+write, caps expiry, refuses never-expiry without policy and step-up', () => {
    const made = resolvePatCreate({}, POLICY, false, NOW);
    expect(made.scopes).toBe('tmanage:read tmanage:write');
    expect(made.expiresAt?.getTime()).toBe(NOW.getTime() + 90 * 86_400_000);
    expect(() => resolvePatCreate({ expiresInDays: 366 }, POLICY, false, NOW)).toThrow(
      expect.objectContaining({
        status: 400,
        details: [expect.objectContaining({ field: 'expiresInDays' })],
      }),
    );
    expect(() => resolvePatCreate({ expiresInDays: null }, POLICY, true, NOW)).toThrow(
      /never expire/,
    );
    const open = { ...POLICY, allowNoExpiry: true };
    expect(() => resolvePatCreate({ expiresInDays: null }, open, false, NOW)).toThrow(/Confirm/);
    expect(resolvePatCreate({ expiresInDays: null }, open, true, NOW).expiresAt).toBeNull();
  });

  it('keeps scopes inside pat.allowed_scopes and validates the IP allowlist', () => {
    const narrow = resolvePatPolicy(normalizePolicy({ 'pat.allowed_scopes': ['tmanage:read'] }));
    expect(() => resolvePatCreate({ scopes: ['tmanage:write'] }, narrow, false, NOW)).toThrow();
    expect(resolvePatCreate({}, narrow, false, NOW).scopes).toBe('tmanage:read');
    expect(() => resolvePatCreate({ ipAllowlist: ['nope'] }, POLICY, false, NOW)).toThrow();
    expect(
      resolvePatCreate({ ipAllowlist: ['10.0.0.0/8'] }, POLICY, false, NOW).ipAllowlistJson,
    ).toBe('["10.0.0.0/8"]');
    expect(validatePolicyPatch({ 'pat.max_expiry_days': 0 }).ok).toBe(false);
    expect(validatePolicyPatch({ 'pat.allowed_scopes': ['tmanage:root'] }).ok).toBe(false);
  });
});

function guardFor(scopes: string[], ipAllowlist: string[] = []) {
  const pat = {
    authenticate: vi.fn(async () => ({
      tokenId: 't',
      organizationId: 'o',
      membershipId: 'm',
      userId: 'u',
      scopes,
      ipAllowlist,
    })),
  };
  const events = { recordGuardRefusal: vi.fn() };
  const guard = new SessionAuthGuard(
    { getAllAndOverride: () => false } as never,
    {} as never,
    { cookieName: 'tm' } as never,
    events as never,
    pat as never,
  );
  return { guard, events };
}
const ctx = (request: object) =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;
const bearer = { authorization: `Bearer ${mintPersonalAccessToken().token}` };

describe('PAT guard enforcement', () => {
  it('a read token is refused 403 insufficient_scope on a write route, with a refusal row', async () => {
    const { guard, events } = guardFor(['tmanage:read']);
    const request = { method: 'POST', url: '/v1/organizations/a/work-items', headers: bearer };
    await expect(guard.canActivate(ctx(request))).rejects.toMatchObject({
      status: 403,
      auditCode: 'insufficient_scope:write',
    });
    expect(events.recordGuardRefusal).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'pat.scope_denied' }),
    );
    await expect(
      guard.canActivate(
        ctx({ method: 'GET', url: '/v1/organizations/a/projects', headers: bearer }),
      ),
    ).resolves.toBe(true);
  });

  it('refuses outside the IP allowlist and records a hashed address, never the raw one', async () => {
    const { guard, events } = guardFor(ALL, ['10.0.0.0/8']);
    const request = {
      method: 'GET',
      ip: '192.168.1.9',
      url: '/v1/organizations/a/projects',
      headers: bearer,
    };
    await expect(guard.canActivate(ctx(request))).rejects.toMatchObject({
      status: 403,
      auditCode: 'pat_ip_not_allowed',
    });
    const row = events.recordGuardRefusal.mock.calls[0]?.[0] as { ip: string };
    expect(row.ip).toMatch(/^[0-9a-f]{40}$/);
  });

  it('on /mcp the scopes travel to the endpoint instead of a route-class refusal', async () => {
    const { guard } = guardFor(['tmanage:read']);
    const request = { method: 'POST', url: '/mcp', headers: bearer };
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(requireRequestState(request).authScheme).toBe('personal_access_token');
  });
});

describe('org token overview', () => {
  it('needs a cookie session, and an id from another company is a 404', async () => {
    const database = {
      transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
    } as unknown as TenantDatabase;
    const service = new OrgTokensService(
      database,
      { revokeInOrganization: vi.fn(async () => undefined) } as never,
      { revokeGrant: vi.fn(async () => 0) } as never,
    );
    const controller = new OrgTokensController(service);
    const context = { organizationId: 'o' } as TenantContext;
    await expect(controller.list(context, 'personal_access_token')).rejects.toMatchObject({
      status: 403,
    });
    await expect(controller.revoke(context, 'foreign-token', 'cookie')).rejects.toMatchObject({
      status: 404,
    });
  });
});
