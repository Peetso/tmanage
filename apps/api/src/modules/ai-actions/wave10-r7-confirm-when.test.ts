import 'reflect-metadata';
import { Body, Controller, Injectable, Module, Patch, Post } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpExceptionFilter } from '../../common/http/http-exception.filter.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { API_CONFIG } from '../../common/http/tokens.js';
import { BoundTokenConfirmInterceptor } from './bound-token-confirm.interceptor.js';
import { callNeedsConfirm, findOpById } from './registry/index.js';
import { buildAiOpenApiDocument } from './openapi.js';

/**
 * Wave 10 R7 — audit run 2, N07, the REST channel. A bound token (an AI internal grant minted
 * under read + write consent, or a personal access token) reaching a client-facing write must not
 * run it: a client-audience work item or a client meeting attendee is held for approval exactly as
 * a confirm op is (`ai_grant` → 403, PAT → 202 pending). The handler — the only thing that writes a
 * row or publishes to the portal — is never called. Internal work and team attendees still run.
 */

const calls = { workCreate: 0, workUpdate: 0, attendee: 0, message: 0 };

@Controller('v1/organizations/:orgSlug/work-items')
class FakeWorkItemsController {
  @Post()
  create(@Body() _body: unknown): unknown {
    calls.workCreate += 1;
    return { id: 'w1' };
  }

  @Patch(':workItemId')
  update(@Body() _body: unknown): unknown {
    calls.workUpdate += 1;
    return { id: 'w1' };
  }
}

@Controller('v1/organizations/:orgSlug/meetings/:meetingId/attendees')
class FakeAttendeesController {
  @Post()
  create(@Body() _body: unknown): unknown {
    calls.attendee += 1;
    return { id: 'att-1' };
  }
}

