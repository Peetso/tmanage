/**
 * Unwrap the ORM's query-error wrapper before an error leaves the database layer.
 *
 * Drizzle wraps anything thrown during execution in a `DrizzleQueryError` whose message is
 * `Failed query: <sql>\nparams: <params>` and whose `cause` is the original. Two separate
 * problems follow, and only one of them is about ergonomics.
 *
 * **1. It hides the errors callers are supposed to react to.** The tenant guard's
 * "no organization_id predicate" refusal is a security control (ADR-0001 layer 3), and a
 * composite-foreign-key violation is layer 1 reporting a cross-tenant write. Both arrive at
 * a caller as a generic "Failed query", indistinguishable from a connection reset. Error
 * handling that cannot tell a tenant-isolation refusal from a transient failure will retry
 * one of them.
 *
 * **2. The wrapper's message contains the bound parameters.** Every other diagnostic in
 * this layer is careful not to: the guard emits a redacted statement *shape* and explicitly
 * asserts it carries no tenant data, precisely so a security event can be logged safely. A
 * wrapper that appends the parameter list to the message defeats that the moment anything
 * logs `error.message` — and logging the error is exactly what a caller does. Project
 * names, email addresses and identifiers would end up in whatever the exception handler
 * writes to.
 *
 * So the wrapper is removed on the way out of the database layer, and the original error —
 * with its `code`, its `errno`, and its own message — is what callers see.
 *
 * Detected structurally rather than with `instanceof`. `DrizzleQueryError` does not set
 * `name`, so it is indistinguishable from a plain `Error` by that route, and importing the
 * class here would make this module depend on the ORM in order to describe a property of
 * the ORM's errors. The three own properties it sets are a precise enough signature.
 */
export function unwrapQueryError(error: unknown): unknown {
  if (
    error instanceof Error &&
    'query' in error &&
    'params' in error &&
    error.cause instanceof Error
  ) {
    return error.cause;
  }
  return error;
}
