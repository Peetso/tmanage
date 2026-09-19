import { redactFields } from './redact.js';

/**
 * OBS-001. The one serializer structured log lines go through.
 *
 * There is no central logger in this process yet — structured events are written with
 * `console.*` at the site that produces them — so this is the seam that guarantees redaction
 * happens before any object reaches a log sink. Call sites serialize their payload with this
 * rather than `JSON.stringify` directly (see `app-composition.ts`'s tenant-guard event and its
 * sibling database-connection error), and the day a real logger is introduced this is the
 * function its serializer hook installs.
 *
 * Errors are the payload most call sites hand it — a caught connection or transport error — and a
 * raw `Error` serializes to `{}`: its `message`, `stack` and `cause` are non-enumerable, so a plain
 * `JSON.stringify` (and `redactFields`, which walks own enumerable keys) drops the whole diagnostic,
 * while any credential the error carries on `cause` or an own property slips through unwalked. So an
 * `Error` is first lifted into a plain, walkable record — `name`/`message`/`stack`, its enumerable
 * own properties, and its `cause` chain — and only then redacted. The message text is developer
 * authored and preserved verbatim; a secret must be carried as a *field* (which is how a driver
 * error carries its connection config) for the field-level redactor to remove it.
 */
export function serializeForLog(payload: unknown): string {
  return JSON.stringify(redactFields(normalizeErrors(payload, new WeakSet<object>())));
}

/**
 * CONTRACT-001's exact-view projections fail closed: a row whose persisted `state` is outside
 * the domain union is a corrupt row and becomes a 500 rather than an out-of-contract response.
 * The throw on its own surfaces only through fastify's generic 500 path, leaving the operator
 * nothing to search on, so before it we emit exactly the offending row id and the request
 * correlation id — never the row's contents — through the same field-level redactor
 * (`serializeForLog`) every other OBS-001 line uses. The value that made the row invalid is not
 * logged: the operator locates the row by id and inspects it, and a bad column value never
 * reaches the log sink.
 */
export function logUnrecognisedRowState(
  entity: string,
  rowId: string,
  correlationId: string,
): void {
  console.error(
    '[projection] unrecognised persisted state',
    serializeForLog({ entity, rowId, correlationId }),
  );
}

/**
 * Lift `Error` instances into plain records so {@link redactFields} can see and redact their
 * fields. Only `Error`s are transformed; every other value (including a plain-object `cause`) is
 * returned untouched for `redactFields` to walk with its own depth and cycle bounds, so the
 * already-reviewed behaviour for non-error payloads is unchanged. The `cause` chain and any
 * nested-`Error` own property are transformed recursively, guarded against a cyclic chain.
 */
function normalizeErrors(value: unknown, seen: WeakSet<object>): unknown {
  if (!(value instanceof Error)) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  const source = value as unknown as Record<string, unknown>;
  const normalized: Record<string, unknown> = { name: value.name, message: value.message };
  for (const key of Object.keys(source)) {
    normalized[key] = normalizeErrors(source[key], seen);
  }
  if (value.stack !== undefined) normalized['stack'] = value.stack;
  if (value.cause !== undefined) normalized['cause'] = normalizeErrors(value.cause, seen);
  return normalized;
}
