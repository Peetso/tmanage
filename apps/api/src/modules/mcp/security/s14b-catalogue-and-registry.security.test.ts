import { describe, expect, it, vi } from 'vitest';
import type { HttpAdapterHost } from '@nestjs/core';
import type { Catalog, CatalogProfile, CatalogRuntime } from '@tmanage/mcp-server';
import type * as McpServerModule from '@tmanage/mcp-server';
import { requireRequestState } from '../../../common/http/request-state.js';
import { OPS, findOpById, findOpByRoute } from '../../ai-actions/registry/index.js';
import type { AiScope } from '../../ai-actions/registry/index.js';
import { NEVER, isNever } from '../../ai-actions/registry/never.js';
import { buildAiOpenApiDocument, toOpenApiPath } from '../../ai-actions/openapi.js';
import { buildToolCatalog, toolNameForOp } from '../tool-catalog.js';
import { McpEndpointController } from '../mcp-endpoint.controller.js';
import type { InjectCapable } from '../mcp-endpoint.controller.js';
import { recordMcpOAuthAccess } from '../mcp-auth.js';

/** The catalogue and runtime the real `/mcp` controller hands to the MCP transport. */
const captured = vi.hoisted(() => ({ surfaces: [] as { catalog: unknown; runtime: unknown }[] }));

vi.mock('@tmanage/mcp-server', async (importOriginal) => {
  const actual = await importOriginal<typeof McpServerModule>();
  return {
    ...actual,
    buildCatalogServer: vi.fn((catalog: unknown, runtime: unknown) => {
      captured.surfaces.push({ catalog, runtime });
      return {};
    }),
    serveMcpRequest: vi.fn(async () => undefined),
  };
});

/**
 * S14B — AI-connector security suite: the tool surface (catalogue + registry).
 *
 * What an AI client can *see* and *reach*: the catalogue is filtered by the grant's scopes and the
 * member's capabilities, nothing on the deny-list (NEVER) is ever a tool, and the discovery /
 * connector routes themselves (OAuth metadata, the OpenAPI document, the bridge download, `/mcp`)
 * are never callable as actions. Pure and in-memory: no server, no database.
 */

const ALL_SCOPES: readonly AiScope[] = ['read', 'write', 'manage', 'billing'];
const ALL_CAPS: ReadonlySet<string> = new Set<string>(
  OPS.map((op) => op.capability).filter((c): c is NonNullable<typeof c> => c !== null),
);
const opByToolName = new Map(OPS.map((op) => [toolNameForOp(op.id), op] as const));

/** The discovery and connector routes an AI must never be able to call (plan §2, B3). */
const DISCOVERY_ROUTES: readonly (readonly [string, string])[] = [
  ['GET', '/.well-known/oauth-authorization-server'],
  ['GET', '/.well-known/oauth-protected-resource'],
  ['GET', '/.well-known/oauth-protected-resource/mcp'],
  ['GET', '/openapi/ai.json'],
  ['GET', '/downloads/tmanage-mcp.tgz'],
  ['POST', '/mcp/'],
  ['GET', '/mcp/'],
  ['DELETE', '/mcp/'],
];

function catalogueOpIds(scopes: readonly AiScope[], capabilities = ALL_CAPS): string[] {
  const ids: string[] = [];
  for (const profile of ['compact', 'full'] as const) {
    for (const tool of buildToolCatalog({ profile, scopes, capabilities }).tools) {
      if (tool.opId !== undefined) ids.push(tool.opId);
    }
  }
  return ids;
}

