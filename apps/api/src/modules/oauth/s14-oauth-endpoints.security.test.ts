import { describe, expect, it, vi } from 'vitest';
import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';
import { HttpExceptionFilter } from '../../common/http/http-exception.filter.js';
import { SessionAuthGuard } from '../../common/http/guards/session-auth.guard.js';
import { SessionNotAuthenticatedError } from '../identity/session.service.js';
import { PersonalAccessTokenNotAuthenticatedError } from '../personal-access-tokens/personal-access-tokens.service.js';
import { OAuthMetadataController } from './metadata.controller.js';
import { OAuthRegisterController } from './register.controller.js';
import { OAuthRevokeController } from './revoke.controller.js';
import { OAuthTokenController } from './token.controller.js';
import { DcrRateLimitError, OAuthError, type OAuthService } from './oauth.service.js';

/**
 * S14A — the HTTP edges of the OAuth 2.1 core for `/mcp`: discovery metadata (RFC 9728 / 8414),
 * Dynamic Client Registration input validation (RFC 7591, T-DCR-01/02), the token and revoke
 * endpoints' error shapes, and the `/mcp` 401 challenge. Controllers are constructed directly
 * over a fake `OAuthService`; no server and no database.
 */

const ISSUER = 'https://tmanage.example';
const RESOURCE = `${ISSUER}/mcp`;
const PRM_URL = `${ISSUER}/.well-known/oauth-protected-resource/mcp`;

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function fakeReply(): { reply: never; out: Captured } {
  const out: Captured = { status: 0, headers: {}, body: undefined };
  const reply = {
    status(code: number) {
      out.status = code;
      return reply;
    },
    header(name: string, value: string) {
      out.headers[name.toLowerCase()] = value;
      return reply;
    },
    send(payload: unknown) {
      out.body = payload;
      return reply;
    },
  };
  return { reply: reply as never, out };
}

const request = () => ({ headers: {}, ip: '203.0.113.7' }) as never;

function oauthFake(overrides: Partial<Record<keyof OAuthService, unknown>> = {}): OAuthService {
  return {
    issuerUrl: ISSUER,
    resourceUri: RESOURCE,
    registerClient: vi.fn(async (input: { name: string; redirectUris: string[] }) => ({
      clientPk: 'pk',
      clientId: 'opaque-id',
      name: input.name,
      redirectUris: input.redirectUris,
    })),
    exchangeCode: vi.fn(),
    refresh: vi.fn(),
    revoke: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as OAuthService;
}

describe('S14A protected-resource and AS metadata (T-OA-01)', () => {
  const metadata = new OAuthMetadataController(oauthFake());

  it('PRM names exactly the canonical /mcp resource and exactly one authorization server', () => {
    for (const doc of [metadata.protectedResource(), metadata.protectedResourceForMcp()]) {
      expect(doc['resource']).toBe(RESOURCE);
      expect(doc['authorization_servers']).toEqual([ISSUER]);
      expect(doc['bearer_methods_supported']).toEqual(['header']);
    }
  });

  it('AS metadata advertises S256 only, public clients only, code flow only, and iss', () => {
    const as = metadata.authorizationServer();
    expect(as['issuer']).toBe(ISSUER);
    expect(as['code_challenge_methods_supported']).toEqual(['S256']);
    expect(as['token_endpoint_auth_methods_supported']).toEqual(['none']);
    expect(as['response_types_supported']).toEqual(['code']);
    expect(as['grant_types_supported']).toEqual(['authorization_code', 'refresh_token']);
    expect(as['authorization_response_iss_parameter_supported']).toBe(true);
    for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
      expect(String(as[key]).startsWith(`${ISSUER}/oauth/`)).toBe(true);
    }
  });
});

