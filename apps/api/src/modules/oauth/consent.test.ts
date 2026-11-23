import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import {
  CONSENT_TICKET_TTL_MS,
  ConsentTickets,
  PLATFORM_AI_SCOPE_DEFAULT_MINUTES,
  describeClient,
  platformAiScopeMinutes,
  platformWindowEnd,
  resolveGrantedScopes,
  type ConsentBinding,
  type PlatformConsentStanding,
} from './consent.js';
import { OAuthConsentController } from './consent.controller.js';
import type { OAuthService, ValidatedAuthorize } from './oauth.service.js';
import { insufficientScopeChallenge, requiredScopeFor } from './scopes.js';

/**
 * MCP connector S9 — the consent page's server rules (threat model B2; T-CON-01, T-CON-03) and
 * the step-up challenge (T-SCP-01). The pages' framing headers (T-CON-02) are set by
 * `apps/web/next.config.ts`; CSRF on the decision is the global `CsrfGuard`.
 */

const binding: ConsentBinding = {
  sessionId: 'session-a',
  userId: 'user-1',
  clientId: 'https://claude.ai/oauth/claude-metadata.json',
  redirectUri: 'https://claude.ai/api/mcp/auth_callback',
  challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  resource: 'https://tmanage.example/mcp',
  state: 'xyz',
};

describe('describeClient (T-CON-01)', () => {
  it('names the publisher and redirect host of a verified client', () => {
    expect(describeClient({ name: 'Claude', verified: true, ...binding })).toEqual({
      name: 'Claude',
      verified: true,
      publisher: 'Anthropic',
      redirectHost: 'claude.ai',
      loopback: false,
    });
  });

  it('never gives an unverified client a publisher, and flags a loopback redirect', () => {
    const view = describeClient({
      name: 'Field notes bot',
      verified: false,
      clientId: 'https://claude.ai.evil.example/meta.json',
      redirectUri: 'http://127.0.0.1:8123/cb',
    });
    expect(view.publisher).toBeNull();
    expect(view.redirectHost).toBe('127.0.0.1');
    expect(view.loopback).toBe(true);
  });
});

describe('consent tickets (T-CON-03)', () => {
  const key = Buffer.alloc(32, 7);

  it('accepts the ticket from the same session and parameters', () => {
    const tickets = new ConsentTickets(key, () => 1_000);
    expect(tickets.verify(tickets.mint(binding), binding)).toBe(true);
  });

  it('refuses another session, a changed redirect or challenge, and garbage', () => {
    const tickets = new ConsentTickets(key, () => 1_000);
    const ticket = tickets.mint(binding);
    expect(tickets.verify(ticket, { ...binding, sessionId: 'session-b' })).toBe(false);
    expect(tickets.verify(ticket, { ...binding, redirectUri: 'https://evil.example/cb' })).toBe(
      false,
    );
    expect(tickets.verify(ticket, { ...binding, challenge: 'other' })).toBe(false);
    expect(tickets.verify('1000.not-a-mac', binding)).toBe(false);
    expect(tickets.verify(undefined, binding)).toBe(false);
  });

  it('expires after ten minutes and does not survive a new key', () => {
    let now = 1_000;
    const tickets = new ConsentTickets(key, () => now);
    const ticket = tickets.mint(binding);
    now += CONSENT_TICKET_TTL_MS + 1;
    expect(tickets.verify(ticket, binding)).toBe(false);
    expect(new ConsentTickets(Buffer.alloc(32, 8), () => 1_000).verify(ticket, binding)).toBe(
      false,
    );
  });
});

describe('resolveGrantedScopes', () => {
  it('always includes read and drops unknown scopes', () => {
    expect(resolveGrantedScopes(['tmanage:write', 'tmanage:root'], 'member')).toEqual({
      ok: true,
      scopes: ['tmanage:read', 'tmanage:write'],
    });
  });

  it('lets only owners and organization admins grant billing', () => {
    expect(resolveGrantedScopes(['tmanage:billing'], 'member')).toEqual({ ok: false });
    expect(resolveGrantedScopes(['tmanage:billing'], 'org_admin')).toEqual({
      ok: true,
      scopes: ['tmanage:read', 'tmanage:billing'],
    });
  });
});

