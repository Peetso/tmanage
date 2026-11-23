import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { SessionAuthGuard } from '../../common/http/guards/session-auth.guard.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { SessionNotAuthenticatedError } from '../identity/session.service.js';
import { mintPersonalAccessToken } from '../personal-access-tokens/personal-access-token.js';
import { PersonalAccessTokenNotAuthenticatedError } from '../personal-access-tokens/personal-access-tokens.service.js';
import type { PersonalAccessTokenRejection } from '../personal-access-tokens/personal-access-tokens.service.js';
import {
  MCP_MAX_REQUESTS_PER_WINDOW,
  McpEndpointController,
  inProcessFetch,
} from './mcp-endpoint.controller.js';
import type { InjectCapable } from './mcp-endpoint.controller.js';
import { auditedRuntime, auditResultFor, mcpToolCallMetadata } from './mcp-call-audit.js';
import type { McpToolCallAudit } from './mcp-call-audit.js';
import { isSafeAuditMetadata } from '@tmanage/domain';
import type { CatalogRuntime, CatalogTool } from '@tmanage/mcp-server';

/**
 * The hosted MCP endpoint's refusals, without a server or database: the real `SessionAuthGuard`
 * (with a fake token store) in front of the real controller. The same refusals over the real API
 * and a real database are `test/mcp-001-endpoint.db.test.ts`, which also proves cross-tenant scope.
 */

const USER = '0198f4a2-1c00-7000-8000-00000000000c';
const LIVE = mintPersonalAccessToken().token;
const REVOKED = mintPersonalAccessToken().token;

type Request = {
  method: string;
  headers: Record<string, string | undefined>;
  body?: unknown;
  raw: never;
};

function contextFor(request: Request): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guard(): SessionAuthGuard {
  const tokens = {
    authenticate: vi.fn(async (token: string) => {
      const refuse = (code: PersonalAccessTokenRejection) => {
        throw new PersonalAccessTokenNotAuthenticatedError(code);
      };
      if (token === REVOKED) return refuse('revoked');
      if (token !== LIVE) return refuse('unknown');
      return { tokenId: 't1', organizationId: 'org-a', membershipId: 'm1', userId: USER };
    }),
  };
  return new SessionAuthGuard(
    { getAllAndOverride: () => false } as never,
    {
      authenticate: vi.fn(async () => {
        throw new SessionNotAuthenticatedError('no_cookie');
      }),
    } as never,
    { cookieName: 'tm' } as never,
    { recordGuardRefusal: vi.fn() } as never,
    tokens as never,
  );
}

function controller(app?: InjectCapable): McpEndpointController {
  const host = { httpAdapter: { getInstance: () => app ?? {} } } as unknown as HttpAdapterHost;
  return new McpEndpointController(host);
}

const reply = { hijack: vi.fn(), raw: {} } as never;

function mcpRequest(authorization?: string): Request {
  return {
    method: 'POST',
    headers: authorization === undefined ? {} : { authorization },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    raw: {} as never,
  };
}

