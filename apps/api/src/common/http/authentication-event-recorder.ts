import { serializeForLog } from '../observability/logger.js';
import { AUDIT_LOSS, type AuditLossCounter } from '../observability/audit-loss.js';
import type { TenantDatabase } from '../database/tenant-context.js';
import type { CredentialsRepository } from '../../modules/identity/credentials.repository.js';

/**
 * The seam the HTTP guards write a refused attempt through — the guard half of ID-002's
 * `authentication_events`, and the answer to status defect 4.
 *
 * `04-SECURITY-PRIVACY` §4/§6 and `25 §12` ask for denied sensitive attempts to be recorded as
 * security events. Two of those denials happen in the HTTP guards, before any organization is
 * resolved: a request with no valid session (`SessionAuthGuard`) and a cookie-authenticated
 * mutation with a bad or absent CSRF token (`CsrfGuard`). Both refused without writing anywhere.
 *
 * ## Why a port, and not the identity service or the repository directly
 *
 * A guard is HTTP layer. `AuthenticationService` is the identity domain and carries the whole
 * sign-in state machine; making a guard depend on it would drag that surface into the request
 * pipeline for one append. The repository is the right *writer*, but it takes a query runner and
 * knows nothing about opening one. This port is the thin thing in between: the guard depends on a
 * one-method seam, and the deployment binds {@link DatabaseAuthenticationEventRecorder}, which
 * reuses the already-DB-proven {@link CredentialsRepository.recordAuthenticationEvent}. The
 * write path is not rewritten — it is reached through the same recorder the sign-in path uses.
 *
 * ## Best-effort, and off the refusal's critical path
 *
 * The refusal is the control. Recording it must never change it: not its status, not its body,
 * and not — by making the caller wait on a database insert — its timing class. So the contract of
 * {@link recordGuardRefusal} is that it returns immediately and never throws or rejects into the
 * caller. {@link DatabaseAuthenticationEventRecorder} launches the write and returns; a failed
 * write is reported on stderr in the idiom `AuthenticationService.recordRefusal` uses, and the
 * guard has already returned the original 401/403. What is lost on a database outage is one audit
 * row, named rather than silent — never the refusal.
 */

/**
 * The `authentication_events.action` tokens the guards write. New members of the closed
 * vocabulary `authentication_events.action` carries (enforced in TypeScript; the column is a
 * plain `VARCHAR(64)`), kept beside the reasons so the pair reads as one.
 */
export const GUARD_REFUSAL_ACTIONS = {
  /** A request refused for want of a valid session — `SessionAuthGuard`, spec §3 step 1. */
  session: 'session_guard',
  /** A cookie-authenticated mutation refused by the CSRF check — `CsrfGuard`, 04 §3. */
  csrf: 'csrf_guard',
  /** SEC-ALERTS item 7. A sign-in door refused from a VPN, proxy, Tor or data-centre address. */
  network: 'network_guard',
} as const;

/**
 * The safe, fixed `authentication_events.reason` tokens the guards write. Like every other
 * reason (`bad_password`, `no_such_user`, …) these are a closed enum-style vocabulary and carry
 * no request content: no header, no body, no slug, no user identifier.
 */
export const GUARD_REFUSAL_REASONS = {
  /** No session, or one whose token was absent, forged, revoked or expired. */
  missingSession: 'missing_session',
  /** The `X-CSRF-Token` header was absent or did not match the session-bound token. */
  csrfFailed: 'csrf_failed',
} as const;

/**
 * One refused attempt, as a guard sees it. Only the fixed vocabulary and the request's own
 * correlation id and transport metadata — never a user identifier (a guard refusal is not a
 * credential the account holder presented, so it is deliberately not attributed to a user id and
 * cannot feed `countRecentFailures`), never tenant data (none is resolved yet).
 */
export interface GuardRefusal {
  /** One of {@link GUARD_REFUSAL_ACTIONS}. */
  readonly action: string;
  /** One of {@link GUARD_REFUSAL_REASONS}. */
  readonly reason: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly correlationId: string;
  /**
   * SEC-ALERTS item 7. The network door's layer scores (fixed `net.*` tokens and a 0–100
   * score, never request content), stored in the existing automation columns (0280).
   */
  readonly automationScore?: number;
  readonly automationReasons?: readonly string[];
}

/**
 * The seam a guard depends on. One method, best-effort by contract: it returns immediately and
 * must never throw or reject, so a guard can call it and then throw its refusal without a
 * `try`/`catch` deciding whether the caller is refused.
 */
export interface AuthenticationEventRecorder {
  recordGuardRefusal(refusal: GuardRefusal): void;
}

/** The only global table this recorder reaches. */
const GUARD_EVENT_TABLES = ['authentication_events'] as const;

/**
 * The deployment's recorder: an append to `authentication_events` through the sign-in path's own
 * {@link CredentialsRepository.recordAuthenticationEvent}, in a transaction of its own (a refused
 * attempt has no other unit of work to join — the reasoning is `CredentialsRepository.record`'s).
 */
export class DatabaseAuthenticationEventRecorder implements AuthenticationEventRecorder {
  /** How many guard rows this process has failed to write — see `recordRefusal`'s note on N-5. */
  private lostRows = 0;

  constructor(
    private readonly database: TenantDatabase,
    private readonly credentials: CredentialsRepository,
    private readonly loss: AuditLossCounter = AUDIT_LOSS,
  ) {}

  recordGuardRefusal(refusal: GuardRefusal): void {
    // Launched, not awaited: the refusal has already been decided and must not wait on an
    // insert. The promise carries its own `catch`, so a database outage is a logged lost row
    // rather than an unhandled rejection, and never reaches the request path.
    void this.write(refusal).catch((error: unknown) => {
      this.lostRows += 1;
      this.loss.record('auth_guard_refusal');
      console.error(
        `[identity] recording a refused ${refusal.action} (${refusal.reason}) guard event failed; ` +
          `the refusal still stands (loss ${String(this.lostRows)} in this process, correlation ${refusal.correlationId})`,
        // A database error can carry the DSN, so it is redacted through the OBS-001 seam.
        serializeForLog(error),
      );
    });
  }

  private async write(refusal: GuardRefusal): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: refusal.correlationId, tables: [...GUARD_EVENT_TABLES] },
      (tx) =>
        this.credentials.recordAuthenticationEvent(tx, {
          // Deliberately not attributed to a user: a guard refusal presented no credential, so
          // attributing it would let it feed the per-user lockout counter (`D08`), and the
          // account holder is not the one this row is evidence about.
          userId: null,
          action: refusal.action,
          outcome: 'failed',
          reason: refusal.reason,
          ip: refusal.ip ?? null,
          userAgent: refusal.userAgent ?? null,
          correlationId: refusal.correlationId,
          automationScore: refusal.automationScore ?? null,
          automationReasons: refusal.automationReasons ?? null,
        }),
    );
  }
}
