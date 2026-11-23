import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PLATFORM_PERMISSIONS } from '@tmanage/domain';
import { NEVER, OPS, OP_SENSITIVITY, isPlatformOp, routeKey } from './index.js';
import type { AiActionOp } from './index.js';
import {
  PLATFORM_FRESH_REAUTH_ROUTES,
  PLATFORM_TWO_PERSON_ROUTES,
  platformNeedsFreshReauth,
} from './platform-op.js';
import { PLATFORM_PERMISSION_METADATA } from '../../platform-admin/require-platform-permission.decorator.js';
import { PLATFORM_ADMIN_GUARD_MARK } from '../../../common/http/guards/bound-token-allowlist.js';
import { BOUND_TOKEN_NO_TENANT_ALLOWLIST } from '../../../common/http/guards/bound-token-allowlist.js';
import { IS_PUBLIC, SKIPS_TENANT } from '../../../common/http/decorators.js';
import { allDetailsById, buildToolCatalog } from '../../mcp/tool-catalog.js';
import { PAT_SCOPES, liveMcpSurface } from '../../mcp/catalog-runtime.js';
import {
  buildApprovalSummary,
  buildOpRequest,
  freezeConfirmAction,
  platformTargetLookup,
} from '../../mcp/pending-actions.js';
import { isUntrustedOp, isUntrustedOpId } from '../../copilot/untrusted-sources.js';
import { MAX_CARD_FIELDS, changeGateFor } from '../../copilot/ai-preview.js';
import { TWO_PERSON_ACTION } from '../../platform-admin/governance/two-person.guard.js';
import { buildAiOpenApiDocument } from '../openapi.js';

/**
 * ADR-0015 part 2 — the fitness functions of the platform admin path for AI principals (review
 * F1–F11, §5). Route facts are read from the controllers' own metadata, as `registry-sync` does.
 */

type EagerModules = Record<string, Record<string, unknown>>;
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const GUARDS_METADATA = '__guards__';
const METHOD_NAMES = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

interface LiveRoute {
  readonly key: string;
  readonly platformGuarded: boolean;
  readonly permission: string | null;
  readonly twoPerson: boolean;
  readonly noTenant: boolean;
  readonly isPublic: boolean;
}

function marked(guards: unknown): boolean {
  return (
    Array.isArray(guards) &&
    guards.some(
      (g) =>
        typeof g === 'function' &&
        (g as unknown as Record<symbol, unknown>)[PLATFORM_ADMIN_GUARD_MARK] === true,
    )
  );
}

function liveRoutes(): LiveRoute[] {
  const modules = import.meta.glob('../../**/*.controller.ts', { eager: true }) as EagerModules;
  const out: LiveRoute[] = [];
  for (const mod of Object.values(modules)) {
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const ctor = exported as new (...args: unknown[]) => unknown;
      const base = Reflect.getMetadata(PATH_METADATA, ctor);
      if (base === undefined) continue;
      const proto = ctor.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        if (!Reflect.hasMetadata(PATH_METADATA, handler)) continue;
        const sub = Reflect.getMetadata(PATH_METADATA, handler) as string;
        const method = METHOD_NAMES[Reflect.getMetadata(METHOD_METADATA, handler) as number]!;
        const path = `/${[base as string, sub].filter((s) => s !== '').join('/')}`.replace(
          /\/+/g,
          '/',
        );
        const two = Reflect.getMetadata(TWO_PERSON_ACTION, handler);
        out.push({
          key: routeKey(method, path),
          platformGuarded:
            marked(Reflect.getMetadata(GUARDS_METADATA, handler)) ||
            marked(Reflect.getMetadata(GUARDS_METADATA, ctor)),
          permission:
            (Reflect.getMetadata(PLATFORM_PERMISSION_METADATA, handler) as string | undefined) ??
            (Reflect.getMetadata(PLATFORM_PERMISSION_METADATA, ctor) as string | undefined) ??
            null,
          twoPerson: two !== undefined,
          noTenant:
            Reflect.getMetadata(SKIPS_TENANT, handler) === true ||
            Reflect.getMetadata(SKIPS_TENANT, ctor) === true,
          isPublic:
            Reflect.getMetadata(IS_PUBLIC, handler) === true ||
            Reflect.getMetadata(IS_PUBLIC, ctor) === true,
        });
      }
    }
  }
  return out;
}

