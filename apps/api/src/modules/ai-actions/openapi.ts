/**
 * AI action registry → OpenAPI 3.1 generator — slice S13 of the TManage AI connector (MCP).
 *
 * See `MCP-CONNECTOR-PLAN-2026-10-20.md` §5 (the "GPT Actions / plain function calling" row and the
 * S13 slice: "`/openapi/ai.json` is generated from the registry and covers only the safe and confirm
 * ops; confirm ops return the approval link") and `MCP-CONNECTOR-ARCHITECTURE-2026-10-20.md` B3/B4.
 *
 * This is the *fallback* surface for clients that cannot speak MCP but can call an OpenAPI tool
 * (ChatGPT GPT Actions, plain function-calling). It is derived from exactly the same registry the
 * MCP tool catalog (S5) is built from — the classified ops in `registry/index.ts` joined to their
 * per-op detail (zod input schema, title, description) in the wave files — so the two surfaces can
 * never drift. Only ops that carry a detail are AI-callable, so only those are emitted, mirroring
 * `buildToolCatalog`.
 *
 * Security carries over unchanged (it must, because an OpenAPI call lands on the same REST routes
 * through the same guard chain):
 *  - `NEVER` routes are never ops, so they can never appear here (auth, sessions, PATs, OAuth,
 *    platform admin, security settings, secrets — architecture B3).
 *  - every path keeps its `{orgSlug}` segment, but `orgSlug` is taken from the grant/token, not the
 *    argument (B3/T-TEN-01); it is documented as a path parameter because the URL has it.
 *  - confirm-class ops do **not** run on call; they return an approval link the person opens in
 *    TManage (plan §4.3). That is documented as the `202` response, not hidden.
 *  - the only security scheme is the personal access token as `Authorization: Bearer` — the same
 *    token the hosted `/mcp` endpoint accepts. No OAuth flow is advertised here.
 *
 * The generator is pure and dependency-free: the zod → JSON Schema conversion covers exactly the
 * small vocabulary the registry's field builders (`registry/detail.ts` `f.*`, `listArgs`,
 * `bodyArgs`, `pathOnly`, `noArgs`) produce, and falls back to a permissive `{}` for anything it
 * does not recognise, so the emitted document is always structurally valid OpenAPI 3.1.
 */
import { z } from 'zod';
import type { AiActionOp } from './registry/index.js';
import { OPS } from './registry/index.js';
import type { AiActionDetail } from './registry/detail.js';
import { waveADetails } from './registry/wave-a.js';
import { waveBDetails } from './registry/wave-b.js';
import { waveCDetails } from './registry/wave-c.js';

/** The OpenAPI version string the document declares. */
export const OPENAPI_VERSION = '3.1.1';

/** The name of the single security scheme (a TManage personal access token as a Bearer token). */
export const PAT_SECURITY_SCHEME = 'personalAccessToken';

/** Every op detail across the three registry waves, indexed by op id (same join as S5's catalog). */
const detailsById: ReadonlyMap<string, AiActionDetail> = new Map(
  [...waveADetails, ...waveBDetails, ...waveCDetails].map((d) => [d.id, d] as const),
);

/** A minimal JSON Schema node — only the keywords this generator emits. */
export interface JsonSchemaNode {
  type?: string;
  description?: string;
  enum?: readonly unknown[];
  const?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaNode;
}

interface ZodDef {
  readonly checks?: ReadonlyArray<{ kind: string; value?: unknown }>;
  readonly description?: string;
  readonly innerType?: z.ZodTypeAny;
  readonly type?: z.ZodTypeAny;
  readonly valueType?: z.ZodTypeAny;
  readonly values?: readonly unknown[];
  readonly value?: unknown;
  readonly unknownKeys?: string;
  readonly minLength?: { value: number } | null;
  readonly maxLength?: { value: number } | null;
}

