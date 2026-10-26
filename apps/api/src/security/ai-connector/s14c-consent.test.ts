import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { OauthClientRow } from '../../common/database/schema.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import type { AiAccessSwitches } from '../../modules/oauth/ai-access.js';
import { ConsentTickets } from '../../modules/oauth/consent.js';
import { OAuthConsentController } from '../../modules/oauth/consent.controller.js';
import type { OauthTokensRepository } from '../../modules/oauth/oauth-tokens.repository.js';
import { OAuthService } from '../../modules/oauth/oauth.service.js';

/**
 * S14C — consent screen backend (threat model B2). The real `OAuthService.validateAuthorize`
 * behind the real consent controller, over an in-memory client table: nothing the consent URL or
 * the decision body says is trusted, and no grant is ever written for an unknown client, an
 * unregistered redirect, an unknown scope, or a request other than the one the ticket was minted
 * for.
 */

const ISSUER = 'https://tmanage.example';
const RESOURCE = `${ISSUER}/mcp`;
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function client(id: string, clientId: string, redirect: string): OauthClientRow {
  return {
    id,
    clientId,
    kind: 'dcr',
    name: `App ${id}`,
    redirectUrisJson: [redirect],
    verified: false,
    createdIpHash: null,
    lastUsedAt: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
  };
}

const CLIENTS = [
  client('pk-a', 'dcr-client-a', 'https://app-a.example/cb'),
  client('pk-b', 'dcr-client-b', 'https://app-b.example/cb'),
];

const database = {
  identityRead: (_o: unknown, fn: (db: unknown) => unknown) => fn({}),
  bootstrapRead: (_o: unknown, fn: (db: unknown) => unknown) => fn({}),
  identityTransaction: (_o: unknown, fn: (db: unknown) => unknown) => fn({}),
  transaction: (_c: unknown, fn: (db: unknown) => unknown) => fn({}),
} as unknown as TenantDatabase;

function setup(options: { workspaceOn?: boolean } = {}) {
  const repository = {
    findClientByClientId: vi.fn(
      async (_db: unknown, clientId: string) =>
        CLIENTS.find((c) => c.clientId === clientId) ?? null,
    ),
    insertGrant: vi.fn(async () => undefined),
    insertCode: vi.fn(async () => undefined),
  };
  const oauth = new OAuthService({
    database,
    repository: repository as unknown as OauthTokensRepository,
    issuer: ISSUER,
    canonicalResource: RESOURCE,
    // N04 re-reads the consenting session after the grant commits; here it is live and user-1's.
    sessions: {
      findById: async (_db: unknown, sessionId: string) =>
        sessionId === 'session-a'
          ? ({ session: { userId: 'user-1', revokedAt: null }, expired: false } as never)
          : null,
    },
  });
  const aiAccess: AiAccessSwitches = {
    platformOn: async () => true,
    organizationOn: async () => options.workspaceOn ?? true,
    forget: () => undefined,
  };
  const controller = new OAuthConsentController(
    oauth,
    new ConsentTickets(Buffer.alloc(32, 3)),
    aiAccess,
  );
  return { controller, repository };
}

const session = { sessionId: 'session-a', userId: 'user-1' };
const context = {
  organizationId: 'org-1',
  userId: 'user-1',
  membershipId: 'mem-1',
} as TenantContext;
const reply = { header: () => reply };

function cookieRequest(role = 'member', authScheme: 'cookie' | 'ai_grant' = 'cookie') {
  const request = { headers: {} };
  const state = ensureRequestState(request);
  state.authScheme = authScheme;
  state.membership = { role } as never;
  return request;
}

function params(overrides: Record<string, unknown> = {}) {
  return {
    client_id: 'dcr-client-a',
    redirect_uri: 'https://app-a.example/cb',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope: 'tmanage:read tmanage:write',
    state: 's1',
    ...overrides,
  };
}

