import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

/**
 * Security audit run 1, F01 part b — which `@NoTenant()` routes a bound token may reach.
 *
 * A bound token (a personal access token, or the AI connector's OAuth token / internal grant) is a
 * key to ONE organization for an AI app or a script. Routes marked `@NoTenant()` are about the
 * person, not the company: sign-in, passwords, two-step factors, sessions, recovery, consent,
 * platform administration. None of them is something an AI app should drive, and an account-level
 * action taken with an org-bound token escapes the org binding entirely (F01: setting a first
 * password on a Google-only account turned a PAT into a full cookie session).
 *
 * So `TenantContextGuard` refuses a bound token on every non-public `@NoTenant()` route unless the
 * route is named here. Deny by default: a new `@NoTenant()` route is closed to tokens until someone
 * decides otherwise in this file.
 *
 * The list is exactly what the connector's own clients call outside a tenant:
 *
 * - `POST /mcp`, `GET /mcp`, `DELETE /mcp` — the hosted MCP endpoint (Streamable HTTP: requests,
 *   the event stream and session close). It checks the AI switches and the grant itself.
 * - `GET /v1/organizations` — the stdio bridge (`apps/mcp-server/src/api-client.ts`) lists the one
 *   organization its token is bound to.
 *
 * Every AI action in the registry (the OpenAPI document and the MCP tool catalog) is under
 * `/v1/organizations/:orgSlug/...`, so it is tenant-scoped and never needs an entry here.
 *
 * Keys are `METHOD /path` with the route template exactly as the controllers declare it (no
 * trailing slash), matched from the handler's own metadata — never from the request URL, so a
 * crafted URL cannot pick its way onto the list.
 */
export const BOUND_TOKEN_NO_TENANT_ALLOWLIST: ReadonlySet<string> = new Set([
  'POST /mcp',
  'GET /mcp',
  'DELETE /mcp',
  'GET /v1/organizations',
]);

/** Nest's own metadata keys (`@nestjs/common/constants`): the route path and HTTP verb index. */
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
/** `RequestMethod` enum order. */
const METHOD_NAMES = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/** `METHOD /a/b` from a controller base path and a handler sub-path, without a trailing slash. */
export function boundTokenRouteKey(method: string, basePath: string, subPath: string): string {
  const joined = `/${[basePath, subPath].filter((s) => s !== '').join('/')}`.replace(/\/+/g, '/');
  const path = joined.length > 1 ? joined.replace(/\/+$/, '') : joined;
  return `${method.toUpperCase()} ${path}`;
}

function pathOf(value: unknown): string {
  if (typeof value === 'string') return value;
  // `@Controller(['a', 'b'])` is never used here; take the first form if it ever is.
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

/** The route key of the handler this request matched, read from the route metadata. */
export function routeKeyOf(reflector: Reflector, context: ExecutionContext): string | undefined {
  const handler = context.getHandler() as unknown;
  const controller = context.getClass() as unknown;
  if (typeof handler !== 'function') return undefined;
  const methodIndex = reflector.get<unknown>(METHOD_METADATA, handler);
  if (typeof methodIndex !== 'number') return undefined;
  const method = METHOD_NAMES[methodIndex];
  if (method === undefined) return undefined;
  const basePath =
    typeof controller === 'function'
      ? pathOf(reflector.get<unknown>(PATH_METADATA, controller))
      : '';
  return boundTokenRouteKey(
    method,
    basePath,
    pathOf(reflector.get<unknown>(PATH_METADATA, handler)),
  );
}

/** May a bound token reach this `@NoTenant()` route? Unknown routes are refused. */
export function boundTokenAllowedOnNoTenantRoute(
  reflector: Reflector,
  context: ExecutionContext,
): boolean {
  const key = routeKeyOf(reflector, context);
  return key !== undefined && BOUND_TOKEN_NO_TENANT_ALLOWLIST.has(key);
}
