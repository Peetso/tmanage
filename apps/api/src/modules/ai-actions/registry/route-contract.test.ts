import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { z } from 'zod';
import type * as Domain from '@tmanage/domain';
import { OPS, routeKey } from './index.js';
import type { AiActionOp } from './index.js';
import type { AiActionDetail } from './detail.js';
import { allDetailsById } from '../../mcp/tool-catalog.js';
import { ApiError } from '../../../common/http/errors.js';
import { ROUTE_CONTRACT_EXCEPTIONS } from './route-contract-exceptions.js';

// The probe asks whether the ROUTE accepts the arguments, not whether a stub principal may act:
// every authorization decision allows, so a handler that authorizes before it validates is still
// reached (the db half runs the real decision with a real member).
vi.mock('@tmanage/domain', async (importOriginal) => ({
  ...(await importOriginal<typeof Domain>()),
  authorize: () => ({ allowed: true }),
}));

// `import.meta.glob` is typed by a global augmentation (see registry-sync.test.ts); cast its result.
type EagerModules = Record<string, Record<string, unknown>>;

/**
 * Fix lane B, 2026-11-23 (AI-ACTIONS-LIVE-TEST §8 fix 3). Defect class DC-9: **an action's input
 * schema does not match its route.** The live test found 15 reads whose schema let the AI send
 * arguments the route then refused with a bare 400 (a required `from`/`to`/`q`/`projectId` marked
 * optional or missing), a write (`conversations.create`) whose fields the route does not read at
 * all, and lists that accept `limit` and ignore it. Nothing compared the two halves, so they drifted.
 *
 * This is the static half of the contract (the route half, every example through the real app and
 * a real database, is `test/ai-actions-route-contract.db.test.ts`). It needs no database: it reads
 * the same Nest metadata the router reads (`@Get`, `@Query('from')`, `@Body()`), and it **calls the
 * real route handler** on a controller whose injected services are stubs. The controllers validate
 * their query and body before they touch a service, so a handler that throws a 400 before reaching
 * a stub has refused the arguments exactly as the live route would; reaching a stub means the
 * arguments got past the route's own validation. (Validation that lives inside a service is not
 * seen here; the db half covers it.)
 *
 * Checks, per op that has a detail:
 * 1. every `examples` entry parses with the op's own input schema;
 * 2. every example passes the route's validation (no 400);
 * 3. the first example cut down to the schema's **required** fields still passes (a field the
 *    route requires is required in the schema);
 * 4. every value of every enum field in the schema passes the route (the schema's allowlist is not
 *    wider than the controller's);
 * 5. a GET op whose handler reads named query keys only: every argument the schema accepts is a
 *    key the route reads (nothing "accepted and ignored", e.g. `limit` on a route without paging),
 *    and every key the route reads is in the schema (the AI can send everything the route takes).
 *
 * Known, reasoned exceptions live in `route-contract-exceptions.ts`; an exception that no longer
 * matches a finding fails the test too, so the list cannot rot.
 */

const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const ROUTE_ARGS_METADATA = '__routeArguments__';
const METHOD_NAMES = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];
/** `RouteParamtypes` (`@nestjs/common/enums/route-paramtypes.enum`). */
const PARAM_REQUEST = 0;
const PARAM_BODY = 3;
const PARAM_QUERY = 4;
const PARAM_PARAM = 5;
const PARAM_HEADERS = 6;

interface RouteArg {
  readonly index: number;
  readonly type: number | 'custom';
  readonly data: string | undefined;
}

interface LiveHandler {
  readonly ctor: new (...args: unknown[]) => unknown;
  readonly handlerName: string;
  readonly args: readonly RouteArg[];
  readonly source: string;
}

function joinPath(basePath: string, subPath: string): string {
  return `/${[basePath, subPath].filter((s) => s !== undefined && s !== '').join('/')}`.replace(
    /\/+/g,
    '/',
  );
}

function routeArgsOf(ctor: object, handlerName: string): RouteArg[] {
  const meta = (Reflect.getMetadata(ROUTE_ARGS_METADATA, ctor, handlerName) ?? {}) as Record<
    string,
    { index: number; data?: unknown }
  >;
  return Object.entries(meta).map(([key, value]) => {
    const custom = key.includes('__customRouteArgs__');
    const type = custom ? ('custom' as const) : Number(key.split(':')[0]);
    return {
      index: value.index,
      type,
      data: typeof value.data === 'string' ? value.data : undefined,
    };
  });
}

