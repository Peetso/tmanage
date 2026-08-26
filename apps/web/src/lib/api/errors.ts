/**
 * The client-side half of the API's error envelope.
 *
 * These types mirror `apps/api/src/common/http/errors.ts` by hand rather than importing it.
 * That is a lint boundary, not an oversight: `18-REPOSITORY-STRUCTURE` puts the web app
 * above the API, never inside it, and `eslint.config.js` blocks `@tmanage/api` imports from
 * `apps/web/**`. When `packages/contracts` is generated from `openapi.yaml` (CONTRACT-001,
 * still unwritten) these declarations are replaced by the generated ones and this file goes
 * away. Until then the duplication is visible and small, which is the honest form of it.
 *
 * The vocabulary is coarse on purpose, and the web app must not widen it. The API returns
 * one `forbidden` for every authorization denial precisely so a caller cannot distinguish
 * "no such organization" from "you are not in it"; a screen that tried to be more helpful
 * by guessing between them would undo that.
 */

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'csrf_failed'
  | 'not_found'
  | 'conflict'
  | 'validation_failed'
  | 'rate_limited'
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
    readonly details?: readonly ApiErrorDetail[];
  };
}

const API_ERROR_CODES: readonly ApiErrorCode[] = [
  'unauthenticated',
  'forbidden',
  'csrf_failed',
  'not_found',
  'conflict',
  'validation_failed',
  'rate_limited',
  'internal_error',
];

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * A refusal the API described in its own envelope.
 *
 * Distinct from `NetworkError` below because the two need different screens: a rejected
 * request has a message the user can act on and a correlation ID support can trace, while a
 * request that never arrived has neither and only ever deserves "try again".
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly correlationId: string,
    readonly details: readonly ApiErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** The field errors, keyed by field, for a form to render beside its inputs. */
  fieldErrors(): ReadonlyMap<string, string> {
    const byField = new Map<string, string>();
    for (const detail of this.details) {
      if (!byField.has(detail.field)) {
        byField.set(detail.field, detail.message);
      }
    }
    return byField;
  }
}

/**
 * The request did not produce an answer — offline, DNS, TLS, a timeout, a CORS refusal.
 *
 * `22-SCREEN-BY-SCREEN` §1 lists "offline banner and queued-draft status" as a global state,
 * and that state cannot be reached if a transport failure is flattened into `internal_error`
 * alongside a real server fault.
 */
export class NetworkError extends Error {
  /**
   * The underlying failure travels on the standard `cause` option rather than on a property
   * of our own, so a logger, a debugger and `console.error` all find it where they look. It
   * is never rendered: a `TypeError: Failed to fetch` tells a person nothing they can use.
   */
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'NetworkError';
  }
}

/**
 * Parse an error response body without trusting it.
 *
 * A proxy, a load balancer or a misconfigured gateway can answer with HTML or an empty body
 * while still using an HTTP status. `status` is therefore the authority for *what happened*
 * and the body is only consulted for the details it may carry.
 */
export function toApiRequestError(
  status: number,
  body: unknown,
  correlationId: string,
): ApiRequestError {
  const envelope =
    typeof body === 'object' && body !== null && 'error' in body
      ? (body as { error: unknown }).error
      : undefined;

  const shape =
    typeof envelope === 'object' && envelope !== null ? (envelope as Record<string, unknown>) : {};

  const code = isApiErrorCode(shape['code']) ? shape['code'] : fallbackCodeFor(status);
  const message =
    typeof shape['message'] === 'string' ? shape['message'] : fallbackMessageFor(status);
  const bodyCorrelationId =
    typeof shape['correlationId'] === 'string' ? shape['correlationId'] : correlationId;

  const rawDetails = shape['details'];
  const details: ApiErrorDetail[] = Array.isArray(rawDetails)
    ? rawDetails.flatMap((detail: unknown) => {
        if (typeof detail !== 'object' || detail === null) return [];
        const record = detail as Record<string, unknown>;
        const field = record['field'];
        const detailMessage = record['message'];
        if (typeof field !== 'string' || typeof detailMessage !== 'string') return [];
        return [{ field, message: detailMessage }];
      })
    : [];

  return new ApiRequestError(status, code, message, bodyCorrelationId, details);
}

function fallbackCodeFor(status: number): ApiErrorCode {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422 || status === 400) return 'validation_failed';
  if (status === 429) return 'rate_limited';
  return 'internal_error';
}

/**
 * The message shown when the body carried none.
 *
 * Every string here is deliberately about what the reader can do next, and none of them
 * name a cause the API declined to name.
 */
function fallbackMessageFor(status: number): string {
  if (status === 401) return 'Your session has ended. Sign in again to continue.';
  if (status === 403) return 'You do not have access to this.';
  if (status === 404) return 'That is not available.';
  if (status === 409) return 'Someone changed this while you were working. Reload and try again.';
  if (status === 429) return 'Too many attempts. Wait a moment and try again.';
  return 'Something went wrong at our end. Try again.';
}
