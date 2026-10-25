import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Capability } from '@tmanage/domain';
import {
  AI_SCOPES,
  NEVER,
  OPS,
  RISK_CLASSES,
  classifiedRouteKeys,
  neverByKey,
  opByRouteKey,
  routeKey,
} from './index.js';
import { IS_PUBLIC, REQUIRED_CAPABILITY, SKIPS_TENANT } from '../../../common/http/decorators.js';

declare global {
  // Vite provides `import.meta.glob` at transform time; declare its (eager) shape for `tsc`.
  interface ImportMeta {
    glob(pattern: string, options: { eager: true }): Record<string, Record<string, unknown>>;
  }
}

/**
 * T-REG-01 — `registry-sync.every-route-classified` (plan §6, architecture B3).
 *
 * The registry is only safe if it cannot silently fall behind the API. This test is the thing
 * that keeps it honest: it enumerates every live HTTP route from the controllers themselves and
 * fails unless each one is classified *exactly once* — as an op in the registry or as a `NEVER`
 * deny-list entry — with the op's mirrored capability matching the route's real capability.
 *
 * A new unclassified route therefore fails the build, which is the whole point of slice S1: the
 * AI surface can never quietly acquire a route nobody risk-classified.
 *
 * ## Why reflection rather than a booted Nest app
 *
 * The plan sketched `DiscoveryService` + `Reflector`, which need a running application context —
 * and this application's context needs a database (ADR-0002). This is a `unit` test, so instead
 * it reads the very same metadata those services read (`@Controller`/`@Get`/… and the custom
 * route symbols) straight off the controller classes, with no container and no database. The
 * route set this produces is identical to the router's, because it is the router's own input.
 */

/** Nest's own metadata keys (`@nestjs/common/constants`): the route path and HTTP verb index. */
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
/** `RequestMethod` enum order. Only the first five occur across the 710 routes. */
const METHOD_NAMES = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/** The number of live routes at the time slice S1 classified them (plan §2). A canary: when the
 *  API genuinely gains or loses a route this is updated in the same change that classifies it.
 *  710 at S1; +6 at S7 (the OAuth AS: three discovery metadata GETs and /oauth authorize, token,
 *  revoke); +1 at S8 (POST /oauth/register, DCR); +2 at S13 (GET /openapi/ai.json and
 *  GET /downloads/tmanage-mcp.tgz, the connector's discovery/distribution surface), all withheld
 *  via NEVER. S9: +3 (GET /v1/oauth/consent, POST /v1/oauth/consent/deny and
 *  POST /v1/organizations/:orgSlug/oauth/consent, the consent page's API), also NEVER.
 *  S10: +3 (GET, approve and decline under /v1/organizations/:orgSlug/ai/approvals/:id, the
 *  approve page's API), also NEVER. 0210 (Google Drive storage): +11 — 4 ops (storage state,
 *  attachments list/create/delete) and 7 NEVER (`storage_connection`). S11: +4 (the Connected
 *  apps list, revoke and workspace AI switch under /v1/organizations/:orgSlug/oauth, and
 *  PUT /v1/platform/settings/ai-access), all NEVER. 0211 (deliverables, audit gap 1): +6 ops
 *  under /v1/organizations/:orgSlug/deliverables (list, create, get, versions, approvers, send).
 *  0212 (request messages, audit gap 4): +4 ops, GET/POST .../client-requests/:id/messages and
 *  GET/POST .../portal/requests/:id/messages. BK3 (0214): +5 ops, GET .../mention-candidates
 *  and GET/POST .../direct-conversations(/:id/messages). BK5 (0213): +2 ops, PATCH .../meetings/:meetingId
 *  and DELETE .../meetings/:meetingId/attendees/:attendeeId.
 *  Q4: +1 op, POST .../members/:membershipId/password-reset (org-admin reset link, confirm).
 *  t2-b: +2 ops, GET/PUT .../me/profile (the member's own name and job title).
 *  BK3-left (0216): +1 op, PUT .../direct-conversations/:id/read-state (DM mark-read).
 *  BK5 (0217): +4 ops, GET .../meetings/:meetingId/attendees/client-candidates and
 *  GET/GET/PUT .../portal/meetings(/:meetingId(/rsvp)) (client people as attendees).
 *  A14 (0226): +1 op, DELETE .../automations/templates/:id (soft-delete a rule, confirm).
 *  A10 (0223): +1 op, GET .../projects/:projectId/updates (internal updates list, drafts included).
 *  A7 (0220): +1 op, POST .../client-requests/:clientRequestId/reopen ("Reopen now").
 *  A11 (0224): +4 ops, GET .../profile, PATCH /v1/organizations/:orgSlug, PUT/DELETE .../logo.
 *  A9 (0222): +2 ops, GET .../projects/:projectId/milestone-plan and DELETE .../milestones/:id.
 *  B4: +1 op, PATCH .../documents/:documentId (rename, optimistic on updatedAt).
 *  B3: +2 ops, GET/PATCH .../file-download-policy (downloads before a virus scan, owner-only write).
 *  C5: +1 op, GET .../conversations/:conversationId/reactions (batched reaction tallies). */
const EXPECTED_ROUTE_COUNT = 785; // D4: +2 ops, GET .../billing/plan-usage(/preview).

interface LiveRoute {
  readonly method: string;
  readonly path: string;
  readonly capability: Capability | null;
  readonly isPublic: boolean;
  readonly skipsTenant: boolean;
  readonly source: string;
}

/** Build the full route path exactly as the extractor that generated the registry did. */
function joinPath(basePath: string, subPath: string): string {
  return `/${[basePath, subPath].filter((s) => s !== undefined && s !== '').join('/')}`.replace(
    /\/+/g,
    '/',
  );
}