function defOf(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function withDescription(node: JsonSchemaNode, schema: z.ZodTypeAny): JsonSchemaNode {
  const description = defOf(schema).description;
  return description === undefined ? node : { ...node, description };
}

/**
 * Convert one zod schema to a JSON Schema node, over the vocabulary the registry uses. Anything
 * unrecognised yields a permissive `{}` so the output stays valid — never a throw.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchemaNode {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    const inner = defOf(schema).innerType;
    return inner === undefined ? {} : zodToJsonSchema(inner);
  }
  if (schema instanceof z.ZodDefault) {
    const inner = defOf(schema).innerType;
    return inner === undefined ? {} : zodToJsonSchema(inner);
  }
  if (schema instanceof z.ZodString) {
    const node: JsonSchemaNode = { type: 'string' };
    for (const check of defOf(schema).checks ?? []) {
      if (check.kind === 'min' && typeof check.value === 'number') node.minLength = check.value;
      if (check.kind === 'max' && typeof check.value === 'number') node.maxLength = check.value;
    }
    return withDescription(node, schema);
  }
  if (schema instanceof z.ZodNumber) {
    let type = 'number';
    const node: JsonSchemaNode = { type };
    for (const check of defOf(schema).checks ?? []) {
      if (check.kind === 'int') type = 'integer';
      if (check.kind === 'min' && typeof check.value === 'number') node.minimum = check.value;
      if (check.kind === 'max' && typeof check.value === 'number') node.maximum = check.value;
    }
    node.type = type;
    return withDescription(node, schema);
  }
  if (schema instanceof z.ZodBoolean) {
    return withDescription({ type: 'boolean' }, schema);
  }
  if (schema instanceof z.ZodArray) {
    const def = defOf(schema);
    const node: JsonSchemaNode = {
      type: 'array',
      items: def.type === undefined ? {} : zodToJsonSchema(def.type),
    };
    if (def.minLength != null) node.minItems = def.minLength.value;
    if (def.maxLength != null) node.maxItems = def.maxLength.value;
    return withDescription(node, schema);
  }
  if (schema instanceof z.ZodEnum) {
    const values = defOf(schema).values ?? [];
    return withDescription({ type: 'string', enum: [...values] }, schema);
  }
  if (schema instanceof z.ZodLiteral) {
    return withDescription({ const: defOf(schema).value }, schema);
  }
  if (schema instanceof z.ZodRecord) {
    const value = defOf(schema).valueType;
    return withDescription(
      { type: 'object', additionalProperties: value === undefined ? true : zodToJsonSchema(value) },
      schema,
    );
  }
  if (schema instanceof z.ZodObject) {
    return objectToJsonSchema(schema);
  }
  // ZodUnknown, ZodAny, and anything else: an unconstrained value.
  return {};
}

/** Whether a property is optional (so it is not in `required`). */
function isOptional(schema: z.ZodTypeAny): boolean {
  return schema instanceof z.ZodOptional || schema instanceof z.ZodDefault;
}

function objectToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): JsonSchemaNode {
  const shape = schema.shape as z.ZodRawShape;
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = zodToJsonSchema(value);
    if (!isOptional(value)) required.push(key);
  }
  const node: JsonSchemaNode = {
    type: 'object',
    properties,
    additionalProperties: defOf(schema).unknownKeys === 'strict' ? false : true,
  };
  if (required.length > 0) node.required = required;
  return withDescription(node, schema);
}

/** The `:name` segments of a Nest route path, in order (e.g. `orgSlug`, `workItemId`). */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
}

/** Nest's `/a/:b/c` → OpenAPI's `/a/{b}/c`. */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** The area tag for an op id (the segment before the first dot). */
function areaOf(opId: string): string {
  const dot = opId.indexOf('.');
  return dot === -1 ? opId : opId.slice(0, dot);
}

/** Pull the top-level object shape from a detail's input, if it is a (possibly strict) object. */
function inputShape(detail: AiActionDetail): z.ZodRawShape {
  return detail.input instanceof z.ZodObject ? (detail.input.shape as z.ZodRawShape) : {};
}

interface OpenApiParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  description?: string;
  schema: JsonSchemaNode;
}

/** The plain-English note appended to a confirm-class op's description. */
const CONFIRM_NOTE =
  ' This action needs a person to approve it in TManage before it runs: the call does not perform ' +
  'it, it returns an approval link (see the 202 response). Open the link, signed in as yourself, ' +
  'and approve it there.';

function buildOperation(op: AiActionOp, detail: AiActionDetail): Record<string, unknown> {
  const params = pathParamNames(op.path);
  const shape = inputShape(detail);
  const isGet = op.method === 'GET';

  const parameters: OpenApiParameter[] = [];
  // Every `:segment` in the URL is a path parameter. `orgSlug` has no input field (it comes from
  // the grant), so it defaults to a string; other params use their input field's schema.
  for (const name of params) {
    const field = shape[name];
    parameters.push({
      name,
      in: 'path',
      required: true,
      schema: field === undefined ? { type: 'string' } : zodToJsonSchema(field),
      ...(name === 'orgSlug'
        ? { description: 'Your workspace slug. Taken from your token/grant; sent in the URL only.' }
        : {}),
    });
  }

  // Non-path input fields: query parameters for a GET, a request body for anything else.
  const bodyProps: Record<string, JsonSchemaNode> = {};
  const bodyRequired: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    if (params.includes(key)) continue;
    if (isGet) {
      parameters.push({
        name: key,
        in: 'query',
        required: !isOptional(value),
        schema: zodToJsonSchema(value),
      });
    } else {
      bodyProps[key] = zodToJsonSchema(value);
      if (!isOptional(value)) bodyRequired.push(key);
    }
  }

  const responses: Record<string, unknown> = {
    '200': { description: 'Success.' },
    '401': { $ref: '#/components/responses/Unauthenticated' },
    '403': { $ref: '#/components/responses/Forbidden' },
  };
  if (op.risk === 'confirm') {
    responses['202'] = { $ref: '#/components/responses/ApprovalRequired' };
  }

  const operation: Record<string, unknown> = {
    operationId: op.id,
    summary: detail.title,
    description:
      op.risk === 'confirm' ? `${detail.description}${CONFIRM_NOTE}` : detail.description,
    tags: [areaOf(op.id)],
    'x-tmanage-risk': op.risk,
    'x-tmanage-scope': op.scope,
    security: [{ [PAT_SECURITY_SCHEME]: [] }],
    responses,
  };
  if (parameters.length > 0) operation['parameters'] = parameters;
  if (!isGet && Object.keys(bodyProps).length > 0) {
    const bodySchema: JsonSchemaNode = {
      type: 'object',
      properties: bodyProps,
      additionalProperties: false,
    };
    if (bodyRequired.length > 0) bodySchema.required = bodyRequired;
    operation['requestBody'] = {
      required: bodyRequired.length > 0,
      content: { 'application/json': { schema: bodySchema } },
    };
  }
  return operation;
}