describe('step-up challenge (T-SCP-01)', () => {
  it('answers 403 insufficient_scope naming held plus missing scopes', () => {
    const required = requiredScopeFor('manage');
    expect(required).toBe('tmanage:manage');
    expect(
      insufficientScopeChallenge({
        grantedScopes: 'tmanage:read',
        required: required ?? '',
        resourceMetadataUrl: 'https://t.example/.well-known/oauth-protected-resource/mcp',
      }),
    ).toEqual({
      status: 403,
      wwwAuthenticate:
        'Bearer error="insufficient_scope", scope="tmanage:read tmanage:manage", ' +
        'resource_metadata="https://t.example/.well-known/oauth-protected-resource/mcp"',
    });
  });
});

describe('OAuthConsentController', () => {
  const validated: ValidatedAuthorize = {
    clientPk: 'pk',
    clientId: binding.clientId,
    clientName: 'Claude',
    verified: true,
    redirectUri: binding.redirectUri,
    challenge: binding.challenge,
    scopes: ['tmanage:read', 'tmanage:write'],
    resource: binding.resource,
    state: binding.state,
  };
  const granted: unknown[] = [];
  const oauth = {
    validateAuthorize: async () => validated,
    grantConsent: async (_ctx: unknown, input: unknown) => {
      granted.push(input);
      return { redirectUrl: 'https://claude.ai/api/mcp/auth_callback?code=c', code: 'c' };
    },
    buildRedirect: (uri: string) => `${uri}?error=access_denied`,
  } as unknown as OAuthService;
  const tickets = new ConsentTickets(Buffer.alloc(32, 1));
  const aiOn = {
    platformOn: async () => true,
    organizationOn: async () => true,
    forget: () => undefined,
  };
  const controller = new OAuthConsentController(oauth, tickets, aiOn);
  const reply = { header: () => reply };
  const context = { organizationId: 'org', userId: 'user-1', membershipId: 'm' } as TenantContext;

  function request(authScheme: 'cookie' | 'personal_access_token', role = 'member') {
    const req = { headers: {} };
    const state = ensureRequestState(req);
    state.authScheme = authScheme;
    state.membership = { role } as never;
    return req;
  }

  it('refuses a token-authenticated caller on every route', async () => {
    const session = { sessionId: 'session-a', userId: 'user-1' };
    await expect(
      controller.view(session, {}, request('personal_access_token'), reply),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      controller.deny({}, request('personal_access_token'), reply),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('approves only with the ticket minted for this session, bound to the chosen org', async () => {
    const session = { sessionId: 'session-a', userId: 'user-1' };
    const { ticket } = await controller.view(session, {}, request('cookie'), reply);

    const other = { sessionId: 'session-b', userId: 'user-1' };
    await expect(
      controller.approve(context, other, { ticket }, request('cookie'), reply),
    ).rejects.toMatchObject({ status: 403 });
    expect(granted).toHaveLength(0);

    const result = await controller.approve(
      context,
      session,
      { ticket, scopes: ['tmanage:write'] },
      request('cookie'),
      reply,
    );
    expect(result.redirectUrl).toContain('code=c');
    expect(granted[0]).toMatchObject({
      membershipId: 'm',
      scopes: ['tmanage:read', 'tmanage:write'],
    });
  });

  it('refuses billing from a plain member', async () => {
    const session = { sessionId: 'session-a', userId: 'user-1' };
    const { ticket } = await controller.view(session, {}, request('cookie'), reply);
    await expect(
      controller.approve(
        context,
        session,
        { ticket, scopes: ['tmanage:billing'] },
        request('cookie', 'member'),
        reply,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('ADR-0015 F1/F11 — the tmanage:platform consent scope', () => {
  it('is refused (not dropped) unless the person is eligible right now', () => {
    expect(resolveGrantedScopes(['tmanage:platform'], 'owner')).toEqual({ ok: false });
    expect(resolveGrantedScopes(['tmanage:platform'], 'owner', false)).toEqual({ ok: false });
    expect(resolveGrantedScopes(['tmanage:platform', 'tmanage:write'], 'member', true)).toEqual({
      ok: true,
      scopes: ['tmanage:read', 'tmanage:write', 'tmanage:platform'],
    });
  });

  it('has its own short window: 5–240 minutes, default 60, never past the step-up', () => {
    expect(platformAiScopeMinutes({})).toBe(PLATFORM_AI_SCOPE_DEFAULT_MINUTES);
    expect(platformAiScopeMinutes({ PLATFORM_AI_SCOPE_MINUTES: '15' })).toBe(15);
    for (const bad of ['4', '241', '1440', '-5', '1e3', 'soon', ''])
      expect(platformAiScopeMinutes({ PLATFORM_AI_SCOPE_MINUTES: bad }), bad).toBe(60);
    const now = new Date('2026-11-23T10:00:00Z');
    expect(platformWindowEnd(now, 60, null).toISOString()).toBe('2026-11-23T11:00:00.000Z');
    expect(platformWindowEnd(now, 60, new Date('2026-11-23T10:20:00Z')).toISOString()).toBe(
      '2026-11-23T10:20:00.000Z',
    );
  });

  describe('the consent controller', () => {
    const validated: ValidatedAuthorize = {
      clientPk: 'pk',
      clientId: binding.clientId,
      clientName: 'Claude',
      verified: true,
      redirectUri: binding.redirectUri,
      challenge: binding.challenge,
      scopes: ['tmanage:read', 'tmanage:platform'],
      resource: binding.resource,
      state: binding.state,
    };
    const aiOn = {
      platformOn: async () => true,
      organizationOn: async () => true,
      forget: () => undefined,
    };
    const reply = { header: () => reply };
    const context = { organizationId: 'org', userId: 'user-1', membershipId: 'm' } as TenantContext;
    const session = { sessionId: 'session-a', userId: 'user-1' };
    function request() {
      const req = { headers: {} };
      const state = ensureRequestState(req);
      state.authScheme = 'cookie';
      state.membership = { role: 'member' } as never;
      return req;
    }
    function controllerWith(standing: PlatformConsentStanding | undefined) {
      const granted: Record<string, unknown>[] = [];
      const oauth = {
        validateAuthorize: async () => validated,
        grantConsent: async (_ctx: unknown, input: Record<string, unknown>) => {
          granted.push(input);
          return { redirectUrl: 'https://claude.ai/cb?code=c', code: 'c' };
        },
        buildRedirect: (uri: string) => `${uri}?error=access_denied`,
      } as unknown as OAuthService;
      const check = standing === undefined ? undefined : { standing: async () => standing };
      const controller = new OAuthConsentController(
        oauth,
        new ConsentTickets(Buffer.alloc(32, 1)),
        aiOn,
        check,
      );
      return { controller, granted };
    }

    it('never pre-ticks it and offers it to platform admins only', async () => {
      const plain = controllerWith(undefined);
      const view = await plain.controller.view(session, {}, request(), reply);
      expect(view.requestedScopes).not.toContain('tmanage:platform');
      expect(view.platform).toEqual({ offered: false, ready: false });
      const admin = controllerWith({ offered: true, ready: false, stepUpExpiresAt: null });
      expect((await admin.controller.view(session, {}, request(), reply)).platform).toEqual({
        offered: true,
        ready: false,
      });
    });

    it('refuses it without a fresh step-up (or to a non-admin), and grants nothing', async () => {
      for (const standing of [
        undefined,
        { offered: false, ready: false, stepUpExpiresAt: null },
        { offered: true, ready: false, stepUpExpiresAt: new Date(Date.now() + 3_600_000) },
      ]) {
        const { controller, granted } = controllerWith(standing);
        const { ticket } = await controller.view(session, {}, request(), reply);
        await expect(
          controller.approve(
            context,
            session,
            { ticket, scopes: ['tmanage:platform'] },
            request(),
            reply,
          ),
        ).rejects.toMatchObject({ status: 403 });
        expect(granted).toEqual([]);
      }
    });

    it('binds a granted platform scope to this session with a window that ends', async () => {
      const stepUpEnd = new Date(Date.now() + 24 * 3_600_000);
      const { controller, granted } = controllerWith({
        offered: true,
        ready: true,
        stepUpExpiresAt: stepUpEnd,
      });
      const { ticket } = await controller.view(session, {}, request(), reply);
      const before = Date.now();
      await controller.approve(
        context,
        session,
        { ticket, scopes: ['tmanage:platform'] },
        request(),
        reply,
      );
      const platform = granted[0]!['platform'] as { stepUpSessionId: string; until: Date };
      expect(granted[0]!['scopes']).toEqual(['tmanage:read', 'tmanage:platform']);
      expect(platform.stepUpSessionId).toBe('session-a');
      const minutes = (platform.until.getTime() - before) / 60_000;
      expect(minutes).toBeGreaterThan(59);
      expect(minutes).toBeLessThanOrEqual(60.1);
    });

    it('a grant without the platform scope carries no binding', async () => {
      const { controller, granted } = controllerWith({
        offered: true,
        ready: true,
        stepUpExpiresAt: null,
      });
      const { ticket } = await controller.view(session, {}, request(), reply);
      await controller.approve(context, session, { ticket, scopes: [] }, request(), reply);
      expect(granted[0]!['platform']).toBeUndefined();
    });
  });
});