const LIVE = liveRoutes();
const PLATFORM_ROUTES = LIVE.filter((r) => r.platformGuarded);
const PLATFORM_OPS = OPS.filter(isPlatformOp);
const opByKey = new Map(OPS.map((op) => [routeKey(op.method, op.path), op] as const));
const neverByKey = new Map(NEVER.map((n) => [routeKey(n.method, n.path), n] as const));

describe('F7 — the platform routes kept out of the AI path (census in registry-sync)', () => {
  it('finds the platform routes at all', () => {
    expect(PLATFORM_ROUTES.length).toBeGreaterThan(230);
    expect(PLATFORM_OPS.length).toBe(PLATFORM_ROUTES.length - 2);
  });

  it('keeps exactly two platform routes out, each with its reason; platform_admin is gone', () => {
    const kept = NEVER.filter((n) => n.reason.startsWith('platform_'));
    expect(kept.map((n) => `${n.reason} ${n.method} ${n.path}`).sort()).toEqual([
      'platform_binary_transport GET /v1/platform/organizations/:id/content/files/:fileId/download',
      'platform_step_up POST /v1/platform/step-up',
    ]);
    expect(NEVER.filter((n) => (n.reason as string) === 'platform_admin')).toEqual([]);
  });

  it('gives a platformPermission only to ops on platform-guarded routes', () => {
    const guarded = new Set(PLATFORM_ROUTES.map((r) => r.key));
    expect(PLATFORM_OPS.filter((op) => !guarded.has(routeKey(op.method, op.path)))).toEqual([]);
  });
});

describe('platform op classification (point 5, F5)', () => {
  it('reads are read/read; every change is confirm/manage with a sensitivity, never money or hr', () => {
    const wrong: string[] = [];
    for (const op of PLATFORM_OPS) {
      if (op.capability !== null) wrong.push(`${op.id}: capability`);
      if (op.method === 'GET') {
        if (op.risk !== 'read' || op.scope !== 'read') wrong.push(`${op.id}: read class`);
      } else {
        if (op.risk !== 'confirm' || op.scope !== 'manage') wrong.push(`${op.id}: change class`);
        const s = OP_SENSITIVITY[op.id];
        if (s === undefined || s === 'money' || s === 'hr')
          wrong.push(`${op.id}: sensitivity ${s}`);
      }
      if (op.platformPermission !== null && !PLATFORM_PERMISSIONS.includes(op.platformPermission!))
        wrong.push(`${op.id}: unknown permission`);
    }
    expect(wrong).toEqual([]);
  });

  it('marks exactly the F5 set freshReauth, and every F5 route key is a live platform op', () => {
    for (const key of PLATFORM_FRESH_REAUTH_ROUTES) {
      expect(isPlatformOp(opByKey.get(key as never) ?? ({} as AiActionOp)), key).toBe(true);
    }
    for (const op of PLATFORM_OPS) {
      expect(op.freshReauth === true, op.id).toBe(
        platformNeedsFreshReauth(op.method, op.path, op.platformPermission ?? null),
      );
    }
    expect(PLATFORM_OPS.filter((op) => op.freshReauth).length).toBeGreaterThanOrEqual(
      PLATFORM_FRESH_REAUTH_ROUTES.size,
    );
  });

  it('F5: a freshReauth op asks for the password again on the card, an ordinary one does not', () => {
    const suspend = OPS.find((op) => op.id === 'platform.orgs.suspend')!;
    const announce = OPS.find((op) => op.id === 'platform.announcements.create')!;
    expect(changeGateFor(suspend, { runAtOnce: true, hasUndo: true })).toMatchObject({
      card: true,
      stepUp: true,
      typedAmount: false,
      approvalRule: false,
    });
    expect(changeGateFor(announce, { runAtOnce: true, hasUndo: true })).toMatchObject({
      card: true,
      stepUp: false,
    });
  });

  it('F5: the changes that hand out power ask for the password again', () => {
    for (const id of [
      'platform.orgs.ownership.transfer',
      'platform.orgs.members.role.set',
      'platform.orgs.members.overrides.set',
      'platform.orgs.roles.create',
      'platform.orgs.roles.update',
      'platform.orgs.roles.delete',
      'platform.orgs.roles.clone',
      'platform.team.presets.set',
      'platform.keys.rotate',
    ]) {
      const op = OPS.find((o) => o.id === id);
      expect(op?.freshReauth, id).toBe(true);
      expect(changeGateFor(op!, { runAtOnce: true, hasUndo: true })?.stepUp, id).toBe(true);
    }
    expect(OP_SENSITIVITY['platform.orgs.ownership.transfer']).toBe('destructive');
    // Every change needing a power-granting permission is in the set, by rule.
    const loose = PLATFORM_OPS.filter(
      (op) =>
        op.method !== 'GET' &&
        (op.platformPermission === 'platform.team.manage' ||
          op.platformPermission === 'platform.permissions.edit') &&
        op.freshReauth !== true,
    );
    expect(loose.map((op) => op.id)).toEqual([]);
  });

  it('F9: the two-person set equals the routes with @RequireTwoPersonApproval', () => {
    const live = PLATFORM_ROUTES.filter((r) => r.twoPerson).map((r) => r.key);
    expect(live.sort()).toEqual([...PLATFORM_TWO_PERSON_ROUTES].sort());
  });
});

