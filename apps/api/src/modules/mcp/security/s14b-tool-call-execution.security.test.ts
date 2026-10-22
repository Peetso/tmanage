import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import type { TManageApiClient } from '@tmanage/mcp-server';
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

/**
 * S14B — AI-connector security suite: executing an MCP tool call.
 *
 * Drives the real `McpEndpointController` (with the MCP transport stubbed out) and hands the API
 * client it builds to an in-memory "inject" that runs the real `SessionAuthGuard` and
 * `TenantContextGuard` on every inner request. That exercises, end to end and without a database:
 * the bearer token stripped before the inner request, the one-time internal grant (no replay), one
 * redacted audit record per call that never contains the token, and workspace isolation (a token
 * bound to workspace A cannot touch workspace B, even one its member also belongs to).
 */

const captured = vi.hoisted(() => ({ clients: [] as unknown[] }));

vi.mock('@tmanage/mcp-server', async (importOriginal) => {
  const actual = await importOriginal<typeof McpServerModule>();
  return {
    ...actual,
    // Keep the real API client (it is what sets the Bearer header), but remember it.
    createHttpApiClient: vi.fn((options: Parameters<typeof actual.createHttpApiClient>[0]) => {
      const client = actual.createHttpApiClient(options);
      captured.clients.push(client);
      return client;
    }),
    buildServer: vi.fn(() => ({})),
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

/** Run the real controller and return the API client it wired for the tool calls. */
async function connect(app: InjectCapable): Promise<TManageApiClient> {
  const host = { httpAdapter: { getInstance: () => app } } as unknown as HttpAdapterHost;
  const reply = { hijack: vi.fn(), raw: {} } as never;
  await new McpEndpointController(host).handle(patRequest() as never, reply);
  return captured.clients.at(-1) as TManageApiClient;
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
    const client = await connect(app);
    await client.createWorkItem('acme', { projectId: 'p1', title: SECRET_TITLE });

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
    const client = await connect(app);
    await client.createWorkItem('acme', { projectId: 'p1', title: 'x' });
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
    const client = await connect(app);
    await client.createWorkItem('acme', { projectId: 'p1', title: SECRET_TITLE });
    await client.addComment('acme', 'wi-1', SECRET_TITLE);

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
    const client = await connect(app);
    await client.createWorkItem('acme', { projectId: 'p1', title: SECRET_TITLE });
    await expect(
      client.createWorkItem('globex', { projectId: 'p1', title: SECRET_TITLE }),
    ).rejects.toBeDefined();

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
    const client = await connect(app);
    await client.createWorkItem('acme', { projectId: 'p1', title: 'x' });
    const call = app.calls.at(-1)!;
    expect(call.status).toBe(200);
    expect(call.organizationId).toBe('org-a');
    expect(call.actorChannel).toBe('ai_assistant');
  });

  it('a token bound to workspace A cannot touch workspace B, even one its member is in', async () => {
    const app = guardedApp();
    const client = await connect(app);
    await expect(client.getWorkItem('globex', 'wi-9')).rejects.toMatchObject({ status: 404 });
    await expect(
      client.createWorkItem('globex', { projectId: 'p1', title: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
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
    const client = await connect(app);
    const foreign = await client.getWorkItem('globex', 'w').catch((e: unknown) => e);
    const unknown = await client.getWorkItem('nope-co', 'w').catch((e: unknown) => e);
    expect(foreign).toMatchObject({ status: 404 });
    expect(unknown).toMatchObject({ status: 404 });
    expect((foreign as Error).message).toBe((unknown as Error).message);
  });
});

describe('S14B tool call — calls outside the granted scope', () => {
  // S14 FINDING (F3): no scope is enforced on a tool call at `POST /mcp`. The endpoint accepts only
  // a personal access token (mcp-endpoint.controller.ts `handle`, authScheme check), a PAT row has
  // no scopes, the internal grant payload carries none (internal-grant.ts InternalGrantPayload), and
  // `grantCoversScope` / `insufficientScopeChallenge` (oauth/scopes.ts) are never called outside
  // tests. So a write tool (`create_work_item`) always runs with the member's full power; plan §4.1
  // ("a PAT gets scopes too") and §4.2 / T-SCP-01 (403 insufficient_scope) are not met. OAuth access
  // tokens, which do carry scopes, are not accepted at `/mcp` at all. This test states the intent:
  // a read-only grant's write call is refused with 403 before any inner request runs.
  it.skip('a read-only grant’s write tool call is refused with 403 insufficient_scope', async () => {
    const app = guardedApp();
    const client = await connect(app);
    // There is no field to mark the grant read-only today; once one exists, set it in patRequest().
    await expect(
      client.createWorkItem('acme', { projectId: 'p1', title: 'x' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(app.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});