function enumerateHandlers(): Map<string, LiveHandler> {
  const modules = import.meta.glob('../../**/*.controller.ts', { eager: true }) as EagerModules;
  const byKey = new Map<string, LiveHandler>();
  for (const [modulePath, mod] of Object.entries(modules)) {
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const ctor = exported as new (...args: unknown[]) => unknown;
      const basePath = Reflect.getMetadata(PATH_METADATA, ctor);
      if (basePath === undefined) continue;
      const proto = ctor.prototype as Record<string, unknown>;
      for (const handlerName of Object.getOwnPropertyNames(proto)) {
        if (handlerName === 'constructor') continue;
        const handler = proto[handlerName];
        if (typeof handler !== 'function' || !Reflect.hasMetadata(PATH_METADATA, handler)) continue;
        const subPath = Reflect.getMetadata(PATH_METADATA, handler) as string;
        const method = METHOD_NAMES[Reflect.getMetadata(METHOD_METADATA, handler) as number];
        byKey.set(routeKey(method ?? 'GET', joinPath(basePath as string, subPath)), {
          ctor,
          handlerName,
          args: routeArgsOf(ctor, handlerName),
          source: `${modulePath.replace(/^\.\.\/\.\.\//, '')} ${handlerName}`,
        });
      }
    }
  }
  return byKey;
}

// ---------------------------------------------------------------------------------------------
// Calling a handler with stub services.

/** Thrown by any stub the handler calls: the arguments got past the route's own validation. */
class ReachedService extends Error {}

/** A stand-in for every injected service and every request-scoped object (context, principal). */
function deepStub(): unknown {
  const target = function stub(): void {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return undefined; // not a thenable
      if (prop === Symbol.toPrimitive) return () => 'stub';
      if (prop === Symbol.iterator) return function* empty(): Generator<never> {};
      if (prop === 'toJSON') return () => 'stub';
      return deepStub();
    },
    apply() {
      throw new ReachedService();
    },
    construct() {
      throw new ReachedService();
    },
  });
}

function controllerInstance(ctor: new (...args: unknown[]) => unknown): object {
  const base = Object.create(ctor.prototype as object) as object;
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver) as unknown;
      return deepStub();
    },
  });
}

/** What the route does with one set of arguments. */
type ProbeOutcome =
  | { readonly kind: 'passed' }
  | { readonly kind: 'refused'; readonly message: string; readonly fields: readonly string[] }
  | { readonly kind: 'inconclusive'; readonly message: string };

interface SplitArgs {
  readonly params: Record<string, string>;
  readonly query: Record<string, string>;
  readonly body: Record<string, unknown> | undefined;
}

function pathParams(op: AiActionOp): string[] {
  return [...op.path.matchAll(/:([A-Za-z0-9_]+)/g)]
    .map((m) => m[1] ?? '')
    .filter((name) => name !== 'orgSlug');
}

/** The same split `buildOpRequest` (mcp/pending-actions.ts) makes, as the route receives it. */
function splitArgs(op: AiActionOp, args: Readonly<Record<string, unknown>>): SplitArgs {
  const pathNames = new Set(pathParams(op));
  const params: Record<string, string> = { orgSlug: 'northstar' };
  const query: Record<string, string> = {};
  const body: Record<string, unknown> = {};
  const inQuery = new Set(op.queryArgs ?? []);
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (pathNames.has(key)) params[key] = String(value);
    else if (op.method === 'GET' || inQuery.has(key)) query[key] = String(value);
    else body[key] = value;
  }
  return { params, query, body: Object.keys(body).length === 0 ? undefined : body };
}

