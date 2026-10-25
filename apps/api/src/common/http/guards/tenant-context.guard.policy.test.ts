import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantContextGuard, createTenantGuardChecks } from './tenant-context.guard.js';
import type { TenantGuardChecks } from './tenant-context.guard.js';
import { requireRequestState } from '../request-state.js';
import type { RequestState } from '../request-state.js';
import { createAiAccessSwitchesFrom } from '../../../modules/oauth/ai-access.js';
import { CredentialsController } from '../../../modules/identity/authentication.controller.js';
import { McpEndpointController } from '../../../modules/mcp/mcp-endpoint.controller.js';
import { OrganizationsController } from '../../../modules/tenancy/organizations.controller.js';
import { SearchController } from '../../../modules/search/search.controller.js';

/**
 * Security audit run 1 — regression tests for lane S2 (the global guard chain).
 *
 * - F01 part b: a bound token is refused on `@NoTenant()` routes outside the allowlist, read from
 *   the real controllers' route metadata (so the handler's own checks are not involved at all).
 * - F10: the workspace and platform AI switches stop a bound token on REST.
 * - F52a: a company's `session_max_hours` ends an older cookie session.
 */

const USER = '0198f4a2-1c00-7000-8000-00000000000c';
const ORG = 'org-a';

type Handler = (...args: never[]) => unknown;

function contextFor(request: unknown, controller: object, handler: Handler): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

interface Options {
  readonly platformOn?: boolean;
  readonly organizationOn?: boolean;
  readonly sessionMaxHours?: number | null;
  readonly sessionAgeHours?: number;
}

function harness(options: Options = {}) {
  const switches = createAiAccessSwitchesFrom({
    environmentDisabled: false,
    readPlatform: () => Promise.resolve(options.platformOn === false ? 'off' : null),
    readOrganization: () =>
      Promise.resolve(options.organizationOn === false ? { enabled: true } : null),
  });
  const endSession = vi.fn(async () => {});
  const checks: TenantGuardChecks = {
    aiSwitches: switches,
    sessionMaxHours: async () => options.sessionMaxHours ?? null,
    sessionOlderThan: async (_id, hours) => (options.sessionAgeHours ?? 0) > hours,
    endSession,
  };
  const resolver = {
    resolve: vi.fn(async () => ({
      context: { organizationId: ORG, userId: USER },
      role: 'member',
      clientOrganizationId: null,
      hasOrgWideScope: true,
      workspaceScopeId: null,
    })),
  } as never;
  const principals = { load: vi.fn(async () => ({ userId: USER })) } as never;
  const database = {
    read: vi.fn(async (_ctx: unknown, work: (runner: unknown) => Promise<unknown>) => work({})),
  } as never;
  const guard = new TenantContextGuard(new Reflector(), resolver, principals, database, checks);
  return { guard, endSession };
}

function patRequest(orgSlug?: string): { request: object; state: RequestState } {
  const request = { params: orgSlug === undefined ? {} : { orgSlug }, headers: {} };
  const state = requireRequestState(request);
  state.session = { sessionId: 'pat:t1', userId: USER };
  state.authScheme = 'personal_access_token';
  state.personalAccessToken = { organizationId: ORG, membershipId: 'm1' };
  return { request, state };
}

function cookieRequest(orgSlug?: string): { request: object; state: RequestState } {
  const request = { params: orgSlug === undefined ? {} : { orgSlug }, headers: {} };
  const state = requireRequestState(request);
  state.session = { sessionId: 's1', userId: USER };
  state.authScheme = 'cookie';
  return { request, state };
}

const setPassword = CredentialsController.prototype.setPassword as Handler;
const listOrganizations = OrganizationsController.prototype.list as Handler;
const mcpHandle = McpEndpointController.prototype.handle as Handler;
const search = SearchController.prototype.run as Handler;

describe('F01 part b — bound tokens on @NoTenant routes', () => {
  it('refuses a PAT on POST /v1/auth/password/set before the handler runs', async () => {
    const { guard } = harness();
    const { request } = patRequest();
    await expect(
      guard.canActivate(contextFor(request, CredentialsController, setPassword)),
    ).rejects.toMatchObject({ status: 403, auditCode: 'bound_token_not_allowed' });
  });

  it('refuses the AI connector grant there too', async () => {
    const { guard } = harness();
    const { request, state } = patRequest();
    state.authScheme = 'ai_grant';
    await expect(
      guard.canActivate(contextFor(request, CredentialsController, setPassword)),
    ).rejects.toMatchObject({ status: 403, auditCode: 'bound_token_not_allowed' });
  });

  it('lets a PAT list its organization (GET /v1/organizations)', async () => {
    const { guard } = harness();
    const { request } = patRequest();
    await expect(
      guard.canActivate(contextFor(request, OrganizationsController, listOrganizations)),
    ).resolves.toBe(true);
  });

  it('lets a PAT reach POST /mcp', async () => {
    const { guard } = harness();
    const { request } = patRequest();
    await expect(
      guard.canActivate(contextFor(request, McpEndpointController, mcpHandle)),
    ).resolves.toBe(true);
  });

  it('leaves a cookie session on the same route alone', async () => {
    const { guard } = harness();
    const { request } = cookieRequest();
    await expect(
      guard.canActivate(contextFor(request, CredentialsController, setPassword)),
    ).resolves.toBe(true);
  });
});

