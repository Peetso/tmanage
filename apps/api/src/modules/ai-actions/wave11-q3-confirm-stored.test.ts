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
import { callNeedsConfirm, callNeedsConfirmWithState, findOpById } from './registry/index.js';
import {
  STORED_AUDIENCE_RESOLVER,
  StoredAudienceRepository,
} from './stored-audience.repository.js';
import type { StoredAudienceResolver } from './stored-audience.repository.js';
import { liveMcpSurface } from '../mcp/catalog-runtime.js';

/**
 * Wave 11 Q3 — audit run 3, M01 (completes N07). Under everyday read + write consent a bound token
 * could still make three client-facing changes without a person's approval:
 *
 * 1. converting a message straight into a client-audience work item;
 * 2. accepting a client request (notifies the client, writes a client-safe summary, can create
 *    client-audience work);
 * 3. editing a work item the client already sees with a call that names no audience
 *    (`{ title }` alone).
 *
 * Each is now confirm-class on both channels — REST (personal access token → 202 pending approval,
 * inner AI grant → 403) and `/mcp` (refused before any inner write). Internal work still runs.
 */

const calls = { convert: 0, accept: 0, update: 0, transition: 0 };

@Controller('v1/organizations/:orgSlug/conversations/:conversationId/messages/:messageId')
class FakeConvertController {
  @Post('work-items')
  convert(@Body() _body: unknown): unknown {
    calls.convert += 1;
    return { id: 'w1' };
  }
}

@Controller('v1/organizations/:orgSlug/client-requests/:clientRequestId')
class FakeAcceptanceController {
  @Post('acceptance')
  accept(@Body() _body: unknown): unknown {
    calls.accept += 1;
    return { id: 'creq_1' };
  }
}

@Controller('v1/organizations/:orgSlug/work-items')
class FakeWorkItemsController {
  @Patch(':workItemId')
  update(@Body() _body: unknown): unknown {
    calls.update += 1;
    return { id: 'w1' };
  }

  @Post(':workItemId/transitions')
  transition(@Body() _body: unknown): unknown {
    calls.transition += 1;
    return { id: 'w1' };
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
        grantId: request.headers['x-test-grant'] ?? 'oauth:g1',
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
    title: 'Pending',
    expiresAt: new Date('2026-10-26T12:10:00.000Z'),
  })),
};

/** The stored audiences, by work item id, as the tenant-scoped repository would read them. */
const STORED: Record<string, string> = {
  wi_client: 'client_visible',
  wi_action: 'client_action_required',
  wi_internal: 'internal',
};
const resolver: StoredAudienceResolver & { workItemAudience: ReturnType<typeof vi.fn> } = {
  workItemAudience: vi.fn(async (context: TenantContext, id: string) => {
    expect(context.organizationId).toBe('org-1');
    return STORED[id];
  }),
};

