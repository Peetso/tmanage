/**
 * The error envelope — `13-ENGINEERING-EXECUTION-SPEC` §3:
 *
 *   "Resource-oriented routes under `/v1`; cursor pagination; stable error envelope with code,
 *    message, field details, correlation ID."
 *
 * ## The rule this file exists to hold
 *
 * **A refusal tells the caller what to do next, and nothing about why the server said no.**
 *
 * Two established decisions in this codebase are the reason. `MembershipResolver` returns one
 * message for every resolution failure because an outsider who can distinguish "no such
 * organization" from "you are not in it" can enumerate the customer base one slug at a time,
 * and slugs are company names. `SessionService` does the same for "unknown", "revoked",
 * "expired" and "replayed". Both carry the specific cause on a `code` property for the audit
 * trail.
 *
 * The HTTP layer is where that discipline is either kept or quietly lost, because it is the
 * layer with somewhere to leak to. So: `ApiError.code` here is a **response** code — a small,
 * deliberately coarse vocabulary — and it is never the `DenialCode` from `authorize()` or the
 * `SessionRejection` from the session service. Those stay server-side.
 */

/**
 * The caller-facing vocabulary. Coarse on purpose.
 *
 * Note there is no `forbidden_not_project_member` or `forbidden_audience_internal`: every
 * authorization denial is `forbidden`, because the finer codes describe facts about objects
 * the caller has just been told they cannot see.
 */
export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'csrf_failed'
  | 'reauthentication_required'
  // A11: the company requires two-step sign-in and this person has not enrolled.
  | 'two_step_required'
  | 'not_found'
  | 'conflict'
  | 'validation_failed'
  | 'rate_limited'
  // BILLING_MODE=beta_free: a plan change or purchase while the public beta is free (409).
  | 'billing_disabled_beta'
  // ---- platform-admin v2 · PA-02 ----
  // A platform admin whose preset lacks the route's permission (403; details name the key).
  | 'platform_permission_missing'
  | 'support_session_required'
  | 'internal_error';

export interface ApiErrorDetail {
  readonly field: string;
  readonly message: string;
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly correlationId: string;
    /** Field-level validation only. Never used to explain an authorization decision. */
    readonly details?: readonly ApiErrorDetail[];
  };
}

/**
 * An error a controller or service may raise that is safe to render to the caller verbatim.
 *
 * Everything else — a driver error, a tenant-guard violation, an unexpected throw — is mapped
 * to `internal_error` by the filter with its message discarded.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: readonly ApiErrorDetail[],
    /**
     * The specific, sensitive cause. Logged, never serialised.
     *
     * This is where a `DenialCode`, a `SessionRejection` or a `MembershipResolutionFailure`
     * travels so that the audit trail keeps the precision the response deliberately drops.
     */
    readonly auditCode?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function apiErrorBody(error: ApiError, correlationId: string): ApiErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      correlationId,
      ...(error.details && error.details.length > 0 ? { details: error.details } : {}),
    },
  };
}

/**
 * The messages. Fixed strings, so two refusals that must be indistinguishable are
 * indistinguishable by construction rather than by two call sites happening to agree.
 */
export const MESSAGES = {
  unauthenticated: 'The request carries no valid session',
  forbidden: 'You do not have permission to perform this action',
  csrfFailed: 'The request could not be verified. Reload the page and try again',
  /**
   * Used both for an organization that does not exist and for one the caller has no membership
   * in. That identity is the control — see `MembershipResolver`'s `REFUSAL_MESSAGE` — and a
   * test asserts the two responses are byte-identical.
   */
  organizationNotFound: 'No organization matching that identifier is available to you',
  notFound: 'The requested resource was not found',
  conflict: 'The resource was modified concurrently. Reload and try again',
  internal: 'The request could not be completed',
  rateLimited: 'Too many requests. Wait a moment and try again',
} as const;
