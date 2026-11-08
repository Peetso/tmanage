/**
 * 54-04 — the API reference of the public developer portal, derived from the product contract.
 *
 * `openapi-snapshot.json` is the committed `docs/planning/contracts/openapi.yaml`, parsed by
 * `scripts/sync-openapi-snapshot.mjs`. {@link buildApiReference} turns it into what the page shows:
 * operations grouped by tag (in the contract's tag order), each with its method, path, parameters,
 * request body and responses, and the schemas those name. It is pure and runs at build time.
 */

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ApiParam {
  readonly name: string;
  readonly in: string;
  readonly required: boolean;
  readonly type: string;
}

export interface ApiResponse {
  readonly status: string;
  readonly description: string;
  readonly schema: string | null;
}

export interface ApiOperation {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly tag: string;
  readonly params: readonly ApiParam[];
  readonly requestSchema: string | null;
  readonly responses: readonly ApiResponse[];
}

export interface ApiSchemaField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

export interface ApiSchema {
  readonly name: string;
  readonly fields: readonly ApiSchemaField[];
}

export interface ApiTagGroup {
  readonly tag: string;
  readonly operations: readonly ApiOperation[];
}

export interface ApiReference {
  readonly title: string;
  readonly version: string;
  readonly groups: readonly ApiTagGroup[];
  readonly schemas: readonly ApiSchema[];
  readonly operationCount: number;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** `#/components/schemas/Project` → `Project`; anything else → null. */
function refName(value: unknown): string | null {
  const ref = obj(value)['$ref'];
  return typeof ref === 'string' ? (ref.split('/').pop() ?? null) : null;
}

/** Follow a local `$ref` (`#/components/...`) once; a non-ref value is returned as is. */
function resolve(spec: Json, value: unknown): Json {
  const ref = obj(value)['$ref'];
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return obj(value);
  let node: unknown = spec;
  for (const part of ref.slice(2).split('/')) node = obj(node)[part];
  return obj(node);
}

/** A short, readable type for a schema: `string (uuid)`, `Project[]`, `Project`, `object`. */
export function typeLabel(schema: unknown): string {
  const s = obj(schema);
  const named = refName(s);
  if (named !== null) return named;
  const type = s['type'];
  if (type === 'array') return `${typeLabel(s['items'])}[]`;
  if (Array.isArray(s['enum'])) return (s['enum'] as unknown[]).map(String).join(' | ');
  if (Array.isArray(type)) return type.map(String).join(' | ');
  const base = str(type, s['oneOf'] || s['anyOf'] ? 'one of' : 'object');
  return typeof s['format'] === 'string' ? `${base} (${s['format']})` : base;
}

function jsonSchemaOf(content: unknown): unknown {
  return obj(obj(obj(content)['application/json'])['schema']);
}

function schemaLabel(content: unknown): string | null {
  const schema = jsonSchemaOf(content);
  return Object.keys(obj(schema)).length === 0 ? null : typeLabel(schema);
}

/** Build the reference from a parsed OpenAPI 3.x document. */
export function buildApiReference(input: unknown): ApiReference {
  const spec = obj(input);
  const info = obj(spec['info']);
  const tagOrder = (Array.isArray(spec['tags']) ? spec['tags'] : []).map((t) =>
    str(obj(t)['name']),
  );
  const byTag = new Map<string, ApiOperation[]>();

  for (const [path, rawItem] of Object.entries(obj(spec['paths']))) {
    const item = obj(rawItem);
    const shared = Array.isArray(item['parameters']) ? item['parameters'] : [];
    for (const method of HTTP_METHODS) {
      if (!(method in item)) continue;
      const op = obj(item[method]);
      const tags = Array.isArray(op['tags']) ? op['tags'].map((t) => str(t)) : [];
      const tag = tags[0] || 'Other';
      const own = Array.isArray(op['parameters']) ? op['parameters'] : [];
      const params = [...shared, ...own].map((p): ApiParam => {
        const r = resolve(spec, p);
        return {
          name: str(r['name']),
          in: str(r['in']),
          required: r['required'] === true,
          type: typeLabel(r['schema']),
        };
      });
      const responses = Object.entries(obj(op['responses'])).map(([status, raw]): ApiResponse => {
        const r = resolve(spec, raw);
        return { status, description: str(r['description']), schema: schemaLabel(r['content']) };
      });
      const operation: ApiOperation = {
        id: str(op['operationId'], `${method} ${path}`),
        method,
        path,
        tag,
        params,
        requestSchema: schemaLabel(obj(resolve(spec, op['requestBody']))['content']),
        responses,
      };
      byTag.set(tag, [...(byTag.get(tag) ?? []), operation]);
    }
  }

  const tags = [
    ...tagOrder.filter((t) => byTag.has(t)),
    ...[...byTag.keys()].filter((t) => !tagOrder.includes(t)),
  ];
  const groups = tags.map((tag) => ({ tag, operations: byTag.get(tag)! }));

  const schemas = Object.entries(obj(obj(spec['components'])['schemas'])).map(
    ([name, raw]): ApiSchema => {
      const s = obj(raw);
      const required = new Set(Array.isArray(s['required']) ? s['required'].map(String) : []);
      const fields = Object.entries(obj(s['properties'])).map(([field, fs]) => ({
        name: field,
        type: typeLabel(fs),
        required: required.has(field),
      }));
      return { name, fields };
    },
  );

  return {
    title: str(info['title'], 'API'),
    version: str(info['version']),
    groups,
    schemas,
    operationCount: groups.reduce((n, g) => n + g.operations.length, 0),
  };
}

/** True when an operation matches the search text (method, path, id or tag; case-insensitive). */
export function matchesQuery(op: ApiOperation, query: string): boolean {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length === 0) return true;
  const text = `${op.method} ${op.path} ${op.id} ${op.tag}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** The groups narrowed to matching operations; empty groups are dropped. */
export function filterGroups(groups: readonly ApiTagGroup[], query: string): ApiTagGroup[] {
  return groups
    .map((g) => ({ tag: g.tag, operations: g.operations.filter((op) => matchesQuery(op, query)) }))
    .filter((g) => g.operations.length > 0);
}
