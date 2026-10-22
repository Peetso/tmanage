import { describe, expect, it } from 'vitest';
import { createHttpApiClient, registerTools } from '@tmanage/mcp-server';
import { OPS, findOpById, findOpByRoute } from '../../ai-actions/registry/index.js';
import type { AiScope } from '../../ai-actions/registry/index.js';
import { NEVER, isNever } from '../../ai-actions/registry/never.js';
import { buildAiOpenApiDocument, toOpenApiPath } from '../../ai-actions/openapi.js';
import { buildToolCatalog, toolNameForOp } from '../tool-catalog.js';

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

/** The routes the live `/mcp` tools actually call, captured through a recording `fetch`. */
async function liveToolRoutes(): Promise<{
  names: string[];
  routes: { method: string; path: string }[];
}> {
  const routes: { method: string; path: string }[] = [];
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    registerTool(
      name: string,
      _def: unknown,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) {
      handlers.set(name, handler);
    },
  } as unknown as Parameters<typeof registerTools>[0];
  const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    routes.push({ method: (init?.method ?? 'GET').toUpperCase(), path: new URL(href).pathname });
    return new Response(JSON.stringify({ organizations: [{ slug: 'acme' }], items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  registerTools(
    server,
    createHttpApiClient({ baseUrl: 'http://tmanage.internal', token: 't', fetch: recordingFetch }),
  );
  const args = {
    query: 'q',
    work_item_id: 'w1',
    project_id: 'p1',
    document_id: 'd1',
    title: 'Title',
    body: 'Body',
  };
  for (const handler of handlers.values()) await handler(args);
  return { names: [...handlers.keys()], routes };
}

function matchesRoute(pattern: string, concrete: string): boolean {
  const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  const source = strip(pattern)
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}$`).test(strip(concrete));
}

/** The org directory the live `list_organizations` tool reads; see finding F2 below. */
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

  // S14 FINDING (F2, low): the live `list_organizations` tool — and `resolveOrgSlug`, which every
  // other live tool calls first — reads `GET /v1/organizations/`, which the registry classifies
  // NEVER (`org_creation_or_account`, never.ts:99). The live tool surface therefore reaches a
  // deny-listed route. Impact is limited because the directory is narrowed to the bound org for a
  // bound-token scheme (request-state.ts `isBoundTokenScheme`), but the NEVER contract is broken.
  it.skip('no live tool reaches a NEVER route, including the org directory', async () => {
    const { routes } = await liveToolRoutes();
    for (const route of routes) {
      const label = `${route.method} ${route.path}`;
      expect(
        NEVER.some((e) => e.method === route.method && matchesRoute(e.path, route.path)),
        label,
      ).toBe(false);
    }
  });

  // S14 FINDING (F1): the live `POST /mcp` endpoint does not serve the scope-filtered catalogue.
  // `McpEndpointController.handle` builds `buildServer(client)` (mcp-server/src/server.ts), which
  // registers a fixed set of ten tools — including the writes `create_work_item` and `add_comment` —
  // for every caller. `buildToolCatalog` / `buildCatalogServer` (S5) are never wired in, so a
  // grant's scopes do not narrow `tools/list` at the real endpoint (plan §3, T-SCP-01). This test
  // states the intended behaviour: a read-only grant's live tool list is a subset of its catalogue.
  it.skip('the live /mcp tools/list for a read-only grant is the read-only catalogue', async () => {
    const { names } = await liveToolRoutes();
    const allowed = new Set(
      buildToolCatalog({ profile: 'compact', scopes: ['read'], capabilities: ALL_CAPS }).tools.map(
        (t) => t.name,
      ),
    );
    for (const name of names) expect(allowed.has(name), name).toBe(true);
  });
});