describe('S14B catalogue — filtered by granted scopes and capabilities', () => {
  it('a read-only grant lists read ops only, in both profiles', () => {
    const ids = catalogueOpIds(['read']);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const op = findOpById(id);
      expect(op?.scope, id).toBe('read');
      expect(op?.risk, id).toBe('read');
    }
  });

  it('a read-only compact catalogue drops every core write tool but keeps the reads', () => {
    const names = new Set(
      buildToolCatalog({ profile: 'compact', scopes: ['read'], capabilities: ALL_CAPS }).tools.map(
        (t) => t.name,
      ),
    );
    for (const write of [
      'work_items_create',
      'work_items_update',
      'work_items_comments_create',
      'work_items_transitions_create',
      'documents_create',
      'documents_comments_create',
      'conversations_messages_create',
    ]) {
      expect(names.has(write), write).toBe(false);
    }
    expect(names.has('work_items_list')).toBe(true);
    expect(names.has('documents_get')).toBe(true);
  });

  it('billing ops never appear without the billing scope, and manage never implies it', () => {
    for (const id of catalogueOpIds(['read', 'write', 'manage'])) {
      expect(findOpById(id)?.scope, id).not.toBe('billing');
    }
    for (const id of catalogueOpIds(['billing'])) {
      expect(findOpById(id)?.scope, id).toBe('billing');
    }
  });

  it('a member with no capabilities sees only ops that need no capability', () => {
    for (const id of catalogueOpIds(ALL_SCOPES, new Set())) {
      expect(findOpById(id)?.capability, id).toBeNull();
    }
  });

  it('no tool in any profile, at full scopes and capabilities, maps to a NEVER route', () => {
    const full = buildToolCatalog({ profile: 'full', scopes: ALL_SCOPES, capabilities: ALL_CAPS });
    expect(full.tools.length).toBeGreaterThan(0);
    for (const id of catalogueOpIds(ALL_SCOPES)) {
      const op = findOpById(id);
      expect(op, id).toBeDefined();
      expect(isNever(op!.method, op!.path), id).toBe(false);
    }
    // And the registry itself never double-books a route as both an op and NEVER.
    for (const entry of NEVER) {
      expect(findOpByRoute(entry.method, entry.path), `${entry.method} ${entry.path}`).toBe(
        undefined,
      );
    }
  });
});

describe('S14B registry — discovery and connector routes are NEVER callable', () => {
  it('marks every discovery route NEVER and gives none of them an op', () => {
    for (const [method, path] of DISCOVERY_ROUTES) {
      expect(isNever(method, path), `${method} ${path}`).toBe(true);
      expect(findOpByRoute(method, path), `${method} ${path}`).toBeUndefined();
    }
  });

  it('keeps every discovery route out of the full catalogue', () => {
    const full = buildToolCatalog({ profile: 'full', scopes: ALL_SCOPES, capabilities: ALL_CAPS });
    const reachable = new Set(
      full.tools.map((t) => {
        const op = opByToolName.get(t.name)!;
        return `${op.method} ${op.path}`;
      }),
    );
    for (const [method, path] of DISCOVERY_ROUTES) {
      expect(reachable.has(`${method} ${path}`), `${method} ${path}`).toBe(false);
    }
  });

  it('keeps every discovery route and every NEVER route out of the OpenAPI fallback', () => {
    const doc = buildAiOpenApiDocument();
    const paths = (doc['paths'] ?? {}) as Record<string, Record<string, unknown>>;
    for (const entry of NEVER) {
      const operations = paths[toOpenApiPath(entry.path)];
      expect(operations?.[entry.method.toLowerCase()], `${entry.method} ${entry.path}`).toBe(
        undefined,
      );
    }
    for (const [, path] of DISCOVERY_ROUTES) {
      expect(paths[toOpenApiPath(path)], path).toBeUndefined();
    }
  });
});

const USER = '0198f4a2-1c00-7000-8000-00000000000c';
const ALL_OAUTH_SCOPES = 'tmanage:read tmanage:write tmanage:manage tmanage:billing';

