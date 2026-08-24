import { isUuid, uuidv7 } from '@tmanage/domain';

/**
 * The correlation identifier carried by every request, log line, guard event and audit row.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §2 lists it as a field of the trusted
 * `TenantContext`, and `13-ENGINEERING-EXECUTION-SPEC` §3 requires it in every error envelope.
 * `createTenantContext()` validates it as a canonical lowercase UUID, so anything produced
 * here must satisfy that or the context cannot be built.
 *
 * ## An inbound value is accepted, and it is trace metadata only
 *
 * A client — or, later, the web app forwarding its own trace id — may supply
 * `X-Correlation-Id`, and honouring it is what makes a single user action traceable across the
 * browser, the API and the worker.
 *
 * It is validated as a UUID before use, and that check is doing real work rather than being
 * tidiness: the value reaches log lines, error envelopes and eventually `audit_events`, so an
 * unvalidated header would be an attacker-controlled string in the audit trail — a log
 * injection, and a way to make one actor's entries collide with another's.
 *
 * What it never is: an authorization input. Nothing anywhere branches on it.
 */
export const CORRELATION_HEADER = 'x-correlation-id';

export function resolveCorrelationId(header: string | string[] | undefined): string {
  // An array means the header arrived more than once. That is ambiguous, and picking one would
  // be a guess, so it is discarded in favour of a fresh id rather than resolved arbitrarily.
  if (typeof header === 'string') {
    const candidate = header.trim().toLowerCase();
    if (isUuid(candidate)) return candidate;
  }
  return uuidv7();
}