describe('F10 — AI switches stop bound tokens on REST', () => {
  it('refuses a PAT on GET /search with the workspace switch off (403 ai_disabled)', async () => {
    const { guard } = harness({ organizationOn: false });
    const { request, state } = patRequest('org-a');
    await expect(
      guard.canActivate(contextFor(request, SearchController, search)),
    ).rejects.toMatchObject({ status: 403, auditCode: 'ai_disabled' });
    expect(state.principal).toBeUndefined();
  });

  it('refuses a PAT with the platform switch off (503)', async () => {
    const { guard } = harness({ platformOn: false });
    const { request } = patRequest('org-a');
    await expect(
      guard.canActivate(contextFor(request, SearchController, search)),
    ).rejects.toMatchObject({ status: 503, auditCode: 'ai_access_disabled' });
  });

  it('applies the platform switch on the allowlisted organization list', async () => {
    const { guard } = harness({ platformOn: false });
    const { request } = patRequest();
    await expect(
      guard.canActivate(contextFor(request, OrganizationsController, listOrganizations)),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('does not touch a cookie session (token revocation stays usable)', async () => {
    const { guard } = harness({ platformOn: false, organizationOn: false });
    const { request } = cookieRequest('org-a');
    await expect(guard.canActivate(contextFor(request, SearchController, search))).resolves.toBe(
      true,
    );
  });

  it('uses the provided AI switches when Nest builds the guard (no test checks)', async () => {
    const switches = createAiAccessSwitchesFrom({
      environmentDisabled: false,
      readPlatform: () => Promise.resolve(null),
      readOrganization: () => Promise.resolve({ enabled: true }),
    });
    const moduleRef = { get: vi.fn(() => switches) } as never;
    const resolver = {
      resolve: vi.fn(async () => ({ context: { organizationId: ORG, userId: USER } })),
    } as never;
    const guard = new TenantContextGuard(
      new Reflector(),
      resolver,
      { load: vi.fn() } as never,
      { read: vi.fn() } as never,
      undefined,
      moduleRef,
    );
    const { request } = patRequest('org-a');
    await expect(
      guard.canActivate(contextFor(request, SearchController, search)),
    ).rejects.toMatchObject({ status: 403, auditCode: 'ai_disabled' });
  });

  it('lets a PAT through with both switches on', async () => {
    const { guard } = harness();
    const { request } = patRequest('org-a');
    await expect(guard.canActivate(contextFor(request, SearchController, search))).resolves.toBe(
      true,
    );
  });
});

describe('F52a — session_max_hours ends older cookie sessions', () => {
  it('refuses a 2-hour-old session under a 1-hour policy and ends it', async () => {
    const { guard, endSession } = harness({ sessionMaxHours: 1, sessionAgeHours: 2 });
    const { request, state } = cookieRequest('org-a');
    await expect(
      guard.canActivate(contextFor(request, SearchController, search)),
    ).rejects.toMatchObject({ status: 401, auditCode: 'reauth_required:org_session_max_hours' });
    expect(endSession).toHaveBeenCalledWith('s1', state.correlationId);
    expect(state.tenant).toBeUndefined();
    expect(state.principal).toBeUndefined();
  });

  it('lets the same session through when the company stored no policy', async () => {
    const { guard, endSession } = harness({ sessionMaxHours: null, sessionAgeHours: 2 });
    const { request } = cookieRequest('org-a');
    await expect(guard.canActivate(contextFor(request, SearchController, search))).resolves.toBe(
      true,
    );
    expect(endSession).not.toHaveBeenCalled();
  });

  it('lets a session younger than the policy through', async () => {
    const { guard } = harness({ sessionMaxHours: 8, sessionAgeHours: 2 });
    const { request } = cookieRequest('org-a');
    await expect(guard.canActivate(contextFor(request, SearchController, search))).resolves.toBe(
      true,
    );
  });
});

describe('F52a — the production session-age check', () => {
  const HOUR = 3_600_000;
  const database = {
    identityRead: vi.fn(async (_options: unknown, work: (runner: unknown) => Promise<unknown>) =>
      work({}),
    ),
  } as never;
  const switches = createAiAccessSwitchesFrom({
    environmentDisabled: false,
    readPlatform: () => Promise.resolve(null),
    readOrganization: () => Promise.resolve(null),
  });
  const rows = (createdAt: Date | null) => ({
    findById: vi.fn(async () => (createdAt === null ? null : { session: { createdAt } })),
  });

  it('measures the session from its start', async () => {
    const now = 10 * HOUR;
    const checks = createTenantGuardChecks(
      database,
      switches,
      undefined,
      undefined,
      rows(new Date(now - 2 * HOUR)) as never,
      () => now,
    );
    await expect(checks.sessionOlderThan('s1', 1, 'c')).resolves.toBe(true);
    await expect(checks.sessionOlderThan('s1', 3, 'c')).resolves.toBe(false);
  });

  it('ends the session through the session service', async () => {
    const revoke = vi.fn(async () => true);
    const checks = createTenantGuardChecks(
      database,
      switches,
      { revoke },
      undefined,
      rows(null) as never,
    );
    await checks.endSession('s1', 'c');
    expect(revoke).toHaveBeenCalledWith({
      sessionId: 's1',
      reason: 'org_session_max_hours',
      correlationId: 'c',
    });
    await expect(checks.sessionOlderThan('s1', 1, 'c')).resolves.toBe(false);
  });
});
