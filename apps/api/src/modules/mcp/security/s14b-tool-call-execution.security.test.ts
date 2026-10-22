import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import type { Catalog, CatalogRuntime, RunResult } from '@tmanage/mcp-server';
import type * as McpServerModule from '@tmanage/mcp-server';
import { ApiError } from '../../../common/http/errors.js';
import { SessionAuthGuard } from '../../../common/http/guards/session-auth.guard.js';
import { TenantContextGuard } from '../../../common/http/guards/tenant-context.guard.js';
import { requireRequestState } from '../../../common/http/request-state.js';
import { MembershipNotResolvedError } from '../../tenancy/membership-resolver.repository.js';
import { mintPersonalAccessToken } from '../../personal-access-tokens/personal-access-token.js';
import { INTERNAL_GRANT_HEADER, internalGrants } from '../internal-grant.js';
import { McpEndpointController } from '../mcp-endpoint.controller.js';
import type { InjectCapable } from '../mcp-endpoint.controller.js';
import { recordMcpOAuthAccess } from '../mcp-auth.js';

/**
 * S14B — AI-connector security suite: executing an MCP tool call.
 *
 * Drives the real `McpEndpointController` (with the MCP transport stubbed out) and runs the tools
 * of the catalogue it serves against an in-memory "inject" that runs the real `SessionAuthGuard`
 * and `TenantContextGuard` on every inner request. That exercises, end to end and without a database:
 * the bearer token stripped before the inner request, the one-time internal grant (no replay), one
 * redacted audit record per call that never contains the token, and workspace isolation (a token
 * bound to workspace A cannot touch workspace B, even one its member also belongs to).
 */

const captured = vi.hoisted(() => ({ surfaces: [] as { catalog: unknown; runtime: unknown }[] }));

vi.mock('@tmanage/mcp-server', async (importOriginal) => {
  const actual = await importOriginal<typeof McpServerModule>();
  return {
    ...actual,
    // Keep the real catalogue and runtime the endpoint builds, but remember them.
    buildCatalogServer: vi.fn((catalog: unknown, runtime: unknown) => {
      captured.surfaces.push({ catalog, runtime });
      return {};
    }),
    serveMcpRequest: vi.fn(async () => undefined),
  };
});

const USER = '0198f4a2-1c00-7000-8000-00000000000c';
const TOKEN = mintPersonalAccessToken().token;
const SECRET_TITLE = 'Quarterly salary review — confidential';
/** The member belongs to both workspaces; the token is bound to `acme` (org-a) only. */
const ORG_BY_SLUG: Record<string, string> = { acme: 'org-a', globex: 'org-b' };

class MockSocket {} // what fastify.inject presents to the guard

function contextFor(request: unknown): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function sessionGuard(): SessionAuthGuard {
  return new SessionAuthGuard(
    { getAllAndOverride: () => false } as never,
    { authenticate: vi.fn() } as never,
    { cookieName: 'tm' } as never,
    { recordGuardRefusal: vi.fn() } as never,
    { authenticate: vi.fn() } as never,
  );
}

function tenantGuard(): TenantContextGuard {
  const resolver = {
    resolve: vi.fn(async (input: { organization: { slug: string } }) => {
      const organizationId = ORG_BY_SLUG[input.organization.slug];
      if (organizationId === undefined)
        throw new MembershipNotResolvedError('no_active_membership');
      return {
        context: { organizationId, userId: USER },
        role: 'owner',
        clientOrganizationId: null,
        hasOrgWideScope: true,
        workspaceScopeId: null,
      };
    }),
  } as never;
  const database = {
    read: vi.fn(async (ctx: unknown, work: (runner: unknown) => Promise<unknown>) => work({ ctx })),
  } as never;
  return new TenantContextGuard(
    { getAllAndOverride: () => false } as never,
    resolver,
    { load: vi.fn(async () => ({})) } as never,
    database,
  );
}

interface InnerCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly status: number;
  readonly auditCode?: string;
  readonly organizationId?: string;
  readonly actorChannel?: string;
  readonly authScheme?: string;
}