describe('platform op details', () => {
  it('every platform op has a detail with a strict input binding its path ids', () => {
    const wrong: string[] = [];
    for (const op of PLATFORM_OPS) {
      const detail = allDetailsById.get(op.id);
      if (detail === undefined) {
        wrong.push(`${op.id}: no detail`);
        continue;
      }
      if (!(detail.input instanceof z.ZodObject)) {
        wrong.push(`${op.id}: input is not an object`);
        continue;
      }
      const shape = detail.input.shape as Record<string, unknown>;
      for (const [, name] of op.path.matchAll(/:([A-Za-z0-9_]+)/g)) {
        if (!(name! in shape)) wrong.push(`${op.id}: path param ${name} not in input`);
      }
      if (detail.input.safeParse({ ...exampleOf(op.id), zzUnknown: 1 }).success)
        wrong.push(`${op.id}: not strict`);
      if (detail.examples.length === 0) wrong.push(`${op.id}: no example`);
      for (const example of detail.examples) {
        if (!detail.input.safeParse(example.args).success) wrong.push(`${op.id}: bad example`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('F2/F3: no platform op takes a step-up binding, grant or session id as an argument', () => {
    for (const op of PLATFORM_OPS) {
      const detail = allDetailsById.get(op.id)!;
      for (const key of ['stepUpSessionId', 'sessionBinding', 'platformUntil', 'grantId']) {
        const args = { ...exampleOf(op.id), [key]: 'x' };
        expect(detail.input.safeParse(args).success, `${op.id} ${key}`).toBe(false);
      }
    }
  });
});

function exampleOf(opId: string): Record<string, unknown> {
  return { ...(allDetailsById.get(opId)?.examples[0]?.args ?? {}) };
}

describe('F6 — every platform read is untrusted and taints the turn', () => {
  it('holds for every platform read, by rule', () => {
    const trusted = PLATFORM_OPS.filter((op) => op.risk === 'read' && !isUntrustedOp(op));
    expect(trusted.map((op) => op.id)).toEqual([]);
    expect(isUntrustedOpId('platform.me.get')).toBe(true);
  });

  it('marks platform reads untrusted in the MCP catalogue too', () => {
    const all = new Set<string>(PLATFORM_PERMISSIONS);
    const tools = buildToolCatalog({
      profile: 'full',
      scopes: ['read', 'write', 'manage'],
      capabilities: new Set(),
      platformPermissions: all,
    }).tools.filter((t) => t.opId?.startsWith('platform.') === true);
    expect(tools.length).toBe(PLATFORM_OPS.length);
    for (const t of tools) {
      const op = OPS.find((o) => o.id === t.opId)!;
      if (op.risk === 'read') expect(t.untrusted, t.name).toBe(true);
    }
  });
});

describe('point 6, F2 — the catalogue lists platform ops only with platform rights', () => {
  const full = { profile: 'full' as const, scopes: ['read', 'write', 'manage'] as const };

  it('a non-admin (or a PAT: no platform rights at all) sees no platform op', () => {
    const tools = buildToolCatalog({ ...full, capabilities: new Set() }).tools;
    expect(tools.filter((t) => t.opId?.startsWith('platform.'))).toEqual([]);
  });

  it('an admin sees exactly the ops their permissions allow, plus `me`', () => {
    const tools = buildToolCatalog({
      ...full,
      capabilities: new Set(),
      platformPermissions: new Set(['platform.orgs.view']),
    }).tools.filter((t) => t.opId?.startsWith('platform.'));
    const ids = new Set(tools.map((t) => t.opId));
    expect(ids.has('platform.me.get')).toBe(true);
    expect(ids.has('platform.orgs.get')).toBe(true);
    expect(ids.has('platform.orgs.suspend')).toBe(false);
    for (const t of tools) {
      const op = OPS.find((o) => o.id === t.opId)!;
      expect([null, 'platform.orgs.view'], op.id).toContain(op.platformPermission);
    }
  });

  it('a read-only grant reaches platform reads only', () => {
    const tools = buildToolCatalog({
      profile: 'full',
      scopes: ['read'],
      capabilities: new Set(),
      platformPermissions: new Set(PLATFORM_PERMISSIONS),
    }).tools.filter((t) => t.opId?.startsWith('platform.'));
    expect(tools.every((t) => t.annotations.readOnlyHint === true)).toBe(true);
  });

  it('a PAT (no platform rights) cannot run, describe or find a platform op; nothing is sent', async () => {
    let sent = 0;
    const { runtime, catalog } = liveMcpSurface({
      profile: 'compact',
      scopes: 'tmanage:read',
      capabilities: new Set(['work.read']),
      orgSlug: 'acme',
      baseUrl: 'http://in-process',
      fetch: (async () => {
        sent += 1;
        return new Response('{}');
      }) as typeof fetch,
    });
    const tool = (name: string) => catalog.tools.find((t) => t.name === name)!;
    const run = await runtime.runTool(tool('tmanage_run_action'), {
      action_id: 'platform.orgs.suspend',
      args: exampleOf('platform.orgs.suspend'),
    });
    expect(run.isError).toBe(true);
    expect(String(run.data)).toContain('Not permitted: platform.orgs.suspend');
    const described = await runtime.runTool(tool('tmanage_describe_action'), {
      action_id: 'platform.orgs.get',
    });
    expect(described.isError).toBe(true);
    const found = await runtime.runTool(tool('tmanage_find_actions'), {
      query: 'suspend company organization platform',
    });
    expect(JSON.stringify(found.data)).not.toContain('platform.');
    expect(sent).toBe(0);
    expect(PAT_SCOPES).not.toContain('tmanage:platform');
  });

  it('the public AI OpenAPI document (for REST clients) lists no platform op', () => {
    const doc = buildAiOpenApiDocument() as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths).filter((p) => p.startsWith('/v1/platform'))).toEqual([]);
  });
});

describe('F4 — census: routes a bound token reaches outside a tenant', () => {
  it('equals the allowlist plus the platform ops, nothing else', () => {
    const noTenant = LIVE.filter((r) => r.noTenant && !r.isPublic);
    const reachable = noTenant
      .filter((r) => {
        const trimmed = r.key.replace(/\/+$/u, '');
        return BOUND_TOKEN_NO_TENANT_ALLOWLIST.has(trimmed) || r.platformGuarded;
      })
      .map((r) => r.key);
    const expected = [
      ...LIVE.filter(
        (r) => r.noTenant && BOUND_TOKEN_NO_TENANT_ALLOWLIST.has(r.key.replace(/\/+$/u, '')),
      ).map((r) => r.key),
      ...PLATFORM_ROUTES.filter((r) => opByKey.has(r.key as never)).map((r) => r.key),
      ...PLATFORM_ROUTES.filter((r) => neverByKey.has(r.key as never)).map((r) => r.key),
    ];
    expect(new Set(reachable)).toEqual(new Set(expected));
    // Every platform route is tenant-less, so the platform guard (rules 1–5) is the gate.
    expect(PLATFORM_ROUTES.every((r) => r.noTenant)).toBe(true);
  });
});

describe('F9 — the card of a platform change', () => {
  it('shows the permission, the reason drafted by the AI and the second-admin rule', () => {
    const frozen = freezeConfirmAction('platform.orgs.suspend', exampleOf('platform.orgs.suspend'));
    const summary = buildApprovalSummary(frozen.op, frozen.detail, frozen.args);
    expect(summary.platform).toEqual({
      permission: 'platform.orgs.lifecycle',
      secondAdminWhenPolicyOn: true,
      reason: frozen.args['reason'],
      reasonDraftedByAi: true,
    });
  });

  it('names the target company or person through the platform read, by the server', () => {
    const suspend = OPS.find((op) => op.id === 'platform.orgs.suspend')!;
    expect(platformTargetLookup(suspend, { organizationId: 'o-1', reason: 'r' })).toMatchObject({
      op: { id: 'platform.orgs.get' },
      args: { organizationId: 'o-1' },
    });
    const reset = OPS.find((op) => op.id === 'platform.people.password_reset.send')!;
    expect(platformTargetLookup(reset, { userId: 'u-1' })).toMatchObject({
      op: { id: 'platform.people.get' },
      args: { userId: 'u-1' },
    });
  });

  it('a tenant op has no platform block', () => {
    const frozen = freezeConfirmAction('work_items.delete', { workItemId: 'wi-1' });
    expect(buildApprovalSummary(frozen.op, frozen.detail, frozen.args).platform).toBeUndefined();
  });

  it('fits every platform change on one card (no field runs unseen)', () => {
    const wide = PLATFORM_OPS.filter((op) => op.method !== 'GET').flatMap((op) => {
      const count = Object.keys(
        (allDetailsById.get(op.id)!.input as z.ZodObject<z.ZodRawShape>).shape,
      ).length;
      return count > MAX_CARD_FIELDS ? [`${op.id}: ${count}`] : [];
    });
    expect(wide).toEqual([]);
  });

  it('takes one target per card: no platform change input holds a list of target ids', () => {
    const lists: string[] = [];
    for (const op of PLATFORM_OPS.filter((o) => o.method !== 'GET')) {
      const shape = (allDetailsById.get(op.id)!.input as z.ZodObject<z.ZodRawShape>).shape;
      for (const [key, value] of Object.entries(shape)) {
        const inner = value instanceof z.ZodOptional ? value.unwrap() : value;
        if (inner instanceof z.ZodArray && /^(organizationId|userId|membershipId)s?$/u.test(key))
          lists.push(`${op.id}.${key}`);
      }
    }
    expect(lists).toEqual([]);
  });
});

describe('buildOpRequest — platform paths', () => {
  it('builds a platform path without :orgSlug and sends queryArgs in the query', () => {
    const op = OPS.find(
      (o) => o.queryArgs !== undefined && o.method === 'DELETE' && isPlatformOp(o),
    )!;
    const args = { ...exampleOf(op.id), kind: 'soft' };
    const built = buildOpRequest(op, args, 'acme');
    expect(built.url.startsWith('/v1/platform/')).toBe(true);
    expect(built.url).not.toContain('acme');
    expect(built.url).toContain('kind=');
    expect(built.body === undefined || !built.body.includes('"kind"')).toBe(true);
  });
});