@Controller('v1/organizations/:orgSlug/client-requests/:clientRequestId/messages')
class FakeRequestMessagesController {
  @Post()
  create(@Body() _body: unknown): unknown {
    calls.message += 1;
    return { id: 'msg-1' };
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

/** Plays SessionAuthGuard + TenantContextGuard: an AI grant with read + write consent, or a PAT. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const state = ensureRequestState(request);
    const scheme = request.headers['x-test-scheme'] as 'personal_access_token' | 'ai_grant';
    state.authScheme = scheme;
    state.session = { sessionId: 'pat:token-1', userId: 'user-1' } as never;
    state.tenant = TENANT;
    if (scheme === 'ai_grant') {
      state.aiGrant = {
        grantId: 'oauth:g1',
        clientId: 'client',
        clientName: 'Client',
        opId: 'x',
        scopes: 'tmanage:read tmanage:write',
      } as never;
    }
    return true;
  }
}

const approvals = {
  request: vi.fn(async () => ({
    id: 'pending-1',
    title: 'Create work item',
    expiresAt: new Date('2026-10-26T12:10:00.000Z'),
  })),
};

@Module({
  controllers: [FakeWorkItemsController, FakeAttendeesController, FakeRequestMessagesController],
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
  calls.workCreate = 0;
  calls.workUpdate = 0;
  calls.attendee = 0;
  calls.message = 0;
  approvals.request.mockClear();
});

function send(
  method: 'POST' | 'PATCH',
  url: string,
  scheme: 'ai_grant' | 'personal_access_token',
  body: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: { 'content-type': 'application/json', 'x-test-scheme': scheme },
    payload: JSON.stringify(body),
  });
}

describe('N07 — REST: client-facing writes are held for approval', () => {
  it('ai_grant (read + write) work_items.create audience client_visible → 403, handler not run', async () => {
    const res = await send('POST', '/v1/organizations/acme/work-items', 'ai_grant', {
      projectId: 'proj_1',
      title: 'Shown to the client',
      audience: 'client_visible',
    });
    expect(res.statusCode).toBe(403);
    expect(calls.workCreate).toBe(0);
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it('PAT work_items.create audience client_visible → not run (held for approval or refused)', async () => {
    const res = await send('POST', '/v1/organizations/acme/work-items', 'personal_access_token', {
      projectId: 'proj_1',
      title: 'Shown to the client',
      audience: 'client_visible',
    });
    expect([202, 403]).toContain(res.statusCode);
    expect(calls.workCreate).toBe(0);
    expect(approvals.request).toHaveBeenCalledWith(
      expect.anything(),
      'work_items.create',
      { projectId: 'proj_1', title: 'Shown to the client', audience: 'client_visible' },
      expect.any(String),
    );
  });

  it('ai_grant work_items.update to client_action_required → 403, handler not run', async () => {
    const res = await send('PATCH', '/v1/organizations/acme/work-items/wi_1', 'ai_grant', {
      audience: 'client_action_required',
    });
    expect(res.statusCode).toBe(403);
    expect(calls.workUpdate).toBe(0);
  });

  it('ai_grant work_items.create audience internal (or none) → 201, handler runs', async () => {
    const internal = await send('POST', '/v1/organizations/acme/work-items', 'ai_grant', {
      projectId: 'proj_1',
      title: 'Internal',
      audience: 'internal',
    });
    expect(internal.statusCode).toBe(201);
    const plain = await send('POST', '/v1/organizations/acme/work-items', 'ai_grant', {
      projectId: 'proj_1',
      title: 'Default audience',
    });
    expect(plain.statusCode).toBe(201);
    expect(calls.workCreate).toBe(2);
    const rename = await send('PATCH', '/v1/organizations/acme/work-items/wi_1', 'ai_grant', {
      title: 'Renamed',
    });
    expect(rename.statusCode).toBe(200);
    expect(calls.workUpdate).toBe(1);
  });

  it('meetings.attendees.create with clientUserId → pending (PAT 202) / refused (ai_grant 403)', async () => {
    const pat = await send(
      'POST',
      '/v1/organizations/acme/meetings/mtg_1/attendees',
      'personal_access_token',
      { clientUserId: 'user_client' },
    );
    expect(pat.statusCode).toBe(202);
    expect(pat.json()).toMatchObject({ status: 'approval_required', approval_id: 'pending-1' });
    const grant = await send(
      'POST',
      '/v1/organizations/acme/meetings/mtg_1/attendees',
      'ai_grant',
      {
        clientUserId: 'user_client',
      },
    );
    expect(grant.statusCode).toBe(403);
    expect(calls.attendee).toBe(0);
  });

  it('meetings.attendees.create with a team member (userId) → 201', async () => {
    const res = await send('POST', '/v1/organizations/acme/meetings/mtg_1/attendees', 'ai_grant', {
      userId: 'user_3',
    });
    expect(res.statusCode).toBe(201);
    expect(calls.attendee).toBe(1);
  });

  it('client_requests.messages.create is confirm-class under manage, so a write grant never runs it', async () => {
    const op = findOpById('client_requests.messages.create')!;
    expect(op).toMatchObject({ risk: 'confirm', scope: 'manage' });
    const res = await send(
      'POST',
      '/v1/organizations/acme/client-requests/creq_1/messages',
      'ai_grant',
      { body: 'Draft is ready.' },
    );
    expect(res.statusCode).toBe(403);
    expect(calls.message).toBe(0);
  });
});

describe('N07 — confirmWhen rule and OpenAPI note', () => {
  it('callNeedsConfirm matches only client-facing arguments', () => {
    const create = findOpById('work_items.create')!;
    expect(callNeedsConfirm(create, { audience: 'client_visible' })).toBe(true);
    expect(callNeedsConfirm(create, { audience: null })).toBe(true);
    expect(callNeedsConfirm(create, { audience: 'internal' })).toBe(false);
    expect(callNeedsConfirm(create, {})).toBe(false);
    const attendee = findOpById('meetings.attendees.create')!;
    expect(callNeedsConfirm(attendee, { clientUserId: 'u' })).toBe(true);
    expect(callNeedsConfirm(attendee, { userId: 'u' })).toBe(false);
  });

  it('the OpenAPI document marks the conditional ops with the 202 approval response and a note', () => {
    const doc = buildAiOpenApiDocument() as {
      paths: Record<string, Record<string, { description: string; responses: object }>>;
    };
    const op = Object.values(doc.paths)
      .flatMap((p) => Object.values(p))
      .find((o) => (o as { operationId?: string }).operationId === 'work_items.create')!;
    expect(op.responses).toHaveProperty('202');
    expect(op.description).toContain('Approval is needed only');
  });
});