/** An OAuth request to `POST /mcp` as `SessionAuthGuard` leaves it, for a grant with `scopes`. */
function oauthMcpRequest(scopes: string, profile: CatalogProfile): object {
  const request = {
    method: 'POST',
    headers: { authorization: 'Bearer opaque-oauth-access-token' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    raw: { url: profile === 'full' ? '/mcp?tools=full' : '/mcp' },
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

/**
 * Drive the real `McpEndpointController` for one grant, then run every tool (and read every
 * resource) it serves, recording each in-process route the calls reach.
 */
async function liveToolRoutes(
  scopes = ALL_OAUTH_SCOPES,
  profile: CatalogProfile = 'full',
): Promise<{
  names: string[];
  routes: { method: string; path: string }[];
}> {
  const routes: { method: string; path: string }[] = [];
  const app: InjectCapable = {
    async inject({ method, url }) {
      routes.push({ method, path: url.split('?')[0]! });
      return { statusCode: 200, body: '{}', headers: { 'content-type': 'application/json' } };
    },
  };
  const host = { httpAdapter: { getInstance: () => app } } as unknown as HttpAdapterHost;
  const workspaces = { resolve: async () => ({ orgSlug: 'acme', capabilities: ALL_CAPS }) };
  const reply = { hijack: vi.fn(), raw: {} } as never;
  await new McpEndpointController(host, undefined, workspaces).handle(
    oauthMcpRequest(scopes, profile) as never,
    reply,
  );
  const { catalog, runtime } = captured.surfaces.at(-1) as {
    catalog: Catalog;
    runtime: CatalogRuntime;
  };
  for (const tool of catalog.tools) {
    const op = tool.opId === undefined ? undefined : findOpById(tool.opId);
    const args: Record<string, unknown> =
      op === undefined
        ? { query: 'work', action_id: 'work_items.list', args: {}, approval_id: 'a1' }
        : Object.fromEntries(
            [...op.path.matchAll(/:([A-Za-z0-9_]+)/g)]
              .map((m) => m[1]!)
              .filter((name) => name !== 'orgSlug')
              .map((name) => [name, 'x'] as const),
          );
    await runtime.runTool(tool, args);
  }
  for (const resource of catalog.resources) {
    await runtime.readResource(resource, new URL('tmanage://me/today'), { slug: 'x', id: 'p1' });
  }
  return { names: catalog.tools.map((t) => t.name), routes };
}

function matchesRoute(pattern: string, concrete: string): boolean {
  const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  const source = strip(pattern)
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}$`).test(strip(concrete));
}

/** The org directory the retired `list_organizations` tool read; see finding F2 below. */
const ORG_DIRECTORY = 'GET /v1/organizations';

describe('S14B live /mcp tools — reach only classified ops, never a NEVER route', () => {
  it('every tool-call route (bar the F2 directory read) is a registry op, none on the deny-list', async () => {
    const { routes } = await liveToolRoutes();
    const toolCalls = routes.filter((r) => `${r.method} ${r.path}` !== ORG_DIRECTORY);
    expect(toolCalls.length).toBeGreaterThan(0);
    for (const route of toolCalls) {
      const label = `${route.method} ${route.path}`;
      const never = NEVER.some(
        (e) => e.method === route.method && matchesRoute(e.path, route.path),
      );
      expect(never, label).toBe(false);
      const op = OPS.some((o) => o.method === route.method && matchesRoute(o.path, route.path));
      expect(op, label).toBe(true);
    }
  });

  // Was S14 FINDING (F2, fixed in FX2): the old live tools resolved the org through
  // `GET /v1/organizations/`, which the registry classifies NEVER. The endpoint now resolves the
  // org from the token's own workspace binding, server side, and no tool reaches the directory.
  it('no live tool reaches a NEVER route, including the org directory', async () => {
    const { routes } = await liveToolRoutes();
    for (const route of routes) {
      const label = `${route.method} ${route.path}`;
      expect(
        NEVER.some((e) => e.method === route.method && matchesRoute(e.path, route.path)),
        label,
      ).toBe(false);
    }
  });

  // Was S14 FINDING (F1, fixed in FX2): `POST /mcp` served a fixed tool set (including writes)
  // to every caller. It now serves `buildToolCatalog` for the grant, so a read-only grant's live
  // `tools/list` is its read-only catalogue (plan §3, T-SCP-01) — in both profiles.
  it('the live /mcp tools/list for a read-only grant is the read-only catalogue', async () => {
    for (const profile of ['compact', 'full'] as const) {
      const { names, routes } = await liveToolRoutes('tmanage:read', profile);
      expect(names.length).toBeGreaterThan(0);
      const allowed = new Set(
        buildToolCatalog({ profile, scopes: ['read'], capabilities: ALL_CAPS }).tools.map(
          (t) => t.name,
        ),
      );
      for (const name of names) expect(allowed.has(name), name).toBe(true);
      // And running every one of them reaches reads only.
      for (const route of routes) expect(route.method, `${route.method} ${route.path}`).toBe('GET');
    }
  });
});
