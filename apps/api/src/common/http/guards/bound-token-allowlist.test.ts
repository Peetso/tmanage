import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { IS_PUBLIC, SKIPS_TENANT } from '../decorators.js';
import {
  BOUND_TOKEN_NO_TENANT_ALLOWLIST,
  boundTokenRouteKey,
  routeKeyOf,
} from './bound-token-allowlist.js';

// `import.meta.glob` is typed by a global `ImportMeta` augmentation that ships with docx's
// declarations (R5), so this file no longer declares its own (that was a duplicate identifier);
// the eager result is cast to its shape.
type EagerModules = Record<string, Record<string, unknown>>;

/**
 * F01 part b — the bound-token allowlist for `@NoTenant()` routes stays exact.
 *
 * Every live route is read from the controllers' own metadata (the same reflection
 * `registry-sync.test.ts` uses, so no database and no booted app). The allowlist may name only
 * live, signed-in `@NoTenant()` routes, and the routes it names are the connector's two needs.
 */

interface LiveRoute {
  readonly key: string;
  readonly isPublic: boolean;
  readonly skipsTenant: boolean;
}

const reflector = new Reflector();

function enumerateLiveRoutes(): LiveRoute[] {
  const modules = import.meta.glob('../../../**/*.controller.ts', { eager: true }) as EagerModules;
  const routes: LiveRoute[] = [];
  for (const mod of Object.values(modules)) {
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const ctor = exported as new (...args: unknown[]) => unknown;
      if (Reflect.getMetadata('path', ctor) === undefined) continue;
      const proto = ctor.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        if (!Reflect.hasMetadata('path', handler)) continue;
        const context = {
          getHandler: () => handler,
          getClass: () => ctor,
        } as unknown as ExecutionContext;
        const key = routeKeyOf(reflector, context);
        if (key === undefined) continue;
        routes.push({
          key,
          isPublic:
            Reflect.getMetadata(IS_PUBLIC, handler) === true ||
            Reflect.getMetadata(IS_PUBLIC, ctor) === true,
          skipsTenant:
            Reflect.getMetadata(SKIPS_TENANT, handler) === true ||
            Reflect.getMetadata(SKIPS_TENANT, ctor) === true,
        });
      }
    }
  }
  return routes;
}

const live = enumerateLiveRoutes();

describe('bound-token allowlist for @NoTenant routes (F01 part b)', () => {
  it('reads route keys the way the controllers declare them', () => {
    expect(boundTokenRouteKey('post', '/mcp', '/')).toBe('POST /mcp');
    expect(boundTokenRouteKey('GET', 'v1/organizations', '')).toBe('GET /v1/organizations');
    expect(boundTokenRouteKey('GET', '/', '/')).toBe('GET /');
    expect(live.length).toBeGreaterThan(700);
  });

  it('names only live, signed-in @NoTenant routes', () => {
    const signedInNoTenant = new Set(
      live.filter((r) => r.skipsTenant && !r.isPublic).map((r) => r.key),
    );
    for (const key of BOUND_TOKEN_NO_TENANT_ALLOWLIST) {
      expect(signedInNoTenant.has(key), key).toBe(true);
    }
  });

  it('is exactly the MCP endpoint and the organization list', () => {
    expect([...BOUND_TOKEN_NO_TENANT_ALLOWLIST].sort()).toEqual(
      ['DELETE /mcp', 'GET /mcp', 'GET /v1/organizations', 'POST /mcp'].sort(),
    );
  });

  it('keeps the account routes of F01 closed to tokens', () => {
    const signedInNoTenant = live.filter((r) => r.skipsTenant && !r.isPublic).map((r) => r.key);
    for (const key of [
      'POST /v1/auth/password/set',
      'POST /v1/auth/reauth',
      'POST /v1/auth/factors/totp',
      'DELETE /v1/sessions',
      'POST /v1/platform/step-up',
    ]) {
      expect(signedInNoTenant).toContain(key);
      expect(BOUND_TOKEN_NO_TENANT_ALLOWLIST.has(key)).toBe(false);
    }
  });
});