function enumerateLiveRoutes(): LiveRoute[] {
  // Eagerly import every controller. Importing only defines the classes (no providers are
  // instantiated and nothing connects to a database), so reading their metadata is cheap.
  // `import.meta.glob` is a Vite transform: it must be referenced by that exact literal name
  // (Vite replaces it statically), so the call stays verbatim and `ImportMeta` is augmented
  // below to give `tsc` its type without pulling in all of `vite/client`'s globals.
  const modules = import.meta.glob('../../**/*.controller.ts', { eager: true });
  const routes: LiveRoute[] = [];
  for (const [modulePath, mod] of Object.entries(modules)) {
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const ctor = exported as new (...args: unknown[]) => unknown;
      const basePath = Reflect.getMetadata(PATH_METADATA, ctor);
      if (basePath === undefined) continue; // not a controller
      const classPublic = Reflect.getMetadata(IS_PUBLIC, ctor) === true;
      const classSkipsTenant = Reflect.getMetadata(SKIPS_TENANT, ctor) === true;
      const proto = ctor.prototype as object;
      for (const handlerName of Object.getOwnPropertyNames(proto)) {
        if (handlerName === 'constructor') continue;
        const handler = (proto as Record<string, unknown>)[handlerName];
        if (typeof handler !== 'function') continue;
        if (!Reflect.hasMetadata(PATH_METADATA, handler)) continue;
        const subPath = Reflect.getMetadata(PATH_METADATA, handler) as string;
        const methodIdx = Reflect.getMetadata(METHOD_METADATA, handler) as number;
        const method = METHOD_NAMES[methodIdx] ?? `IDX_${methodIdx}`;
        const capability =
          (Reflect.getMetadata(REQUIRED_CAPABILITY, handler) as Capability | undefined) ??
          (Reflect.getMetadata(REQUIRED_CAPABILITY, ctor) as Capability | undefined) ??
          null;
        routes.push({
          method,
          path: joinPath(basePath as string, subPath),
          capability,
          isPublic: Reflect.getMetadata(IS_PUBLIC, handler) === true || classPublic,
          skipsTenant: Reflect.getMetadata(SKIPS_TENANT, handler) === true || classSkipsTenant,
          source: `${modulePath} ${handlerName}`,
        });
      }
    }
  }
  return routes;
}

const liveRoutes = enumerateLiveRoutes();
const liveByKey = new Map(liveRoutes.map((r) => [routeKey(r.method, r.path), r] as const));

describe('AI action registry sync (T-REG-01)', () => {
  it('discovers the live routes at all', () => {
    expect(liveRoutes.length).toBeGreaterThan(0);
  });

  it('classifies every live route exactly once (op XOR never)', () => {
    const unclassified: string[] = [];
    const doubleClassified: string[] = [];
    for (const [key, route] of liveByKey) {
      const isOp = opByRouteKey.has(key);
      const isNeverKey = neverByKey.has(key);
      if (!isOp && !isNeverKey) unclassified.push(`${key}  (${route.source})`);
      if (isOp && isNeverKey) doubleClassified.push(key);
    }
    expect(unclassified, `unclassified live routes:\n${unclassified.join('\n')}`).toEqual([]);
    expect(
      doubleClassified,
      `routes in both OPS and NEVER:\n${doubleClassified.join('\n')}`,
    ).toEqual([]);
  });

  it('has no op or never entry pointing at a route that no longer exists', () => {
    const stale: string[] = [];
    for (const key of classifiedRouteKeys()) if (!liveByKey.has(key)) stale.push(key);
    expect(stale, `classified routes with no matching live route:\n${stale.join('\n')}`).toEqual(
      [],
    );
  });

  it("mirrors each op's capability from the live route (drift detector)", () => {
    const mismatches: string[] = [];
    for (const op of OPS) {
      const live = liveByKey.get(routeKey(op.method, op.path));
      if (!live) continue; // covered by the stale-entry test
      if ((op.capability ?? null) !== (live.capability ?? null))
        mismatches.push(`${op.id}: op=${op.capability} live=${live.capability}`);
    }
    expect(mismatches, `capability drift:\n${mismatches.join('\n')}`).toEqual([]);
  });

  it('never exposes a public or tenant-less route as an op (architecture B3)', () => {
    const leaked: string[] = [];
    for (const op of OPS) {
      const live = liveByKey.get(routeKey(op.method, op.path));
      if (live && (live.isPublic || live.skipsTenant)) leaked.push(op.id);
    }
    expect(leaked, `ops referencing ungated routes:\n${leaked.join('\n')}`).toEqual([]);
  });

  it('withholds every public and tenant-less route via NEVER', () => {
    const exposedByOmission: string[] = [];
    for (const route of liveRoutes) {
      if (!route.isPublic && !route.skipsTenant) continue;
      if (!neverByKey.has(routeKey(route.method, route.path)))
        exposedByOmission.push(`${route.method} ${route.path}`);
    }
    expect(
      exposedByOmission,
      `ungated routes missing from NEVER:\n${exposedByOmission.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps op ids unique and fields well-formed', () => {
    const ids = OPS.map((op) => op.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const op of OPS) {
      expect(RISK_CLASSES, op.id).toContain(op.risk);
      expect(AI_SCOPES, op.id).toContain(op.scope);
      expect(op.id, op.path).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
    }
  });

  it('accounts for the full known route surface (canary)', () => {
    expect(
      liveRoutes.length,
      `live route count changed from ${EXPECTED_ROUTE_COUNT} to ${liveRoutes.length}; ` +
        'classify the added/removed routes and update EXPECTED_ROUTE_COUNT in the same change.',
    ).toBe(EXPECTED_ROUTE_COUNT);
    expect(OPS.length + NEVER.length).toBe(liveRoutes.length);
  });
});