/** Options for {@link buildAiOpenApiDocument}. */
export interface OpenApiOptions {
  /** The API's public base URL, used as the single `servers` entry (e.g. `https://host/api`). */
  readonly baseUrl?: string;
  /** The `info.version` string (defaults to `1`). */
  readonly version?: string;
}

/** The emitted OpenAPI document (a plain JSON-serialisable object). */
export type OpenApiDocument = Record<string, unknown>;

/**
 * Build the OpenAPI 3.1 document for the AI connector's HTTP fallback surface. Every op that has a
 * registry detail is emitted (reads and writes as ordinary operations, confirm-class ops with the
 * documented `202` approval-link response). The document is deterministic: paths and the methods
 * within each path are sorted, so the same registry always yields byte-identical output.
 */
export function buildAiOpenApiDocument(options: OpenApiOptions = {}): OpenApiDocument {
  const baseUrl = (options.baseUrl ?? 'http://localhost').replace(/\/+$/, '');
  const version = options.version ?? '1';

  // Group ops (that have a detail) by their OpenAPI path, then by lower-case method.
  const byPath = new Map<string, Record<string, Record<string, unknown>>>();
  const tags = new Set<string>();
  for (const op of OPS) {
    const detail = detailsById.get(op.id);
    if (detail === undefined) continue; // not AI-callable yet (no schema) — mirror the MCP catalog.
    const openApiPath = toOpenApiPath(op.path);
    const methods = byPath.get(openApiPath) ?? {};
    methods[op.method.toLowerCase()] = buildOperation(op, detail);
    byPath.set(openApiPath, methods);
    tags.add(areaOf(op.id));
  }

  const paths: Record<string, unknown> = {};
  for (const key of [...byPath.keys()].sort()) {
    const methods = byPath.get(key) as Record<string, Record<string, unknown>>;
    const ordered: Record<string, unknown> = {};
    for (const method of Object.keys(methods).sort()) ordered[method] = methods[method];
    paths[key] = ordered;
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'TManage AI actions',
      version,
      description:
        'The actions an AI assistant may take in a TManage workspace, generated from the TManage ' +
        'action registry. Authenticate with a TManage personal access token as an HTTP Bearer ' +
        'token. Reads and everyday writes run immediately within your own permissions; ' +
        'confirm-class actions (deletes, sends, invites, billing and anything a client can see) ' +
        'return an approval link you open in TManage instead of running. This surface never ' +
        'exposes sign-in, tokens, security settings or platform administration.',
    },
    servers: [{ url: baseUrl }],
    security: [{ [PAT_SECURITY_SCHEME]: [] }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        [PAT_SECURITY_SCHEME]: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'TManage personal access token',
          description:
            'A personal access token created in TManage → Preferences → Security. Sent as ' +
            '`Authorization: Bearer <token>`. The token is bound to one workspace and acts as you.',
        },
      },
      responses: {
        Unauthenticated: { description: 'Missing, unknown, revoked or expired token.' },
        Forbidden: {
          description:
            'The token may not do this: a scope or capability is missing, or the workspace has ' +
            'AI access turned off.',
        },
        ApprovalRequired: {
          description:
            'A confirm-class action was requested but has not run. Open `approval_url` in ' +
            'TManage, signed in as yourself, to approve and run it.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['approval_required'] },
                  approval_id: { type: 'string' },
                  approval_url: {
                    type: 'string',
                    description:
                      'The link to approve this action in TManage, e.g. ' +
                      '`https://<host>/<workspace>/ai/approve/<approval_id>`.',
                  },
                  expires_at: {
                    type: 'string',
                    description: 'When the pending approval expires (ISO-8601).',
                  },
                },
                required: ['status', 'approval_id', 'approval_url'],
                additionalProperties: false,
              },
            },
          },
        },
      },
    },
  };
}
