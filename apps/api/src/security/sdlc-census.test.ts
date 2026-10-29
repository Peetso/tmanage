import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { IS_PUBLIC, REQUIRED_CAPABILITY } from '../common/http/decorators.js';
import { PLATFORM_PERMISSION_METADATA } from '../modules/platform-admin/require-platform-permission.decorator.js';
import {
  PUBLIC_ROUTE_POLICIES,
  THROTTLE_POLICY,
} from '../modules/rate-limits/throttle-policies.js';
import {
  credentialFindings,
  documentedNames,
  undocumentedSchemaSecrets,
} from '../../../../scripts/security/secrets-census.mjs';
import { missingSecurityLines } from '../../../../scripts/security/pr-security-block.mjs';
import { type CensusRoute, censusViolations, classifyRoute } from './route-census.js';

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { eager: true }): Record<string, Record<string, unknown>>;
  }
}

/** 56-15 census gates. Nest's own metadata keys; `RequestMethod` enum order. */
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

function liveRoutes(): CensusRoute[] {
  const out: CensusRoute[] = [];
  for (const mod of Object.values(import.meta.glob('../**/*.controller.ts', { eager: true }))) {
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

const bare: CensusRoute = {
  key: 'POST /v1/new-thing',
  handlerKey: 'NewController.create',
  isPublic: false,
  hasCapability: false,
  hasPlatformPermission: false,
  hasPlatformGuard: false,
  hasNamedThrottle: false,
};

describe('56-15 route authorization census', () => {
  it('places every live route in exactly one reviewed authorization class', () => {
    const routes = liveRoutes();
    expect(routes.length).toBeGreaterThan(900);
    const violations = censusViolations(routes);
    expect(violations, `census violations:\n${violations.join('\n')}`).toEqual([]);
  });

  it('refuses an unclassified route, a capability-less org route and an unlisted public route', () => {
    expect(classifyRoute(bare)).toHaveProperty('violation');
    expect(classifyRoute({ ...bare, key: 'DELETE /v1/organizations/:orgSlug/x' })).toHaveProperty(
      'violation',
    );
    expect(classifyRoute({ ...bare, isPublic: true })).toHaveProperty('violation');
  });
});

describe('56-15 secrets census', () => {
  it('flags a committed key shape and an undocumented schema secret', () => {
    const shape = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    expect(credentialFindings('a.ts', `const k = '${shape}';`)).toHaveLength(1);
    const documented = documentedNames('SESSION_SECRET=\n# SMTP_PASSWORD=\n');
    const schema = '    SESSION_SECRET: secret(),\n    SMTP_PASSWORD: z,\n    NEW_TOKEN: z,\n';
    expect(undocumentedSchemaSecrets('env.ts', schema, documented)).toEqual([
      'env.ts:3  secret NEW_TOKEN is in the environment schema but not listed in .env.example',
    ]);
  });
});

describe('56-15 pull-request SECURITY block', () => {
  it('accepts "none" answers and names the empty or placeholder lines', () => {
    const lines = ['Principals', 'Tables', 'Routes', 'Secrets', 'Public surface', 'Abuse case'];
    const body = `SECURITY:\n${lines.map((l) => `- ${l}: none`).join('\n')}\n- Tests:`;
    expect(missingSecurityLines(body)).toEqual(['Tests']);
    expect(missingSecurityLines(body.replace('- Tests:', '- Tests: SEC-01'))).toEqual([]);
    expect(missingSecurityLines(body.replace('Routes: none', 'Routes: <new routes>'))).toContain(
      'Routes',
    );
  });
});