/** An in-memory stand-in for `fastify.inject` that runs the real auth + tenant guards. */
function guardedApp(): InjectCapable & { readonly calls: InnerCall[] } {
  const calls: InnerCall[] = [];
  const auth = sessionGuard();
  const tenant = tenantGuard();
  return {
    calls,
    async inject({ method, url, headers }) {
      const pathname = url.split('?')[0]!;
      const slug = /^\/v1\/organizations\/([^/]+)/.exec(pathname)?.[1];
      const request = {
        headers,
        params: slug === undefined ? {} : { orgSlug: decodeURIComponent(slug) },
        raw: { socket: new MockSocket() },
      };
      try {
        await auth.canActivate(contextFor(request));
        let body: unknown;
        if (pathname === '/v1/organizations') {
          body = { organizations: [{ slug: 'acme', name: 'Acme', role: 'owner' }] };
        } else {
          await tenant.canActivate(contextFor(request));
          body = { id: 'wi-1', title: 'ok' };
        }
        const state = requireRequestState(request);
        const tenantContext = state.tenant as { actorChannel?: string } | undefined;
        calls.push({
          method,
          url,
          headers,
          status: 200,
          ...(state.tenant ? { organizationId: state.tenant.organizationId } : {}),
          ...(tenantContext?.actorChannel ? { actorChannel: tenantContext.actorChannel } : {}),
          ...(state.authScheme ? { authScheme: state.authScheme } : {}),
        });
        return {
          statusCode: 200,
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        };
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        calls.push({
          method,
          url,
          headers,
          status: error.status,
          ...(error.auditCode ? { auditCode: error.auditCode } : {}),
        });
        return {
          statusCode: error.status,
          body: JSON.stringify({ code: error.code, message: error.message }),
          headers: { 'content-type': 'application/json' },
        };
      }
    },
  };
}

/** A PAT request bound to workspace A, as `SessionAuthGuard` leaves it. */
function patRequest(): object {
  const request = {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    raw: {},
  };
  const state = requireRequestState(request);
  state.session = { sessionId: 'pat:t1', userId: USER };
  state.authScheme = 'personal_access_token';
  state.personalAccessToken = { organizationId: 'org-a', membershipId: 'm-a' };
  return request;
}

/** An OAuth request bound to workspace A, as `SessionAuthGuard` leaves it, for `scopes`. */
function oauthRequest(
  scopes: string,
  body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' },
) {
  const request = {
    method: 'POST',
    headers: { authorization: 'Bearer opaque-oauth-access-token' },
    body,
    raw: {},
  };
  const state = requireRequestState(request);
  state.session = { sessionId: 'oauth:g1', userId: USER };
  state.authScheme = 'ai_grant';
  state.personalAccessToken = { organizationId: 'org-a', membershipId: 'm-a' };
  recordMcpOAuthAccess(state, {
    grantId: 'g1',
    userId: USER,
    membershipId: 'm-a',
    organizationId: 'org-a',
    scopes,
    clientId: 'client-1',
    clientName: 'Claude',
  });
  return request;
}

const ALL_CAPS = new Set(['work.read', 'work.create', 'work.update', 'work.comment']);

function endpoint(app: InjectCapable, orgSlug: string): McpEndpointController {
  const host = { httpAdapter: { getInstance: () => app } } as unknown as HttpAdapterHost;
  // The workspace the endpoint resolves from the token's own binding. A wrong slug here stands
  // for a resolution bug: the guard chain must still keep the call in the token's workspace.
  const workspaces = { resolve: vi.fn(async () => ({ orgSlug, capabilities: ALL_CAPS })) };
  return new McpEndpointController(host, undefined, workspaces);
}

interface ToolCaller {
  call(name: string, args: Record<string, unknown>): Promise<RunResult>;
}

/** Run the real controller and return a caller over the catalogue it serves. */
async function connect(
  app: InjectCapable,
  orgSlug = 'acme',
  request = patRequest(),
): Promise<ToolCaller> {
  const reply = { hijack: vi.fn(), raw: {} } as never;
  await endpoint(app, orgSlug).handle(request as never, reply);
  const { catalog, runtime } = captured.surfaces.at(-1) as {
    catalog: Catalog;
    runtime: CatalogRuntime;
  };
  return {
    async call(name, args) {
      const tool = catalog.tools.find((t) => t.name === name);
      if (tool === undefined) throw new Error(`tool not served: ${name}`);
      return runtime.runTool(tool, args);
    },
  };
}

let logged: string[] = [];