@Module({
  controllers: [FakeConvertController, FakeAcceptanceController, FakeWorkItemsController],
  providers: [
    { provide: API_CONFIG, useValue: { webPublicUrl: 'https://app.example.test' } },
    { provide: Symbol.for('tmanage.PendingAiActionsService'), useValue: approvals },
    { provide: STORED_AUDIENCE_RESOLVER, useValue: resolver },
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
  calls.convert = 0;
  calls.accept = 0;
  calls.update = 0;
  calls.transition = 0;
  approvals.request.mockClear();
  resolver.workItemAudience.mockClear();
});

function send(
  method: 'POST' | 'PATCH',
  url: string,
  scheme: 'ai_grant' | 'personal_access_token',
  body: Record<string, unknown>,
  grant?: string,
) {
  return app.inject({
    method,
    url,
    headers: {
      'content-type': 'application/json',
      'x-test-scheme': scheme,
      ...(grant !== undefined ? { 'x-test-grant': grant } : {}),
    },
    payload: JSON.stringify(body),
  });
}

const CONVERT = '/v1/organizations/acme/conversations/conv_1/messages/msg_1/work-items';
const ACCEPT = '/v1/organizations/acme/client-requests/creq_1/acceptance';

describe('M01 (i) — converting a message into client-audience work needs approval', () => {
  it('PAT convert with audience client_visible → 202 approval_required, handler not run', async () => {
    const res = await send('POST', CONVERT, 'personal_access_token', {
      title: 'Follow up',
      audience: 'client_visible',
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'approval_required', approval_id: 'pending-1' });
    expect(calls.convert).toBe(0);
    expect(approvals.request).toHaveBeenCalledWith(
      expect.anything(),
      'conversations.messages.work_items.create',
      expect.objectContaining({ audience: 'client_visible' }),
      expect.any(String),
    );
  });

  it('ai_grant convert with client_action_required → 403, handler not run', async () => {
    const res = await send('POST', CONVERT, 'ai_grant', { audience: 'client_action_required' });
    expect(res.statusCode).toBe(403);
    expect(calls.convert).toBe(0);
  });

  it('convert with audience internal, or no audience (defaults to internal), still runs', async () => {
    const internal = await send('POST', CONVERT, 'personal_access_token', {
      audience: 'internal',
    });
    expect(internal.statusCode).toBe(201);
    const plain = await send('POST', CONVERT, 'ai_grant', { title: 'Follow up' });
    expect(plain.statusCode).toBe(201);
    expect(calls.convert).toBe(2);
    expect(approvals.request).not.toHaveBeenCalled();
  });
});

describe('M01 (ii) — accepting a client request needs approval, REST and MCP', () => {
  it('PAT acceptance → 202 approval_required, handler not run', async () => {
    const res = await send('POST', ACCEPT, 'personal_access_token', {});
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'approval_required' });
    expect(calls.accept).toBe(0);
  });

  it('ai_grant acceptance (with nested client work) → 403; the approve-page grant runs it', async () => {
    const res = await send('POST', ACCEPT, 'ai_grant', { work: { audience: 'client_visible' } });
    expect(res.statusCode).toBe(403);
    expect(calls.accept).toBe(0);
    const approved = await send('POST', ACCEPT, 'ai_grant', {}, 'approval:pending-1');
    expect(approved.statusCode).toBe(201);
    expect(calls.accept).toBe(1);
  });

  it('MCP acceptance under read + write consent is refused before any inner request', async () => {
    const { runtime, fetch, tool } = mcpSurface({});
    // The route's full body (DC-9, 2026-11-23): an incomplete one is refused as invalid first.
    const result = await runtime.runTool(tool('client_requests.acceptance.create'), {
      clientRequestId: 'creq_1',
      version: 2,
      clientSafeScopeSummary: 'Homepage hero refresh',
      commitment: 'unscheduled',
    });
    expect(result.isError).toBe(true);
    expect(String(result.data)).toContain('needs your approval');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('M01 (iii) — editing an item the client already sees needs approval', () => {
  it('PAT update {title} on a stored client_visible item → 202 approval_required, not run', async () => {
    const res = await send(
      'PATCH',
      '/v1/organizations/acme/work-items/wi_client',
      'personal_access_token',
      {
        title: 'Renamed in front of the client',
      },
    );
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'approval_required' });
    expect(calls.update).toBe(0);
    expect(resolver.workItemAudience).toHaveBeenCalledWith(TENANT, 'wi_client');
  });

  it('ai_grant update {title} on a stored client_action_required item → 403, not run', async () => {
    const res = await send('PATCH', '/v1/organizations/acme/work-items/wi_action', 'ai_grant', {
      title: 'Renamed',
    });
    expect(res.statusCode).toBe(403);
    expect(calls.update).toBe(0);
  });

  it('ai_grant transition of a stored client_visible item → 403, not run', async () => {
    const res = await send(
      'POST',
      '/v1/organizations/acme/work-items/wi_client/transitions',
      'ai_grant',
      {
        to: 'done',
      },
    );
    expect(res.statusCode).toBe(403);
    expect(calls.transition).toBe(0);
  });

  it('update {title} on a stored internal item, or an unknown item (handler 404s), still runs', async () => {
    const internal = await send(
      'PATCH',
      '/v1/organizations/acme/work-items/wi_internal',
      'ai_grant',
      {
        title: 'Renamed',
      },
    );
    expect(internal.statusCode).toBe(200);
    const unknown = await send(
      'PATCH',
      '/v1/organizations/acme/work-items/wi_missing',
      'ai_grant',
      {
        title: 'Renamed',
      },
    );
    expect(unknown.statusCode).toBe(200);
    expect(calls.update).toBe(2);
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it('the approve-page grant still runs an update of a client-visible item', async () => {
    const res = await send(
      'PATCH',
      '/v1/organizations/acme/work-items/wi_client',
      'ai_grant',
      { title: 'Approved rename' },
      'approval:pending-1',
    );
    expect(res.statusCode).toBe(200);
    expect(calls.update).toBe(1);
  });

  it('MCP update {title} of a stored client_visible item is refused, no inner write', async () => {
    const { runtime, fetch, tool } = mcpSurface({ wi_client: 'client_visible' });
    const result = await runtime.runTool(tool('work_items.update'), {
      workItemId: 'wi_client',
      version: 3,
      title: 'Renamed',
    });
    expect(result.isError).toBe(true);
    expect(String(result.data)).toContain('needs your approval');
    // Only the member's own tenant-scoped read of the item; never the PATCH.
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['GET']);
  });

  it('MCP update {title} of a stored internal item runs', async () => {
    const { runtime, fetch, tool } = mcpSurface({ wi_internal: 'internal' });
    const result = await runtime.runTool(tool('work_items.update'), {
      workItemId: 'wi_internal',
      version: 3,
      title: 'Renamed',
    });
    expect(result.isError).toBeUndefined();
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'PATCH']);
  });
});