describe('hosted MCP endpoint — authentication refusals', () => {
  it('refuses a request with no token (401 from the session guard, which a cookie also fails)', async () => {
    await expect(guard().canActivate(contextFor(mcpRequest()))).rejects.toMatchObject({
      status: 401,
    });
  });

  it('refuses an unknown token with a 401', async () => {
    const request = mcpRequest(`Bearer ${mintPersonalAccessToken().token}`);
    await expect(guard().canActivate(contextFor(request))).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a revoked token with a 401', async () => {
    const request = mcpRequest(`Bearer ${REVOKED}`);
    await expect(guard().canActivate(contextFor(request))).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a cookie session in the handler — only a personal access token is a way in', async () => {
    const request = mcpRequest();
    const state = requireRequestState(request);
    state.session = { sessionId: 's1', userId: USER };
    state.authScheme = 'cookie';
    await expect(controller().handle(request as never, reply)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rate limits per token after the window budget, keyed by token id', async () => {
    const endpoint = controller();
    const limited = mcpRequest(`Bearer ${LIVE}`);
    await guard().canActivate(contextFor(limited));
    // Spend the budget through the limiter alone: a request with a different token id is not
    // charged against this one.
    const admit = (endpoint as unknown as { admit: (key: string) => boolean }).admit;
    for (let i = 0; i < MCP_MAX_REQUESTS_PER_WINDOW; i += 1) expect(admit('pat:t1')).toBe(true);
    await expect(endpoint.handle(limited as never, reply)).rejects.toMatchObject({ status: 429 });
    expect(admit('pat:t2')).toBe(true);
  });
});

describe('hosted MCP endpoint — AI kill switches (S11, T-KILL-01)', () => {
  function patRequest(): Request {
    const request = mcpRequest(`Bearer ${LIVE}`);
    const state = requireRequestState(request);
    state.session = { sessionId: 'pat:t9', userId: USER };
    state.authScheme = 'personal_access_token';
    state.personalAccessToken = { organizationId: 'org-1', membershipId: 'mem-1' };
    return request;
  }
  function withSwitches(platform: boolean, organization: boolean): McpEndpointController {
    const host = { httpAdapter: { getInstance: () => ({}) } } as unknown as HttpAdapterHost;
    return new McpEndpointController(host, {
      platformOn: async () => platform,
      organizationOn: async () => organization,
      forget: () => undefined,
    });
  }

  it('answers 503 while the platform switch is off', async () => {
    await expect(
      withSwitches(false, true).handle(patRequest() as never, reply),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('answers 403 while the workspace owner has AI apps turned off', async () => {
    await expect(
      withSwitches(true, false).handle(patRequest() as never, reply),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('hosted MCP endpoint — tool calls run via a one-time internal grant, never the caller’s token', () => {
  const options = (overrides: Partial<Parameters<typeof inProcessFetch>[1]> = {}) => ({
    mintGrant: vi.fn(() => 'nonce-123'),
    correlationId: '0198f4a2-1c00-7000-8000-0000000000c1',
    ...overrides,
  });

  it('strips the caller’s Bearer header and injects the internal grant instead (B1/B3, T-B3-03)', async () => {
    const inject = vi.fn(async (_opts: Parameters<InjectCapable['inject']>[0]) => ({
      statusCode: 404,
      body: '{"code":"not_found","message":"The requested resource was not found"}',
      headers: { 'content-type': 'application/json' },
    }));
    const opts = options();
    const response = await inProcessFetch({ inject }, opts)(
      'http://tmanage.internal/v1/organizations/other-org/work-items/x?a=1',
      { method: 'GET', headers: { authorization: `Bearer ${LIVE}` } },
    );
    expect(response.status).toBe(404);
    const call = inject.mock.calls[0]![0] as { headers: Record<string, string>; url: string };
    expect(call.url).toBe('/v1/organizations/other-org/work-items/x?a=1');
    // The caller's token is gone; the single-use grant and the correlation id take its place.
    expect(call.headers['authorization']).toBeUndefined();
    expect(call.headers['x-tmanage-internal-grant']).toBe('nonce-123');
    expect(call.headers['x-correlation-id']).toBe(opts.correlationId);
    expect(opts.mintGrant).toHaveBeenCalledWith('GET /v1/organizations/other-org/work-items/x');
  });

  it('passes a JSON body through, returns an empty 204 as no body, and records a redacted call', async () => {
    const inject = vi.fn(async () => ({ statusCode: 204, body: '', headers: {} }));
    const onCall = vi.fn();
    const response = await inProcessFetch({ inject }, options({ onCall }))(
      'http://tmanage.internal/v1/x',
      { method: 'post', headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(inject).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', payload: '{"a":1}' }),
    );
    // The audit record carries the op, the status and an args hash — never the body.
    const record = onCall.mock.calls[0]![0] as { opId: string; status: number; argsSha256: string };
    expect(record.opId).toBe('POST /v1/x');
    expect(record.status).toBe(204);
    expect(record.argsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain('"a":1');
  });
});

describe('hosted MCP endpoint — one audit event per tool call (plan §4.4)', () => {
  it('records each tool call once with tool, op, outcome and an args hash — never the args or a token', async () => {
    const inner: CatalogRuntime = {
      runTool: vi.fn(async (tool: CatalogTool) =>
        tool.name === 'work_items_get' ? { data: { ok: true } } : { isError: true, data: 'no' },
      ),
      readResource: vi.fn(async () => ({ data: null })),
    };
    const calls: McpToolCallAudit[] = [];
    const runtime = auditedRuntime(inner, (call) => calls.push(call));
    const secretArgs = { workItemId: 'wi-1', note: `Bearer ${LIVE}` };

    await runtime.runTool(
      { name: 'work_items_get', opId: 'work_items.get' } as CatalogTool,
      secretArgs,
    );
    await runtime.runTool({ name: 'tmanage_run_action' } as CatalogTool, {
      action_id: 'projects.create',
      args: {},
    });
    await runtime.readResource({} as never, new URL('tmanage://me/today'), {});

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      tool: 'work_items_get',
      opId: 'work_items.get',
      outcome: 'ok',
    });
    expect(calls[1]).toMatchObject({ opId: 'projects.create', outcome: 'tool_error' });
    expect(calls[0]!.argsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(auditResultFor(calls[1]!.outcome)).toBe('error');

    // The row a PAT call writes: safe for the audit gate, attributed to the client, no secrets.
    const metadata = mcpToolCallMetadata(
      {
        userId: USER,
        organizationId: 'org-1',
        membershipId: 'mem-1',
        clientId: 'https://claude.ai/oauth/mcp-client.json',
        correlationId: 'c-1',
      },
      calls[0]!,
    );
    expect(isSafeAuditMetadata(metadata)).toBe(true);
    expect(metadata).toMatchObject({ actor_kind: 'ai', tool: 'work_items_get', outcome: 'ok' });
    expect(metadata['client_id']).toMatch(/^sha256:[0-9a-f]{32}$/);
    const serialised = JSON.stringify([calls, metadata]);
    expect(serialised).not.toContain(LIVE);
    // AI panel (2026-11-23): the item's identifier is recorded as `target_id`, and only there;
    // every other argument value (the note) stays out.
    expect(metadata['target_id']).toBe('wi-1');
    expect(serialised.split('wi-1').length - 1).toBe(2);
    expect(serialised).not.toContain('Bearer');
  });
});