describe('S14C consent backend — unknown clients and tampered requests', () => {
  it('refuses an unknown client_id with 400 and mints no ticket', async () => {
    const { controller } = setup();
    await expect(
      controller.view(session, params({ client_id: 'never-registered' }), cookieRequest(), reply),
    ).rejects.toMatchObject({ status: 400, details: [{ message: 'invalid_client' }] });
  });

  it('refuses to approve for an unknown client and writes no grant', async () => {
    const { controller, repository } = setup();
    await expect(
      controller.approve(
        context,
        session,
        { ...params({ client_id: 'never-registered' }), ticket: '1.x' },
        cookieRequest(),
        reply,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(repository.insertGrant).not.toHaveBeenCalled();
  });

  it('refuses a redirect_uri the client did not register (no open redirect, even on deny)', async () => {
    const { controller } = setup();
    const evil = params({ redirect_uri: 'https://evil.example/cb' });
    await expect(controller.view(session, evil, cookieRequest(), reply)).rejects.toMatchObject({
      status: 400,
    });
    await expect(controller.deny(evil, cookieRequest(), reply)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('refuses an unknown scope in the request instead of silently dropping it', async () => {
    const { controller } = setup();
    await expect(
      controller.view(
        session,
        params({ scope: 'tmanage:read tmanage:root' }),
        cookieRequest(),
        reply,
      ),
    ).rejects.toMatchObject({ status: 400, details: [{ field: 'scope' }] });
  });

  it('refuses a plain PKCE method and a foreign resource', async () => {
    const { controller } = setup();
    await expect(
      controller.view(session, params({ code_challenge_method: 'plain' }), cookieRequest(), reply),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.view(
        session,
        params({ resource: 'https://other.example/mcp' }),
        cookieRequest(),
        reply,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("a ticket minted for client A cannot approve client B's request", async () => {
    const { controller, repository } = setup();
    const { ticket } = await controller.view(session, params(), cookieRequest(), reply);
    await expect(
      controller.approve(
        context,
        session,
        {
          ...params({ client_id: 'dcr-client-b', redirect_uri: 'https://app-b.example/cb' }),
          ticket,
        },
        cookieRequest(),
        reply,
      ),
    ).rejects.toMatchObject({ status: 403, auditCode: 'consent_ticket_invalid' });
    expect(repository.insertGrant).not.toHaveBeenCalled();
  });

  it('a ticket does not survive a swapped PKCE challenge (code-injection defence)', async () => {
    const { controller, repository } = setup();
    const { ticket } = await controller.view(session, params(), cookieRequest(), reply);
    await expect(
      controller.approve(
        context,
        session,
        { ...params({ code_challenge: 'attacker-challenge-attacker-challenge-xyz12' }), ticket },
        cookieRequest(),
        reply,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(repository.insertGrant).not.toHaveBeenCalled();
  });
});

describe('S14C consent backend — scope escalation and who may decide', () => {
  it('grants only known scopes: an injected unknown scope in the decision is dropped', async () => {
    const { controller, repository } = setup();
    const { ticket } = await controller.view(session, params(), cookieRequest(), reply);
    await controller.approve(
      context,
      session,
      { ...params(), ticket, scopes: ['tmanage:write', 'tmanage:admin', '*', 42] },
      cookieRequest(),
      reply,
    );
    expect(repository.insertGrant).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ scopes: 'tmanage:read tmanage:write', organizationId: 'org-1' }),
    );
  });

  it('refuses billing from a non-admin even when the client asked for it', async () => {
    const { controller, repository } = setup();
    const asked = params({ scope: 'tmanage:read tmanage:billing' });
    const { ticket } = await controller.view(session, asked, cookieRequest(), reply);
    await expect(
      controller.approve(
        context,
        session,
        { ...asked, ticket, scopes: ['tmanage:billing'] },
        cookieRequest('member'),
        reply,
      ),
    ).rejects.toMatchObject({ status: 403, auditCode: 'consent_billing_role' });
    expect(repository.insertGrant).not.toHaveBeenCalled();
  });

  it('an AI internal grant can never approve a connection', async () => {
    const { controller, repository } = setup();
    const { ticket } = await controller.view(session, params(), cookieRequest(), reply);
    await expect(
      controller.approve(
        context,
        session,
        { ...params(), ticket },
        cookieRequest('owner', 'ai_grant'),
        reply,
      ),
    ).rejects.toMatchObject({ status: 403, auditCode: 'consent_needs_session' });
    expect(repository.insertGrant).not.toHaveBeenCalled();
  });

  it('refuses a new connection while the workspace AI switch is off', async () => {
    const { controller, repository } = setup({ workspaceOn: false });
    const { ticket } = await controller.view(session, params(), cookieRequest(), reply);
    await expect(
      controller.approve(context, session, { ...params(), ticket }, cookieRequest(), reply),
    ).rejects.toMatchObject({ status: 403, auditCode: 'ai_disabled' });
    expect(repository.insertGrant).not.toHaveBeenCalled();
  });
});
