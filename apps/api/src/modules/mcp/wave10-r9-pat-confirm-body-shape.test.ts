import 'reflect-metadata';
import { Body, Controller, Injectable, Module, Post } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpExceptionFilter } from '../../common/http/http-exception.filter.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { API_CONFIG } from '../../common/http/tokens.js';
import { BoundTokenConfirmInterceptor } from '../ai-actions/bound-token-confirm.interceptor.js';
import { MCP_MAX_ARRAY_ITEMS } from './mcp-body-shape.js';
import { PendingActionRefusedError, freezeConfirmAction } from './pending-actions.js';
import { allDetailsById } from './tool-catalog.js';

/**
 * Audit run 2 NO-GO fixer, reason 3 (GHSA-mrhx-c7xc-m3w5, zod 3.25.76). The second untrusted
 * entry point into zod: a personal-access-token call to a confirm-class REST route is frozen as a
 * pending action through the op's zod schema. Its body gets the same shape cap as `POST /mcp`
 * (400 `validation_failed`, audit code `mcp_body_<reason>`) before any pending action is written.
 */

let handlerCalls = 0;

@Controller('v1/organizations/:orgSlug/invitations')
class FakeInvitationsController {
  @Post()
  create(@Body() _body: unknown): unknown {
    handlerCalls += 1;
    return { token: 'one-time-invitation-token' };
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

@Injectable()
class FakePatGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const state = ensureRequestState(context.switchToHttp().getRequest<object>());
    state.authScheme = 'personal_access_token';
    state.session = { sessionId: 'pat:token-1', userId: 'user-1' } as never;
    state.tenant = TENANT;
    return true;
  }
}

const approvals = {
  request: vi.fn(async () => ({
    id: 'pending-1',
    title: 'Invite someone to the workspace',
    expiresAt: new Date('2026-10-26T12:10:00.000Z'),
  })),
};

@Module({
  controllers: [FakeInvitationsController],
  providers: [
    { provide: API_CONFIG, useValue: { webPublicUrl: 'https://app.example.test' } },
    { provide: Symbol.for('tmanage.PendingAiActionsService'), useValue: approvals },
    { provide: APP_GUARD, useClass: FakePatGuard },
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
  handlerCalls = 0;
  approvals.request.mockClear();
});

const post = (body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/v1/organizations/acme/invitations',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

const oversized = () => Array.from({ length: MCP_MAX_ARRAY_ITEMS + 1 }, () => 'x');

describe('GHSA-mrhx-c7xc-m3w5 — a PAT confirm-class body is shape-capped before zod', () => {
  it('exploit: a 1,001-item array body is a 400 and no pending action is written', async () => {
    const res = await post(oversized());
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('validation_failed');
    expect(approvals.request).not.toHaveBeenCalled();
    expect(handlerCalls).toBe(0);
  });

  it('exploit: a 1,001-item array inside the arguments is a 400 too', async () => {
    const res = await post({ email: 'dummy@example.test', role: 'member', ids: oversized() });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('validation_failed');
    expect(approvals.request).not.toHaveBeenCalled();
    expect(handlerCalls).toBe(0);
  });

  it('an ordinary confirm-class body still becomes a pending approval (202)', async () => {
    const res = await post({ email: 'dummy@example.test', role: 'member' });
    expect(res.statusCode).toBe(202);
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(handlerCalls).toBe(0);
  });

  it('freezeConfirmAction itself refuses oversized arguments before the op schema runs', () => {
    const detail = allDetailsById.get('invitations.create');
    expect(detail).toBeDefined();
    const parse = vi.spyOn(detail!.input, 'safeParse');
    expect(() =>
      freezeConfirmAction('invitations.create', {
        email: 'dummy@example.test',
        role: 'member',
        ids: oversized(),
      }),
    ).toThrow(PendingActionRefusedError);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });
});
