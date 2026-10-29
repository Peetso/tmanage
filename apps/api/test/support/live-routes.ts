import 'reflect-metadata';
import { IS_PUBLIC, REQUIRED_CAPABILITY } from '../../src/common/http/decorators.js';
import { PLATFORM_PERMISSION_METADATA } from '../../src/modules/platform-admin/require-platform-permission.decorator.js';
import {
  PUBLIC_ROUTE_POLICIES,
  THROTTLE_POLICY,
} from '../../src/modules/rate-limits/throttle-policies.js';
import type { CensusRoute } from '../../src/security/route-census.js';

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { eager: true }): Record<string, Record<string, unknown>>;
  }
}

/**
 * Every live HTTP route, read from Nest's own controller metadata — the same reflection
 * `src/security/sdlc-census.test.ts` (56-15) performs, shared here for the 56-04 suites (the
 * permission-map census and the BOLA corpus) so they enumerate exactly the routes the census
 * classifies. Nest's metadata keys; `RequestMethod` enum order.
 */
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

export function liveRoutes(): CensusRoute[] {
  const out: CensusRoute[] = [];
  for (const mod of Object.values(
    import.meta.glob('../../src/**/*.controller.ts', { eager: true }),
  )) {
    for (const ctor of Object.values(mod)) {
      if (typeof ctor !== 'function') continue;
      const base = Reflect.getMetadata('path', ctor) as string | undefined;
      if (base === undefined) continue;
      const proto = (ctor as { prototype: Record<string, unknown> }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const h = proto[name];
        if (name === 'constructor' || typeof h !== 'function') continue;
        if (!Reflect.hasMetadata('path', h)) continue;
        const meta = (k: unknown): unknown =>
          Reflect.getMetadata(k, h) ?? Reflect.getMetadata(k, ctor);
        const sub = Reflect.getMetadata('path', h) as string;
        const path = `/${[base, sub].filter(Boolean).join('/')}`.replace(/\/+/g, '/');
        const guards = [
          ...((Reflect.getMetadata('__guards__', ctor) as unknown[] | undefined) ?? []),
          ...((Reflect.getMetadata('__guards__', h) as unknown[] | undefined) ?? []),
        ];
        const handlerKey = `${ctor.name}.${name}`;
        out.push({
          key: `${METHODS[Reflect.getMetadata('method', h) as number] ?? '?'} ${path}`,
          handlerKey,
          isPublic: meta(IS_PUBLIC) === true,
          hasCapability: meta(REQUIRED_CAPABILITY) !== undefined,
          hasPlatformPermission: meta(PLATFORM_PERMISSION_METADATA) !== undefined,
          hasPlatformGuard: guards.some(
            (g) => typeof g === 'function' && g.name === 'PlatformAdminGuard',
          ),
          hasNamedThrottle:
            meta(THROTTLE_POLICY) !== undefined || handlerKey in PUBLIC_ROUTE_POLICIES,
        });
      }
    }
  }
  return out;
}
