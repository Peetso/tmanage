import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { SessionAuthGuard } from '../../common/http/guards/session-auth.guard.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { SessionNotAuthenticatedError } from '../identity/session.service.js';
import { PersonalAccessTokenNotAuthenticatedError } from '../personal-access-tokens/personal-access-tokens.service.js';
import {
  McpOAuthAuthenticator,
  McpOAuthNotAuthenticatedError,
  mcpOAuthAccessFor,
} from './mcp-auth.js';
import type { McpOAuthAccess } from './mcp-auth.js';

/**
 * `/mcp` as an OAuth protected resource (FX2): the access-token check (live, audience, grant in
 * force, scopes narrowed to the grant) and the guard branch that accepts such a token on `/mcp`
 * only. No server and no database: the repository and the database are fakes.
 */

const RESOURCE = 'https://tmanage.example/mcp';

function authenticator(row: object | null, grant: object | null): McpOAuthAuthenticator {
  const database = {
    // First the token lookup (through the repository), then the client-name query, stood in here
    // so no driver is needed.
    identityRead: vi
      .fn()
      .mockImplementationOnce(async (_o: unknown, work: (db: unknown) => Promise<unknown>) =>
        work({}),
      )
      .mockImplementationOnce(async () => 'Claude'),
    bootstrapRead: vi.fn(async (_o: unknown, work: (db: unknown) => Promise<unknown>) => work({})),
  };
  const repo = {
    findLiveAccessTokenByHash: vi.fn(async () => row),
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
  scopes: 'tmanage:read',
  revokedAt: null,
};

describe('McpOAuthAuthenticator', () => {
  it('accepts a live token for this resource and narrows its scopes to the grant', async () => {
    const access = await authenticator(
      { grantId: 'g1', audience: RESOURCE, scopes: 'tmanage:read tmanage:write' },
      GRANT,
    ).authenticate('token', 'c1');
    expect(access).toEqual({
      grantId: 'g1',
      userId: 'u1',
      membershipId: 'm-a',
      organizationId: 'org-a',
      scopes: 'tmanage:read',
      clientId: 'client-1',
      clientName: 'Claude',
    });
  });

  it.each([
    ['an unknown, expired or revoked token', null, GRANT, 'oauth_token_unknown'],
    [
      'a token for another resource',
      { grantId: 'g1', audience: 'https://other.example/mcp', scopes: 'tmanage:read' },
      GRANT,
      'oauth_token_wrong_audience',
    ],
    [
      'a token whose grant was revoked',
      { grantId: 'g1', audience: RESOURCE, scopes: 'tmanage:read' },
      { ...GRANT, revokedAt: new Date() },
      'oauth_grant_revoked',
    ],
  ])('refuses %s', async (_label, row, grant, code) => {
    await expect(authenticator(row, grant).authenticate('token', 'c1')).rejects.toMatchObject({
      constructor: McpOAuthNotAuthenticatedError,
      code,
    });
  });
});

describe('SessionAuthGuard — OAuth access tokens on /mcp only', () => {
  const ACCESS: McpOAuthAccess = {
    grantId: 'g1',
    userId: 'u1',
    membershipId: 'm-a',
    organizationId: 'org-a',
    scopes: 'tmanage:read',
    clientId: 'client-1',
    clientName: 'Claude',
  };

  function guard(oauth: { authenticate: (t: string) => Promise<McpOAuthAccess> }) {
    return new SessionAuthGuard(
      { getAllAndOverride: () => false } as never,
      {
        authenticate: vi.fn(async () => {
          throw new SessionNotAuthenticatedError('no_cookie');
        }),
      } as never,
      { cookieName: 'tm', apiPublicUrl: 'https://tmanage.example' } as never,
      { recordGuardRefusal: vi.fn() } as never,
      {
        authenticate: vi.fn(async () => {
          throw new PersonalAccessTokenNotAuthenticatedError('unknown');
        }),
      } as never,
      oauth,
    );
  }

  function request(url: string) {
    return { url, headers: { authorization: 'Bearer opaque-token' }, raw: {} };
  }

  function contextFor(req: object): ExecutionContext {
    return {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  it('authenticates the bound principal and hands the grant to the endpoint', async () => {
    const req = request('/mcp');
    await expect(
      guard({ authenticate: async () => ACCESS }).canActivate(contextFor(req)),
    ).resolves.toBe(true);
    const state = requireRequestState(req);
    expect(state.personalAccessToken).toEqual({ organizationId: 'org-a', membershipId: 'm-a' });
    expect(mcpOAuthAccessFor(state)).toEqual(ACCESS);
  });

  it('is not a key to the REST API: the same token on another route is a plain 401', async () => {
    const oauth = { authenticate: vi.fn(async () => ACCESS) };
    const req = request('/v1/organizations/acme/work-items');
    await expect(guard(oauth).canActivate(contextFor(req))).rejects.toMatchObject({ status: 401 });
    expect(oauth.authenticate).not.toHaveBeenCalled();
    expect(mcpOAuthAccessFor(requireRequestState(req))).toBeUndefined();
  });

  it('refuses a token that does not authenticate with the 401 challenge', async () => {
    const oauth = {
      authenticate: async (): Promise<McpOAuthAccess> => {
        throw new McpOAuthNotAuthenticatedError('oauth_token_wrong_audience');
      },
    };
    await expect(guard(oauth).canActivate(contextFor(request('/mcp')))).rejects.toMatchObject({
      status: 401,
      auditCode: 'oauth_token_wrong_audience',
      wwwAuthenticate:
        'Bearer resource_metadata="https://tmanage.example/.well-known/oauth-protected-resource/mcp", scope="tmanage:read"',
    });
  });
});