async function probe(
  op: AiActionOp,
  handler: LiveHandler,
  args: Readonly<Record<string, unknown>>,
): Promise<ProbeOutcome> {
  const { params, query, body } = splitArgs(op, args);
  const request = { params, query, body, headers: {}, method: op.method, url: op.path, raw: {} };
  const callArgs: unknown[] = [];
  for (const arg of handler.args) {
    let value: unknown;
    if (arg.type === PARAM_BODY) value = arg.data === undefined ? body : body?.[arg.data];
    else if (arg.type === PARAM_QUERY) value = arg.data === undefined ? query : query[arg.data];
    else if (arg.type === PARAM_PARAM) value = arg.data === undefined ? params : params[arg.data];
    else if (arg.type === PARAM_HEADERS) value = arg.data === undefined ? {} : undefined;
    else if (arg.type === PARAM_REQUEST) value = request;
    else value = deepStub();
    callArgs[arg.index] = value;
  }
  const instance = controllerInstance(handler.ctor);
  const fn = (handler.ctor.prototype as Record<string, (...a: unknown[]) => unknown>)[
    handler.handlerName
  ];
  try {
    await fn?.apply(instance, callArgs);
    return { kind: 'passed' };
  } catch (error) {
    if (error instanceof ReachedService) return { kind: 'passed' };
    if (error instanceof ApiError) {
      if (error.status === 400 || error.status === 422) {
        return {
          kind: 'refused',
          message: error.message,
          fields: (error.details ?? []).map((d) => d.field),
        };
      }
      return { kind: 'inconclusive', message: `${error.status} ${error.message}` };
    }
    if (error instanceof HttpException && error.getStatus() === 400) {
      return { kind: 'refused', message: error.message, fields: [] };
    }
    return { kind: 'inconclusive', message: String(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the zod input schema.

type AnySchema = z.ZodTypeAny & { def?: Record<string, unknown>; shape?: z.ZodRawShape };

function objectShape(schema: AnySchema): z.ZodRawShape | null {
  let current: AnySchema | undefined = schema;
  for (let i = 0; i < 6 && current !== undefined; i += 1) {
    if (current.shape !== undefined && typeof current.shape === 'object') return current.shape;
    const def: Record<string, unknown> = current.def ?? {};
    current = (def['in'] ?? def['innerType'] ?? def['schema']) as AnySchema | undefined;
  }
  return null;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  return schema.safeParse(undefined).success;
}

/** The allowed values of an enum-like field (`z.enum`, a literal, or a union of literals). */
function enumValues(schema: AnySchema): readonly unknown[] | null {
  let current: AnySchema | undefined = schema;
  for (let i = 0; i < 6 && current !== undefined; i += 1) {
    const def: Record<string, unknown> = current.def ?? {};
    const type = def['type'];
    if (type === 'enum') return Object.values(def['entries'] as Record<string, unknown>);
    if (type === 'literal') return def['values'] as unknown[];
    if (type === 'union') {
      const values: unknown[] = [];
      for (const option of def['options'] as AnySchema[]) {
        const inner = enumValues(option);
        if (inner === null) return null;
        values.push(...inner);
      }
      return values;
    }
    if (type === 'optional' || type === 'nullable' || type === 'default' || type === 'readonly') {
      current = def['innerType'] as AnySchema;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------

const handlers = enumerateHandlers();

type Check = 'example-schema' | 'example-route' | 'required' | 'enum' | 'ignored' | 'unreachable';

interface Finding {
  readonly opId: string;
  readonly check: Check;
  readonly text: string;
}

function exceptionKey(f: Pick<Finding, 'opId' | 'check'>): string {
  return `${f.opId} ${f.check}`;
}

async function enumFindings(
  op: AiActionOp,
  handler: LiveHandler,
  detail: AiActionDetail,
  shape: z.ZodRawShape,
  base: Readonly<Record<string, unknown>>,
): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const [key, field] of Object.entries(shape)) {
    const values = enumValues(field as AnySchema);
    if (values === null) continue;
    for (const value of values) {
      const args = { ...base, [key]: value };
      if (!detail.input.safeParse(args).success) continue;
      const result = await probe(op, handler, args);
      if (result.kind === 'refused') {
        out.push({
          opId: op.id,
          check: 'enum',
          text: `${key}=${JSON.stringify(value)} is in the schema but refused by ${handler.source}: ${result.message}`,
        });
      }
    }
  }
  return out;
}

async function findingsFor(op: AiActionOp, detail: AiActionDetail): Promise<Finding[]> {
  const out: Finding[] = [];
  const handler = handlers.get(routeKey(op.method, op.path));
  if (handler === undefined) return out; // registry-sync.test.ts owns "every op has a route"
  const shape = objectShape(detail.input as AnySchema);
  const paths = pathParams(op);

  // 1 + 2: each example parses with the schema and passes the route.
  for (const example of detail.examples) {
    const parsed = detail.input.safeParse(example.args);
    if (!parsed.success) {
      out.push({
        opId: op.id,
        check: 'example-schema',
        text: `example "${example.summary}" fails the op's own schema: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      });
      continue;
    }
    const outcome = await probe(op, handler, example.args);
    if (outcome.kind === 'refused') {
      out.push({
        opId: op.id,
        check: 'example-route',
        text: `example "${example.summary}" refused by ${handler.source}: ${outcome.message} [${outcome.fields.join(',')}]`,
      });
    }
  }

  // 3: the required fields alone, valued from the first example (path params get a placeholder).
  if (shape !== null) {
    const first = detail.examples[0]?.args ?? {};
    const minimal: Record<string, unknown> = {};
    let complete = true;
    for (const [key, field] of Object.entries(shape)) {
      if (isOptional(field as z.ZodTypeAny)) continue;
      if (first[key] !== undefined) minimal[key] = first[key];
      else if (paths.includes(key)) minimal[key] = 'id_1';
      else complete = false;
    }
    if (complete && detail.input.safeParse(minimal).success) {
      const outcome = await probe(op, handler, minimal);
      if (outcome.kind === 'refused') {
        out.push({
          opId: op.id,
          check: 'required',
          text: `the schema's required fields alone (${Object.keys(minimal).join(',') || 'none'}) are refused by ${handler.source}: ${outcome.message} [${outcome.fields.join(',')}]`,
        });
      } else {
        // 4: every enum value the schema allows, on a call the route otherwise accepts.
        const base = detail.input.safeParse(first).success ? first : minimal;
        if ((await probe(op, handler, base)).kind !== 'refused') {
          out.push(...(await enumFindings(op, handler, detail, shape, base)));
        }
      }
    }
  }

  // 5: a GET handler that reads named query keys only.
  if (op.method === 'GET' && shape !== null) {
    const readsWholeQuery = handler.args.some(
      (a) => (a.type === PARAM_QUERY && a.data === undefined) || a.type === PARAM_REQUEST,
    );
    if (!readsWholeQuery) {
      const routeKeys = new Set(
        handler.args.filter((a) => a.type === PARAM_QUERY).map((a) => a.data ?? ''),
      );
      const schemaKeys = Object.keys(shape).filter((k) => !paths.includes(k));
      const ignored = schemaKeys.filter((k) => !routeKeys.has(k));
      if (ignored.length > 0) {
        out.push({
          opId: op.id,
          check: 'ignored',
          text: `the schema accepts ${ignored.join(',')} but ${handler.source} never reads it`,
        });
      }
      const unreachable = [...routeKeys].filter((k) => !schemaKeys.includes(k));
      if (unreachable.length > 0) {
        out.push({
          opId: op.id,
          check: 'unreachable',
          text: `${handler.source} reads ${unreachable.join(',')} but the schema does not accept it`,
        });
      }
    }
  }
  return out;
}

async function allFindings(): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const op of OPS) {
    const detail = allDetailsById.get(op.id);
    if (detail === undefined) continue;
    findings.push(...(await findingsFor(op, detail)));
  }
  return findings;
}

describe('AI action route contract (DC-9, "an action schema does not match its route")', () => {
  it('every op detail agrees with the route it calls', async () => {
    const excepted = new Set(Object.keys(ROUTE_CONTRACT_EXCEPTIONS));
    const unexplained = (await allFindings())
      .filter((f) => !excepted.has(exceptionKey(f)))
      .map((f) => `${f.opId} [${f.check}] ${f.text}`);
    expect(unexplained).toEqual([]);
  });

  it('every listed exception still matches a finding (the list cannot rot)', async () => {
    const live = new Set((await allFindings()).map(exceptionKey));
    const stale = Object.keys(ROUTE_CONTRACT_EXCEPTIONS).filter((key) => !live.has(key));
    expect(stale).toEqual([]);
  });

  it('every op with a detail is found on a live handler (the probe covers the surface)', () => {
    const missing = OPS.filter(
      (op) => allDetailsById.has(op.id) && !handlers.has(routeKey(op.method, op.path)),
    ).map((op) => op.id);
    expect(missing).toEqual([]);
  });
});
