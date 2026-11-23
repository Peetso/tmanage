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
  // 57-02: a write that would take the organization past its plan's people / projects limit (409).
  | 'plan_limit_people'
  | 'plan_limit_projects'
  // ---- platform-admin v2 · PA-02 ----
  // A platform admin whose preset lacks the route's permission (403; details name the key).
  | 'platform_permission_missing'
  | 'support_session_required'
  // ---- 56-13 (R18-f) ---- resolving an incident while a legal notification clock is open (422).
  | 'clock_open'
  // ---- 56-25 (R18-e) ---- the sign-in policy does not allow this method (403; details name the
  // allowed methods and the organization); a policy change that would lock members out (409).
  | 'method_not_allowed'
  | 'members_without_method'
  // ---- 56-28 (R19-f) ---- a client role that would carry an internal capability (422; details
  // name the capability tokens).
  | 'client_ceiling'
  // ---- 56-06 (R19-e) ---- an upload the file-safety rule refuses (422; one detail names the
  // reason token only); a client's 21st upload of the UTC day (429).
  | 'file_not_allowed'
  | 'daily_upload_limit'
  // ---- 62 (AI-TWO-WAYS) ---- TManage AI cannot answer in this workspace (404). One detail,
  // `reason`, names the workspace's own state so the member's panel can say what to do:
  // `not_on_test_list`, `flag_off`, `ai_off` or `no_key`. Only a member of the workspace on an
  // ordinary session ever gets this far (membership is resolved first), so it reveals nothing
  // about any other organization; no secret or setting name is ever in it.
  | 'ai_unavailable'
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
    /**
     * Field-level validation, or the one documented reason of a code that has one
     * (`platform_permission_missing`, `ai_unavailable`). Never used to explain an authorization
     * decision.
     */
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
  aiUnavailable: 'TManage AI is not available in this workspace',
} as const;
