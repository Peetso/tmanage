import { OPS, findOpByRoute } from './index.js';
import type { AiActionOp } from './index.js';

/**
 * **What an op is about: its subject (AI panel, gap 1; Fable 5.2 ruling 2026-11-23).**
 *
 * The member's "Your AI" activity says "Read Homepage hero copy" or, when the name is not
 * available, "Read a task". For that the audit row of each MCP tool call needs the identifier of
 * the item it touched, and only the identifier: never a value, a name or a result body.
 *
 * Every op declares its subject here, by one rule over its route (AR-8: one decision, one place),
 * so the 900 ops need no hand-written table that could drift:
 *
 * - **An item.** A route with a path parameter is about the item its *last* parameter names. The
 *   kind comes from the literal segment before that parameter: `/work-items/:workItemId/comments/`
 *   is about a `work_item`, `/billing/cost-centers/:id` about a `cost_center`.
 * - **A collection.** A route with no parameter besides `:orgSlug` is about its last segment: a
 *   `GET` is a bulk read (kind and a count, no id); any other method creates one item, whose id
 *   comes from the answer.
 *
 * {@link subjectNameReadOp} is the registry read that names a subject: the `GET` of the item's own
 * path. The activity route runs it as the member, so a name appears only for an item the member
 * can open now.
 */

export interface OpSubject {
  /** The item kind, snake_case and singular (`work_item`, `project`, `cost_center`). */
  readonly kind: string;
  /** The argument holding the item's id; `null` for a collection route. */
  readonly param: string | null;
  /** A collection route: a bulk read (`GET`) or a create (any other method). */
  readonly collection: boolean;
}

const ORG_PREFIX = ['v1', 'organizations', ':orgSlug'] as const;

/** `work-items` → `work_item`, `people` → `person`, `time-off` → `time_off`. */
export function kindOfSegment(segment: string): string {
  const snake = segment
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (snake === 'people') return 'person';
  if (snake.endsWith('ies')) return `${snake.slice(0, -3)}y`;
  if (/(?:ss|sh|ch|x)es$/.test(snake)) return snake.slice(0, -2);
  if (snake.endsWith('s') && !snake.endsWith('ss')) return snake.slice(0, -1);
  return snake;
}

function segmentsOf(path: string): string[] {
  const parts = path.split('/').filter((part) => part !== '');
  const prefixed = ORG_PREFIX.every((part, index) => parts[index] === part);
  return prefixed ? parts.slice(ORG_PREFIX.length) : parts;
}

/** The subject of an op's route, or `null` when the route names no kind at all. */
export function subjectOf(op: Pick<AiActionOp, 'method' | 'path'>): OpSubject | null {
  const segments = segmentsOf(op.path);
  let lastParam = -1;
  segments.forEach((segment, index) => {
    if (segment.startsWith(':')) lastParam = index;
  });
  if (lastParam > 0) {
    const literal = segments[lastParam - 1];
    const param = segments[lastParam];
    if (literal === undefined || literal.startsWith(':') || param === undefined) return null;
    return { kind: kindOfSegment(literal), param: param.slice(1), collection: false };
  }
  if (lastParam === 0) return null;
  const last = segments.at(-1);
  if (last === undefined) return null;
  return { kind: kindOfSegment(last), param: null, collection: true };
}

const LAST_PARAM = /\/:[A-Za-z0-9_]+$/;

/** `GET …/:param` read ops by the path in front of their last parameter, for a create's item. */
const ITEM_READS: ReadonlyMap<string, AiActionOp> = new Map(
  OPS.filter((op) => op.method === 'GET' && op.risk === 'read' && LAST_PARAM.test(op.path))
    .map((op) => [op.path.replace(LAST_PARAM, ''), op] as const)
    .reverse(),
);

/**
 * The registry read that names an op's subject: the `GET` of the item's own path (a read op only;
 * the op itself when it is that read). `undefined` when there is none.
 */
export function subjectNameReadOp(op: Pick<AiActionOp, 'method' | 'path'>): AiActionOp | undefined {
  const subject = subjectOf(op);
  if (subject === null) return undefined;
  if (subject.param !== null) {
    const marker = `/:${subject.param}`;
    const end = op.path.lastIndexOf(marker) + marker.length;
    const read = findOpByRoute('GET', op.path.slice(0, end));
    return read?.risk === 'read' ? read : undefined;
  }
  if (op.method === 'GET') return undefined;
  return ITEM_READS.get(op.path.replace(/\/+$/, ''));
}

/** What a tool call recorded about its subject: identifiers and a count only. */
export interface CallSubject {
  readonly kind: string;
  readonly id: string | null;
  /** How many items a bulk read returned; `null` for one item or when the answer did not say. */
  readonly count: number | null;
  readonly projectId: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function idText(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  return null;
}

/** The new item's id in a create's answer: top level, or under `data` / `item`. */
function createdId(result: unknown): string | null {
  for (const source of [result, isRecord(result) ? result['data'] : undefined]) {
    if (!isRecord(source)) continue;
    const direct = idText(source['id']);
    if (direct !== null) return direct;
    const item = source['item'];
    if (isRecord(item)) {
      const nested = idText(item['id']);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/** How many items a bulk read's answer holds: an array, or `items` / `data` holding one. */
function itemCount(result: unknown): number | null {
  if (Array.isArray(result)) return result.length;
  if (!isRecord(result)) return null;
  for (const key of ['items', 'data']) {
    const value = result[key];
    if (Array.isArray(value)) return value.length;
    if (isRecord(value) && Array.isArray(value['items'])) return value['items'].length;
  }
  return null;
}

/**
 * The subject one call of `op` touched, from its validated arguments and (for a create or a bulk
 * read) its answer. Only identifiers and a count leave this function.
 */
export function callSubject(
  op: Pick<AiActionOp, 'method' | 'path'>,
  args: Readonly<Record<string, unknown>>,
  result: unknown,
): CallSubject | null {
  const subject = subjectOf(op);
  if (subject === null) return null;
  const projectArg = idText(args['projectId']);
  if (subject.param !== null) {
    const id = idText(args[subject.param]);
    return {
      kind: subject.kind,
      id,
      count: null,
      projectId: subject.kind === 'project' ? id : projectArg,
    };
  }
  if (op.method === 'GET') {
    return { kind: subject.kind, id: null, count: itemCount(result), projectId: projectArg };
  }
  const id = createdId(result);
  return {
    kind: subject.kind,
    id,
    count: null,
    projectId: subject.kind === 'project' ? id : projectArg,
  };
}
