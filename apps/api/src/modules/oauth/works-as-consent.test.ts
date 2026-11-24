import type { ExecutionContext } from '@nestjs/common';
import { capabilitiesFor, type Principal } from '@tmanage/domain';
import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { SessionAuthGuard } from '../../common/http/guards/session-auth.guard.js';
import { TenantContextGuard } from '../../common/http/guards/tenant-context.guard.js';
import { ensureRequestState, requireRequestState } from '../../common/http/request-state.js';
import type { AgentGate } from '../ai-employees/enforcement.js';
import { ConsentTickets } from './consent.js';
import { OAuthConsentController } from './consent.controller.js';
import type { NewGrant, OauthTokensRepository } from './oauth-tokens.repository.js';
import { OAuthService, type ValidatedAuthorize } from './oauth.service.js';
import { parseWorksAs, type WorksAsBinder, type WorksAsPort } from './works-as.js';

/**
 * 60-07 (plan 60 v2 §4.5; security test 9 "Credentials") — the consent page's "works as", OAuth
 * side, with fakes (IP-14):
 * - the approve route never trusts the page: an AI employee's id goes to the AI-employee module's
 *   binder (which re-checks every rule in the grant's transaction), the page's scopes are
 *   ignored, and a malformed choice is refused;
 * - the grant is bound to the AI employee's membership with `tmanage:agent` only and names the
 *   consenting person; a refused binding writes nothing;
 * - a token under such a grant is an agent credential: the tool wall stops it at `/mcp`, and the
 *   agent gate is asked with `agentCredential: true`, so it can never act as a person.
 * The binding rules themselves are `apps/api/src/modules/ai-employees/works-as.test.ts`.
 */

const ORG = '00000000-0000-4000-8000-000000000001';
const PERSON_M = '0190a000-0000-7000-8000-0000000000a1';
const PERSON_USER = '0190a000-0000-7000-8000-0000000000a2';
const AI_ID = '0190a000-0000-7000-8000-0000000000e1';
const AI_M = '0190a000-0000-7000-8000-0000000000e2';
const AI_USER = '0190a000-0000-7000-8000-0000000000e3';

const validated: ValidatedAuthorize = {
  clientPk: 'pk',
  clientId: 'https://claude.ai/oauth/claude-metadata.json',
  clientName: 'Claude',
  verified: true,
  redirectUri: 'https://claude.ai/api/mcp/auth_callback',
  challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  scopes: ['tmanage:read', 'tmanage:write'],
  resource: 'https://tmanage.example/mcp',
  state: 'xyz',
};

const context = {
  organizationId: ORG,
  userId: PERSON_USER,
  membershipId: PERSON_M,
  principalKind: 'internal',
  capabilities: capabilitiesFor('owner'),
} as unknown as TenantContext;

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('expected a refusal');
}

describe('parseWorksAs', () => {
  it('reads absent, null and "me" as the person, an id as that AI employee', () => {
    expect(parseWorksAs(undefined)).toEqual({ ok: true, aiEmployeeId: null });
    expect(parseWorksAs(null)).toEqual({ ok: true, aiEmployeeId: null });
    expect(parseWorksAs('me')).toEqual({ ok: true, aiEmployeeId: null });
    expect(parseWorksAs(AI_ID.toUpperCase())).toEqual({ ok: true, aiEmployeeId: AI_ID });
  });

  it('refuses anything else', () => {
    for (const bad of ['', 'Me', 'mat', `${AI_ID} `, 42, [AI_ID], { id: AI_ID }]) {
      expect(parseWorksAs(bad), JSON.stringify(bad)).toEqual({ ok: false });
    }
  });
});

