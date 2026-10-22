import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import {
  CONSENT_TICKET_TTL_MS,
  ConsentTickets,
  describeClient,
  resolveGrantedScopes,
  type ConsentBinding,
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
  const controller = new OAuthConsentController(oauth, tickets);
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
