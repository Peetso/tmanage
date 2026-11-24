import 'reflect-metadata';
import { Body, Controller, Get, Injectable, Module, Post, Put } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpExceptionFilter } from '../../common/http/http-exception.filter.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { API_CONFIG } from '../../common/http/tokens.js';
import {
  BoundTokenConfirmInterceptor,
  PAT_CLIENT_NAME,
} from './bound-token-confirm.interceptor.js';
import { freezeConfirmAction } from '../mcp/pending-actions.js';

/**
 * Wave 9 S7 — audit NV01 (and F11 defence in depth). A confirm-class registry op reached directly
 * with a personal access token must not run: it becomes a pending approval (202) and the handler
 * is never called. A cookie session is unchanged; an everyday write still runs; a NEVER route is
 * refused for a bound token; an AI internal grant runs a confirm op only from the approve page.
 */

const handlerCalls = { invite: 0, security: 0, work: 0, agent: 0 };

// The same route templates as the real controllers, so the registry resolves them.
@Controller('v1/organizations/:orgSlug/invitations')
class FakeInvitationsController {
  @Post()
  create(@Body() _body: unknown): unknown {
    handlerCalls.invite += 1;
    return { token: 'one-time-invitation-token' };
  }
}

// A route still NEVER after parity batch 2 (K3: the SSO settings body stores a client secret).
@Controller('v1/organizations/:orgSlug/security/sso')
class FakeSecurityController {
  @Put()
  set(): unknown {
    handlerCalls.security += 1;
    return { ok: true };
  }
}

@Controller('v1/organizations/:orgSlug/work-items')
class FakeWorkItemsController {
  @Post()
  create(): unknown {
    handlerCalls.work += 1;
    return { id: 'w1' };
  }
}

// 60-10: the agent contract's REST mirror, NEVER with reason `agent_contract`.
@Controller('v1/organizations/:orgSlug/agent')
class FakeAgentController {
  @Get('me')
  whoami(): unknown {
    handlerCalls.agent += 1;
    return { name: 'Mat' };
  }
}

const TENANT = {
  organizationId: 'org-1',
  userId: 'user-1',
  membershipId: 'mem-1',
  capabilities: [],
  policyVersion: 'v1',
  correlationId: 'c1',
} as unknown as TenantContext;