beforeEach(() => {
  logged = [];
  const record = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(record);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function toolCallLines(): Record<string, unknown>[] {
  return logged
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter((e): e is Record<string, unknown> => e?.['event'] === 'mcp.tool_call');
}

describe('S14B tool call — bearer token stripped before the internal request', () => {
  it('no inner request carries the AI client’s token, only a single-use grant', async () => {
    const app = guardedApp();
    const tools = await connect(app);
    await tools.call('work_items_create', { projectId: 'p1', title: SECRET_TITLE });

    expect(app.calls.length).toBeGreaterThan(0);
    for (const call of app.calls) {
      expect(call.headers['authorization']).toBeUndefined();
      expect(JSON.stringify(call.headers)).not.toContain(TOKEN);
      expect(call.headers[INTERNAL_GRANT_HEADER]).toMatch(/^[0-9a-f]{64}$/);
      expect(call.authScheme).toBe('ai_grant');
    }
    // A fresh grant per inner call — never one grant reused across calls.
    const grants = app.calls.map((c) => c.headers[INTERNAL_GRANT_HEADER]);
    expect(new Set(grants).size).toBe(grants.length);
  });
});

describe('S14B tool call — the one-time internal grant cannot be replayed', () => {
  it('a grant used by a tool call is refused when presented again, even in-process', async () => {
    const app = guardedApp();
    const tools = await connect(app);
    await tools.call('work_items_create', { projectId: 'p1', title: 'x' });
    const used = app.calls.at(-1)!;
    expect(used.status).toBe(200);
    const nonce = used.headers[INTERNAL_GRANT_HEADER]!;

    // Gone from the in-memory store …
    expect(internalGrants.consume(nonce)).toBeUndefined();
    // … and refused at the guard on an in-process replay.
    const replay = {
      headers: { [INTERNAL_GRANT_HEADER]: nonce },
      raw: { socket: new MockSocket() },
    };
    await expect(sessionGuard().canActivate(contextFor(replay))).rejects.toMatchObject({
      status: 401,
      auditCode: 'internal_grant_invalid',
    });
  });

  it('a grant taken off an inner call is refused over the network and stays unusable', async () => {
    const nonce = internalGrants.mint({
      grantId: 'pat:t1',
      userId: USER,
      membershipId: 'm-a',
      organizationId: 'org-a',
      clientId: 'pat:t1',
      clientName: 'AI assistant',
      opId: 'GET /v1/organizations/acme/work-items',
    });
    class Socket {} // a real TCP connection
    const fromNetwork = {
      headers: { [INTERNAL_GRANT_HEADER]: nonce },
      raw: { socket: new Socket() },
    };
    await expect(sessionGuard().canActivate(contextFor(fromNetwork))).rejects.toMatchObject({
      status: 401,
      auditCode: 'internal_grant_from_network',
    });
    expect(internalGrants.consume(nonce)).toBeDefined(); // consumed here so it cannot linger
    expect(internalGrants.consume(nonce)).toBeUndefined();
  });
});

describe('S14B tool call — one redacted audit record per call, token never logged', () => {
  it('logs exactly one mcp.tool_call line per inner call with op, hash, outcome and client', async () => {
    const app = guardedApp();
    const tools = await connect(app);
    await tools.call('work_items_create', { projectId: 'p1', title: SECRET_TITLE });
    await tools.call('work_items_comments_create', { workItemId: 'wi-1', body: SECRET_TITLE });

    const lines = toolCallLines();
    expect(lines).toHaveLength(app.calls.length);
    for (const [i, line] of lines.entries()) {
      expect(line).toMatchObject({
        event: 'mcp.tool_call',
        actorKind: 'ai',
        clientId: 'pat:t1',
        status: app.calls[i]!.status,
        opId: `${app.calls[i]!.method} ${app.calls[i]!.url.split('?')[0]}`,
      });
      expect(line['argsSha256']).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof line['latencyMs']).toBe('number');
    }
  });

  it('never writes the token, the grant nonce or the request body to any log level', async () => {
    const app = guardedApp();
    const tools = await connect(app);
    await tools.call('work_items_create', { projectId: 'p1', title: SECRET_TITLE });
    const refused = await connect(app, 'globex');
    expect(
      (await refused.call('work_items_create', { projectId: 'p1', title: SECRET_TITLE })).isError,
    ).toBe(true);

    expect(logged.length).toBeGreaterThan(0);
    const all = logged.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toMatch(/bearer/i);
    expect(all).not.toContain(SECRET_TITLE);
    for (const call of app.calls) expect(all).not.toContain(call.headers[INTERNAL_GRANT_HEADER]!);
  });
});

describe('S14B tool call — workspace isolation', () => {
  it('acts in the token’s own workspace, tagged as the AI-assistant channel', async () => {
    const app = guardedApp();
    const tools = await connect(app);
    await tools.call('work_items_create', { projectId: 'p1', title: 'x' });
    const call = app.calls.at(-1)!;
    expect(call.status).toBe(200);
    expect(call.url.startsWith('/v1/organizations/acme/')).toBe(true);
    expect(call.organizationId).toBe('org-a');
    expect(call.actorChannel).toBe('ai_assistant');
  });

  it('the model cannot name a workspace: an orgSlug argument is ignored', async () => {
    const app = guardedApp();
    const tools = await connect(app);
    await tools.call('work_items_get', { workItemId: 'wi-9', orgSlug: 'globex' });
    const call = app.calls.at(-1)!;
    expect(call.url.startsWith('/v1/organizations/acme/')).toBe(true);
    expect(call.organizationId).toBe('org-a');
  });

  it('a token bound to workspace A cannot touch workspace B, even one its member is in', async () => {
    const app = guardedApp();
    const tools = await connect(app, 'globex');
    expect((await tools.call('work_items_get', { workItemId: 'wi-9' })).isError).toBe(true);
    expect((await tools.call('work_items_create', { projectId: 'p1', title: 'x' })).isError).toBe(
      true,
    );
    const refused = app.calls.filter((c) => c.url.startsWith('/v1/organizations/globex/'));
    expect(refused).toHaveLength(2);
    for (const call of refused) {
      expect(call.status).toBe(404);
      expect(call.auditCode).toBe('token_organization_mismatch');
      expect(call.organizationId).toBeUndefined();
    }
  });

  it('an unknown workspace answers the same 404 as a foreign one (no tenant oracle)', async () => {
    const app = guardedApp();
    const foreign = await (
      await connect(app, 'globex')
    ).call('work_items_get', { workItemId: 'w' });
    const unknown = await (
      await connect(app, 'nope-co')
    ).call('work_items_get', { workItemId: 'w' });
    expect(app.calls.map((c) => c.status)).toEqual([404, 404]);
    expect(foreign.isError && unknown.isError).toBe(true);
    expect(foreign.data).toBe(unknown.data);
  });
});

describe('S14B tool call — calls outside the granted scope', () => {
  // Was S14 FINDING (F3, fixed in FX2): no scope was enforced on a tool call at `POST /mcp`. The
  // endpoint now accepts OAuth access tokens, carries the grant's scopes in the internal grant, and
  // checks `grantCoversScope` on every call: a call outside the scopes answers 403 with the
  // `insufficient_scope` challenge (plan §4.1/§4.2, T-SCP-01) before any inner request runs.
  it('a read-only grant’s write tool call is refused with 403 insufficient_scope', async () => {
    const app = guardedApp();
    const call = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'work_items_create', arguments: { projectId: 'p1', title: 'x' } },
    };
    await expect(
      endpoint(app, 'acme').handle(
        oauthRequest('tmanage:read', call) as never,
        {
          hijack: vi.fn(),
          raw: {},
        } as never,
      ),
    ).rejects.toMatchObject({
      status: 403,
      wwwAuthenticate: expect.stringContaining('error="insufficient_scope"'),
    });
    // The same through the meta-tool: an action id does not get round the scope check.
    const viaRunAction = {
      ...call,
      params: {
        name: 'tmanage_run_action',
        arguments: { action_id: 'work_items.create', args: { title: 'x' } },
      },
    };
    await expect(
      endpoint(app, 'acme').handle(
        oauthRequest('tmanage:read', viaRunAction) as never,
        {
          hijack: vi.fn(),
          raw: {},
        } as never,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(app.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('a read-only grant is served no write tools, and the runtime refuses one if reached', async () => {
    const app = guardedApp();
    const tools = await connect(app, 'acme', oauthRequest('tmanage:read'));
    await expect(tools.call('work_items_create', { title: 'x' })).rejects.toThrow(/not served/);
    const viaRunAction = await tools.call('tmanage_run_action', {
      action_id: 'work_items.create',
      args: { title: 'x' },
    });
    expect(viaRunAction.isError).toBe(true);
    expect(app.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('carries the token’s scopes in the internal grant of every inner call', async () => {
    const app = guardedApp();
    const mint = vi.spyOn(internalGrants, 'mint');
    const tools = await connect(app, 'acme', oauthRequest('tmanage:read'));
    const result = await tools.call('work_items_get', { workItemId: 'wi-1' });
    expect(result.isError).toBeFalsy();
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0]![0]).toMatchObject({
      scopes: 'tmanage:read',
      clientId: 'client-1',
      clientName: 'Claude',
      organizationId: 'org-a',
    });
    expect(app.calls.at(-1)!.status).toBe(200);
  });
});