describe('M01 — the rule itself', () => {
  it('callNeedsConfirmWithState: stored client audience or unreadable → true; internal or missing → false', async () => {
    const update = findOpById('work_items.update')!;
    const lookup = async (_r: string, id: string) => STORED[id];
    expect(
      await callNeedsConfirmWithState(update, { workItemId: 'wi_client', title: 't' }, lookup),
    ).toBe(true);
    expect(
      await callNeedsConfirmWithState(update, { workItemId: 'wi_internal', title: 't' }, lookup),
    ).toBe(false);
    expect(await callNeedsConfirmWithState(update, { workItemId: 'wi_missing' }, lookup)).toBe(
      false,
    );
    const throws = async (): Promise<string | undefined> => {
      throw new Error('db down');
    };
    // R4-01 (wave 12): a lookup that throws fails closed - the call needs approval.
    expect(await callNeedsConfirmWithState(update, { workItemId: 'wi_internal' }, throws)).toBe(
      true,
    );
    // The argument rule still wins without any lookup.
    expect(await callNeedsConfirmWithState(update, { audience: 'client_visible' }, undefined)).toBe(
      true,
    );
  });

  it('the convert op carries the audience rule; an absent audience is not confirm-class', () => {
    const convert = findOpById('conversations.messages.work_items.create')!;
    expect(convert.confirmWhen).toEqual({ field: 'audience', notIn: ['internal'] });
    expect(callNeedsConfirm(convert, { audience: 'client_visible' })).toBe(true);
    expect(callNeedsConfirm(convert, {})).toBe(false);
  });

  it('the repository reads only this tenant, and skips ids that are not UUIDs', async () => {
    const read = vi.fn(async () => 'client_visible');
    const repo = new StoredAudienceRepository({ read } as never);
    expect(await repo.workItemAudience(TENANT, 'not-a-uuid')).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    await repo.workItemAudience(TENANT, '01890a5d-ac96-774b-bcce-b302099a8057');
    expect(read).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });
});

function mcpSurface(stored: Record<string, string>) {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      const id = String(url).split('/').pop() ?? '';
      const audience = stored[id];
      return audience === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify({ id, audience }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'row-1' }), { status: 200 });
  });
  const { runtime, catalog } = liveMcpSurface({
    profile: 'full',
    scopes: 'tmanage:read tmanage:write',
    capabilities: new Set([
      'work.read',
      'work.create',
      'work.update',
      'work.transition',
      'client_request.triage',
    ]),
    orgSlug: 'acme',
    baseUrl: 'http://in-process',
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  const tool = (opId: string) => {
    const found = catalog.tools.find((t) => t.opId === opId);
    if (found === undefined) throw new Error(`no tool for ${opId}`);
    return found;
  };
  return { runtime, fetch, tool };
}