describe('S14A dynamic client registration input validation (T-DCR-01, T-DCR-02)', () => {
  it.each([
    ['a non-object body', ['https://app.example/cb'], 'invalid_client_metadata'],
    ['no redirect_uris', { client_name: 'x' }, 'invalid_redirect_uri'],
    ['a javascript: redirect', { redirect_uris: ['javascript:alert(1)'] }, 'invalid_redirect_uri'],
    ['a data: redirect', { redirect_uris: ['data:text/html,x'] }, 'invalid_redirect_uri'],
    ['http non-loopback', { redirect_uris: ['http://app.example/cb'] }, 'invalid_redirect_uri'],
    [
      'a fragment redirect',
      { redirect_uris: ['https://app.example/cb#f'] },
      'invalid_redirect_uri',
    ],
    [
      'eleven redirects',
      { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`) },
      'invalid_redirect_uri',
    ],
    [
      'client_credentials',
      { redirect_uris: ['https://app.example/cb'], grant_types: ['client_credentials'] },
      'invalid_client_metadata',
    ],
    [
      'implicit response type',
      { redirect_uris: ['https://app.example/cb'], response_types: ['token'] },
      'invalid_client_metadata',
    ],
    [
      'a secret auth method',
      {
        redirect_uris: ['https://app.example/cb'],
        token_endpoint_auth_method: 'client_secret_post',
      },
      'invalid_client_metadata',
    ],
    [
      'an http logo_uri',
      { redirect_uris: ['https://app.example/cb'], logo_uri: 'http://x/l.png' },
      'invalid_client_metadata',
    ],
  ])('refuses %s with 400 and writes nothing', async (_label, body, code) => {
    const oauth = oauthFake();
    const { reply, out } = fakeReply();
    await new OAuthRegisterController(oauth).register(request(), reply, body);
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ error: code });
    expect(out.headers['cache-control']).toBe('no-store');
    expect(oauth.registerClient).not.toHaveBeenCalled();
  });

  it('registers a valid public client with a sanitised name and never issues a secret', async () => {
    const oauth = oauthFake();
    const { reply, out } = fakeReply();
    await new OAuthRegisterController(oauth).register(request(), reply, {
      client_name: '<b>Evil</b>\u0000\nApp',
      redirect_uris: ['https://app.example/cb', 'https://app.example/cb'],
      client_secret: 'attacker-chosen',
    });
    expect(out.status).toBe(201);
    const body = out.body as Record<string, unknown>;
    expect(body['client_secret']).toBeUndefined();
    expect(body['token_endpoint_auth_method']).toBe('none');
    expect(body['redirect_uris']).toEqual(['https://app.example/cb']);
    // eslint-disable-next-line no-control-regex -- asserting control characters were stripped.
    expect(String(body['client_name'])).not.toMatch(/[\u0000-\u001f]/);
  });

  it('answers 429 once the rate limit is reached', async () => {
    const oauth = oauthFake({
      registerClient: vi.fn(async () => {
        throw new DcrRateLimitError('too many');
      }),
    });
    const { reply, out } = fakeReply();
    await new OAuthRegisterController(oauth).register(request(), reply, {
      redirect_uris: ['https://app.example/cb'],
    });
    expect(out.status).toBe(429);
  });
});

describe('S14A token and revoke endpoints', () => {
  it('refuses an unsupported grant type (e.g. password, implicit) with the RFC error shape', async () => {
    const oauth = oauthFake();
    for (const grantType of ['password', 'client_credentials', 'implicit', undefined]) {
      const { reply, out } = fakeReply();
      await new OAuthTokenController(oauth).token(request(), reply, { grant_type: grantType });
      expect(out.status).toBe(400);
      expect(out.body).toEqual({
        error: 'unsupported_grant_type',
        error_description: expect.any(String),
      });
      expect(out.headers['cache-control']).toBe('no-store');
    }
    expect(oauth.exchangeCode).not.toHaveBeenCalled();
    expect(oauth.refresh).not.toHaveBeenCalled();
  });

  it('renders a service OAuthError as {error, error_description} with no-store and no token', async () => {
    const oauth = oauthFake({
      refresh: vi.fn(async () => {
        throw new OAuthError('invalid_grant', 'Refresh token reuse detected.', false);
      }),
    });
    const { reply, out } = fakeReply();
    await new OAuthTokenController(oauth).token(request(), reply, {
      grant_type: 'refresh_token',
      refresh_token: 'rt',
    });
    expect(out.status).toBe(400);
    expect(out.body).toEqual({
      error: 'invalid_grant',
      error_description: 'Refresh token reuse detected.',
    });
    expect(out.headers['cache-control']).toBe('no-store');
  });

  it('revoke answers 200 for any token, so it never reveals whether a token existed', async () => {
    const oauth = oauthFake();
    const controller = new OAuthRevokeController(oauth);
    await expect(controller.revoke(request(), { token: 'unknown' })).resolves.toEqual({
      status: 'ok',
    });
    await expect(controller.revoke(request(), {})).resolves.toEqual({ status: 'ok' });
  });
});

describe('S14A /mcp 401 challenge (T-OA-01)', () => {
  function sessionGuard(): SessionAuthGuard {
    return new SessionAuthGuard(
      { getAllAndOverride: () => false } as never,
      {
        authenticate: vi.fn(async () => {
          throw new SessionNotAuthenticatedError('no_cookie');
        }),
      } as never,
      { cookieName: 'tm', apiPublicUrl: ISSUER } as never,
      { recordGuardRefusal: vi.fn() } as never,
      {
        authenticate: vi.fn(async () => {
          throw new PersonalAccessTokenNotAuthenticatedError('unknown');
        }),
      } as never,
    );
  }

  /** The response the client sees for an unauthenticated POST /mcp, through the real filter. */
  async function unauthenticatedMcpResponse(authorization?: string): Promise<Captured> {
    const req = {
      method: 'POST',
      url: '/mcp',
      headers: authorization === undefined ? {} : { authorization },
      raw: {},
    };
    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    const thrown = await sessionGuard()
      .canActivate(context)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    const { reply, out } = fakeReply();
    const host = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }),
    } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(thrown, host);
    return out;
  }

  it('an unauthenticated /mcp request is refused with 401', async () => {
    expect((await unauthenticatedMcpResponse()).status).toBe(401);
    expect((await unauthenticatedMcpResponse('Bearer not-a-real-token')).status).toBe(401);
  });

  // Was S14 FINDING (fixed in FX2): MCP authorization and plan §4.1 require
  // `WWW-Authenticate: Bearer resource_metadata="<PRM URL>", scope="tmanage:read"` on the /mcp 401
  // so a client can discover the authorization server. The guard now throws a challenge-bearing
  // error on /mcp (URL from `API_PUBLIC_URL`, never a Host header) and the filter sets the header.
  it('the /mcp 401 carries WWW-Authenticate with resource_metadata', async () => {
    for (const authorization of [undefined, 'Bearer not-a-real-token']) {
      const out = await unauthenticatedMcpResponse(authorization);
      expect(out.status).toBe(401);
      const challenge = out.headers['www-authenticate'] ?? '';
      expect(challenge).toMatch(/^Bearer /);
      expect(challenge).toContain(`resource_metadata="${PRM_URL}"`);
      expect(challenge).toContain('scope="tmanage:read"');
    }
  });
});