describe('OAuthConsentController: works as', () => {
  function build(port?: WorksAsPort) {
    const granted: Record<string, unknown>[] = [];
    const oauth = {
      validateAuthorize: async () => validated,
      grantConsent: async (_c: unknown, input: Record<string, unknown>) => {
        granted.push(input);
        return { redirectUrl: 'https://claude.ai/api/mcp/auth_callback?code=c', code: 'c' };
      },
    } as unknown as OAuthService;
    const aiOn = {
      platformOn: async () => true,
      organizationOn: async () => true,
      forget: () => undefined,
    };
    const controller = new OAuthConsentController(
      oauth,
      new ConsentTickets(Buffer.alloc(32, 3)),
      aiOn,
      undefined,
      port,
    );
    return { controller, granted };
  }
  const reply = { header: () => reply };
  const session = { sessionId: 'session-a', userId: PERSON_USER };
  function request(authScheme: 'cookie' | 'personal_access_token' = 'cookie') {
    const req = { headers: {} };
    const state = ensureRequestState(req);
    state.authScheme = authScheme;
    state.membership = { role: 'owner' } as never;
    return req;
  }
  const binder: WorksAsBinder = async () => ({ membershipId: AI_M, userId: AI_USER });
  const port: WorksAsPort = {
    options: vi.fn(async () => ({
      aiEmployees: [
        {
          id: AI_ID,
          displayName: 'Mat',
          jobTitle: 'Social media designer',
          available: true,
          unavailableReason: null,
        },
      ],
    })),
    binder: vi.fn(() => binder),
  };

  it('lists the choices for a cookie session only; none without the AI-employee module', async () => {
    expect(await build(port).controller.worksAsOptions(context, request(), reply)).toMatchObject({
      aiEmployees: [{ id: AI_ID }],
    });
    expect(await build().controller.worksAsOptions(context, request(), reply)).toEqual({
      aiEmployees: [],
    });
    const token = await refusal(
      build(port).controller.worksAsOptions(context, request('personal_access_token'), reply),
    );
    expect([token.status, token.auditCode]).toEqual([403, 'consent_needs_session']);
  });

  it('approves as the AI employee through its binder, ignoring the page’s scopes', async () => {
    const { controller, granted } = build(port);
    const { ticket } = await controller.view(session, {}, request(), reply);
    await controller.approve(
      context,
      session,
      { ticket, worksAs: AI_ID, scopes: ['tmanage:manage', 'tmanage:billing', 'tmanage:platform'] },
      request(),
      reply,
    );
    expect(port.binder).toHaveBeenCalledWith(AI_ID);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({ membershipId: PERSON_M, scopes: [], worksAs: binder });
    expect(granted[0]).not.toHaveProperty('platform');
  });

  it('still needs the session’s ticket; refuses a malformed choice; 404 without the module', async () => {
    const { controller, granted } = build(port);
    const forged = await refusal(
      controller.approve(context, session, { ticket: 'x', worksAs: AI_ID }, request(), reply),
    );
    expect(forged.status).toBe(403);
    const { ticket } = await controller.view(session, {}, request(), reply);
    const bad = await refusal(
      controller.approve(context, session, { ticket, worksAs: 'mat' }, request(), reply),
    );
    expect(bad.status).toBe(400);
    expect(granted).toHaveLength(0);

    const bare = build();
    const fresh = await bare.controller.view(session, {}, request(), reply);
    const missing = await refusal(
      bare.controller.approve(
        context,
        session,
        { ticket: fresh.ticket, worksAs: AI_ID },
        request(),
        reply,
      ),
    );
    expect(missing.status).toBe(404);
    expect(bare.granted).toHaveLength(0);
  });

  it('"me" is the ordinary consent, unchanged', async () => {
    const { controller, granted } = build(port);
    const { ticket } = await controller.view(session, {}, request(), reply);
    await controller.approve(
      context,
      session,
      { ticket, worksAs: 'me', scopes: ['tmanage:write'] },
      request(),
      reply,
    );
    expect(granted[0]).toMatchObject({ scopes: ['tmanage:read', 'tmanage:write'] });
    expect(granted[0]?.['worksAs']).toBeUndefined();
  });
});

describe('OAuthService.grantConsent: works as', () => {
  function build() {
    const grants: NewGrant[] = [];
    const codes: unknown[] = [];
    const database = {
      transaction: async <T>(_c: unknown, work: (r: unknown) => Promise<T>) => work({ tx: true }),
    } as unknown as TenantDatabase;
    const repository = {
      insertGrant: async (_r: unknown, grant: NewGrant) => {
        grants.push(grant);
      },
      insertCode: async (_r: unknown, code: unknown) => {
        codes.push(code);
      },
    } as unknown as OauthTokensRepository;
    const service = new OAuthService({
      database,
      repository,
      issuer: 'https://tmanage.example',
      canonicalResource: 'https://tmanage.example/mcp',
    });
    return { service, grants, codes };
  }
  const input = {
    clientPk: 'pk',
    membershipId: PERSON_M,
    userId: PERSON_USER,
    redirectUri: validated.redirectUri,
    challenge: validated.challenge,
    resource: validated.resource,
    scopes: ['tmanage:read', 'tmanage:write', 'tmanage:manage'],
    state: 'xyz',
  };

  it('binds the grant to the AI employee with tmanage:agent only and names the person', async () => {
    const { service, grants, codes } = build();
    const seen: string[] = [];
    await service.grantConsent(
      context,
      {
        ...input,
        worksAs: async (tx, _c, grantId) => {
          expect(tx).toEqual({ tx: true });
          seen.push(grantId);
          return { membershipId: AI_M, userId: AI_USER };
        },
      },
      { grantId: 'grant-1' },
    );
    expect(seen).toEqual(['grant-1']);
    expect(grants).toEqual([
      expect.objectContaining({
        id: 'grant-1',
        membershipId: AI_M,
        userId: AI_USER,
        scopes: 'tmanage:agent',
        authorizedByMembershipId: PERSON_M,
      }),
    ]);
    expect(codes).toHaveLength(1);
  });

  it('a refused binding writes no grant and no code', async () => {
    const { service, grants, codes } = build();
    const refusedBinding = refusal(
      service.grantConsent(
        context,
        {
          ...input,
          worksAs: async () => {
            throw new ApiError(403, 'forbidden', 'no', undefined, 'ai_employee:not_sponsor');
          },
        },
        { grantId: 'grant-2' },
      ),
    );
    expect((await refusedBinding).auditCode).toBe('ai_employee:not_sponsor');
    expect(grants).toEqual([]);
    expect(codes).toEqual([]);
  });

  it('a person’s own grant is unchanged (no authorized-by, no agent scope)', async () => {
    const { service, grants } = build();
    await service.grantConsent(context, input, { grantId: 'grant-3' });
    expect(grants[0]).toMatchObject({
      membershipId: PERSON_M,
      scopes: 'tmanage:read tmanage:write tmanage:manage',
    });
    expect(grants[0]?.authorizedByMembershipId).toBeUndefined();
  });

  it('never combines works-as with the platform scope', async () => {
    const { service, grants } = build();
    await expect(
      service.grantConsent(
        context,
        {
          ...input,
          platform: { stepUpSessionId: 's', until: new Date() },
          worksAs: async () => ({ membershipId: AI_M, userId: AI_USER }),
        },
        { grantId: 'grant-4' },
      ),
    ).rejects.toThrow();
    expect(grants).toEqual([]);
  });
});