/** Plays SessionAuthGuard + TenantContextGuard from test headers. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const state = ensureRequestState(request);
    const scheme = request.headers['x-test-scheme'] as
      'cookie' | 'personal_access_token' | 'ai_grant';
    state.authScheme = scheme;
    state.session = { sessionId: 'pat:token-1', userId: 'user-1' } as never;
    // 60-10: `x-test-agent` plays an agent key (`agent` on the token binding);
    // `x-test-stamp` plays the agent gate's stamp on the tenant context.
    state.tenant =
      request.headers['x-test-stamp'] === 'yes'
        ? ({
            ...TENANT,
            aiEmployee: {
              aiEmployeeId: 'ai-1',
              sponsorMembershipId: 'mem-2',
              allowedTaskTypes: [],
            },
          } as unknown as TenantContext)
        : TENANT;
    if (request.headers['x-test-agent'] === 'yes') {
      state.personalAccessToken = { organizationId: 'org-1', membershipId: 'mem-1', agent: true };
    }
    const tokenName = request.headers['x-test-token-name'];
    if (scheme === 'personal_access_token' && tokenName !== undefined) {
      state.personalAccessToken = {
        organizationId: 'org-1',
        membershipId: 'mem-1',
        name: tokenName,
      };
    }
    if (scheme === 'ai_grant') {
      state.aiGrant = {
        grantId: request.headers['x-test-grant'] ?? 'oauth:g1',
        clientId: 'client',
        clientName: 'Client',
        opId: 'x',
      };
    }
    return true;
  }
}

const approvals = {
  request: vi.fn(async () => ({
    id: 'pending-1',
    title: 'Invite someone to the workspace',
    expiresAt: new Date('2026-10-25T12:10:00.000Z'),
  })),
};

@Module({
  controllers: [
    FakeInvitationsController,
    FakeSecurityController,
    FakeWorkItemsController,
    FakeAgentController,
  ],
  providers: [
    { provide: API_CONFIG, useValue: { webPublicUrl: 'https://app.example.test' } },
    { provide: Symbol.for('tmanage.PendingAiActionsService'), useValue: approvals },
    { provide: APP_GUARD, useClass: FakeAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: BoundTokenConfirmInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
class TestModule {}

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  handlerCalls.invite = 0;
  handlerCalls.security = 0;
  handlerCalls.work = 0;
  handlerCalls.agent = 0;
  approvals.request.mockClear();
});

function inject(method: 'POST' | 'PUT', url: string, headers: Record<string, string>) {
  return app.inject({
    method,
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify({ email: 'dummy@example.test', role: 'member' }),
  });
}

describe('NV01 — confirm-class ops do not run on the personal-access-token channel', () => {
  it('PAT POST …/invitations → 202 pending approval, handler not called, no token returned', async () => {
    const res = await inject('POST', '/v1/organizations/acme/invitations', {
      'x-test-scheme': 'personal_access_token',
    });
    expect(res.statusCode).toBe(202);
    expect(handlerCalls.invite).toBe(0);
    expect(res.body).not.toContain('one-time-invitation-token');
    expect(res.json()).toEqual({
      status: 'approval_required',
      approval_id: 'pending-1',
      approval_url: 'https://app.example.test/acme/ai/approve/pending-1',
      expires_at: '2026-10-25T12:10:00.000Z',
      // Fix 6: the expiry in words, for the AI to relay.
      expires_in_words: expect.stringContaining('until 25 October 2026 at 12:10 UTC'),
    });
    expect(approvals.request).toHaveBeenCalledWith(
      {
        organizationId: 'org-1',
        membershipId: 'mem-1',
        userId: 'user-1',
        clientId: 'pat:token-1',
        clientName: PAT_CLIENT_NAME,
      },
      'invitations.create',
      { email: 'dummy@example.test', role: 'member' },
      expect.any(String),
    );
  });

  it('the held action waits under the name the member gave the token (TESTUX P1 9)', async () => {
    const res = await inject('POST', '/v1/organizations/acme/invitations', {
      'x-test-scheme': 'personal_access_token',
      'x-test-token-name': 'Claude on my laptop',
    });
    expect(res.statusCode).toBe(202);
    expect(approvals.request).toHaveBeenCalledWith(
      expect.objectContaining({ clientName: 'Claude on my laptop' }),
      'invitations.create',
      expect.any(Object),
      expect.any(String),
    );
  });

  it('the frozen args are exactly what the op schema accepts', () => {
    expect(() =>
      freezeConfirmAction('invitations.create', { email: 'dummy@example.test', role: 'member' }),
    ).not.toThrow();
  });

  it('refuses 403 (and still does not run) when the request cannot be held for approval', async () => {
    approvals.request.mockRejectedValueOnce(new Error('invalid_args'));
    const res = await inject('POST', '/v1/organizations/acme/invitations', {
      'x-test-scheme': 'personal_access_token',
    });
    expect(res.statusCode).toBe(403);
    expect(handlerCalls.invite).toBe(0);
  });

  it('a cookie session is unchanged: the invitation handler runs', async () => {
    const res = await inject('POST', '/v1/organizations/acme/invitations', {
      'x-test-scheme': 'cookie',
    });
    expect(res.statusCode).toBe(201);
    expect(handlerCalls.invite).toBe(1);
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it('an everyday write still runs with a PAT', async () => {
    const res = await inject('POST', '/v1/organizations/acme/work-items', {
      'x-test-scheme': 'personal_access_token',
    });
    expect(res.statusCode).toBe(201);
    expect(handlerCalls.work).toBe(1);
  });

  it('a NEVER tenant route (SSO settings) is refused 403 for a PAT', async () => {
    const res = await inject('PUT', '/v1/organizations/acme/security/sso', {
      'x-test-scheme': 'personal_access_token',
    });
    expect(res.statusCode).toBe(403);
    expect(handlerCalls.security).toBe(0);
  });

  it('an AI internal grant runs a confirm op only when minted by the approve page', async () => {
    const direct = await inject('POST', '/v1/organizations/acme/invitations', {
      'x-test-scheme': 'ai_grant',
      'x-test-grant': 'oauth:g1',
    });
    expect(direct.statusCode).toBe(403);
    expect(handlerCalls.invite).toBe(0);

    const approved = await inject('POST', '/v1/organizations/acme/invitations', {
      'x-test-scheme': 'ai_grant',
      'x-test-grant': 'approval:pending-1',
    });
    expect(approved.statusCode).toBe(201);
    expect(handlerCalls.invite).toBe(1);
  });
});

describe('60-10 — the agent contract on the personal-access-token channel', () => {
  const whoami = (headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/v1/organizations/acme/agent/me', headers });

  it('an agent key the agent gate stamped reaches agent_whoami', async () => {
    const res = await whoami({
      'x-test-scheme': 'personal_access_token',
      'x-test-agent': 'yes',
      'x-test-stamp': 'yes',
    });
    expect(res.statusCode).toBe(200);
    expect(handlerCalls.agent).toBe(1);
  });

  it('a person’s token is refused there, like on every NEVER route', async () => {
    const res = await whoami({ 'x-test-scheme': 'personal_access_token', 'x-test-stamp': 'yes' });
    expect(res.statusCode).toBe(403);
    expect(handlerCalls.agent).toBe(0);
  });

  it('an agent key without the gate’s stamp is refused', async () => {
    const res = await whoami({ 'x-test-scheme': 'personal_access_token', 'x-test-agent': 'yes' });
    expect(res.statusCode).toBe(403);
    expect(handlerCalls.agent).toBe(0);
  });

  it('an agent key on another NEVER route is still refused', async () => {
    const res = await inject('PUT', '/v1/organizations/acme/security/sso', {
      'x-test-scheme': 'personal_access_token',
      'x-test-agent': 'yes',
      'x-test-stamp': 'yes',
    });
    expect(res.statusCode).toBe(403);
    expect(handlerCalls.security).toBe(0);
  });
});