function executionFor(request: unknown): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const reflector = { getAllAndOverride: () => false } as never;

describe('SessionAuthGuard: a connector that works as an AI employee', () => {
  function guardWith(scopes: string) {
    const events = { recordGuardRefusal: vi.fn() };
    const mcpOAuth = {
      authenticate: vi.fn(async () => ({
        grantId: 'grant-1',
        userId: AI_USER,
        membershipId: AI_M,
        organizationId: ORG,
        scopes,
        clientId: 'pk',
        clientName: 'Claude',
      })),
    };
    const guard = new SessionAuthGuard(
      reflector,
      { authenticate: vi.fn() } as never,
      { cookieName: 'tm', sessionSecret: 's', csrfSecret: 'c' } as never,
      events as never,
      { authenticate: vi.fn() } as never,
      mcpOAuth as never,
    );
    return { guard, events };
  }
  const mcpRequest = () => ({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: 'Bearer opaque-oauth-access-token' },
  });

  it('is an agent credential: the tool wall refuses /mcp and records it', async () => {
    const { guard, events } = guardWith('tmanage:agent');
    const request = mcpRequest();
    const refused = await refusal(guard.canActivate(executionFor(request)));
    expect([refused.status, refused.auditCode]).toEqual([403, 'agent_tool_wall']);
    expect(requireRequestState(request).personalAccessToken).toMatchObject({
      membershipId: AI_M,
      agent: true,
    });
    expect(events.recordGuardRefusal).toHaveBeenCalled();
  });

  it('a person’s grant is untouched', async () => {
    const { guard } = guardWith('tmanage:read tmanage:write');
    const request = mcpRequest();
    await expect(guard.canActivate(executionFor(request))).resolves.toBe(true);
    expect(requireRequestState(request).personalAccessToken?.agent).toBeUndefined();
  });
});

describe('TenantContextGuard: an AI connector is gated as an agent credential', () => {
  class GatedGuard extends TenantContextGuard {
    constructor(private readonly fake: AgentGate) {
      super(
        reflector,
        {
          resolve: async () => ({
            context: { ...context, membershipId: AI_M, userId: AI_USER },
            role: 'member',
            clientOrganizationId: null,
            hasOrgWideScope: false,
            workspaceScopeId: null,
            overrides: { allow: [], deny: [] },
          }),
        } as never,
        { load: async () => ({ projectIds: [] }) as unknown as Principal } as never,
        { read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}) } as never,
      );
    }
    protected override agentGate(): AgentGate {
      return this.fake;
    }
  }

  it('asks the gate with agentCredential: true, and its refusal stops the call', async () => {
    const fake: AgentGate = {
      decide: vi.fn(async () => {
        throw new ApiError(403, 'forbidden', 'paused', undefined, 'agent:paused');
      }),
    };
    const guard = new GatedGuard(fake);
    const request = { params: { orgSlug: 'acme' }, headers: {} };
    const state = requireRequestState(request);
    state.session = { sessionId: 'oauth:grant-1', userId: AI_USER };
    state.authScheme = 'ai_grant';
    state.personalAccessToken = { organizationId: ORG, membershipId: AI_M, agent: true };
    const refused = await refusal(guard.canActivate(executionFor(request)));
    expect(refused.auditCode).toBe('agent:paused');
    expect(fake.decide).toHaveBeenCalledWith(expect.objectContaining({ agentCredential: true }));
  });
});
