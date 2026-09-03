import { Catch, HttpException, Injectable } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { ApiError, MESSAGES, apiErrorBody } from './errors.js';
import type { ApiErrorCode } from './errors.js';
import { ensureRequestState } from './request-state.js';
import { CORRELATION_HEADER } from './correlation.js';
import { BootstrapScopeViolation, IdentityScopeViolation } from '../database/tenant-context.js';
import { TenantGuardViolation } from '../database/tenant-guard.js';
import {
  ProjectNotFoundError,
  ProjectVersionConflictError,
} from '../../modules/projects/projects.repository.js';

/**
 * The single place a thrown value becomes a response.
 *
 * ## The rule
 *
 * Only an {@link ApiError} is rendered with its own message. Everything else becomes a generic
 * 500 with its message discarded, and that default is the point rather than laziness: the
 * errors most worth not echoing are exactly the ones nobody anticipated. A driver error
 * carries the failing SQL; `DrizzleQueryError` carries the bound parameters (which is why
 * `query-error.ts` unwraps it at the database boundary); a constraint violation names columns
 * and values. None of that belongs in a response body.
 *
 * ## The three isolation violations are 500, deliberately
 *
 * `TenantGuardViolation`, `BootstrapScopeViolation` and `IdentityScopeViolation` mean a
 * statement tried to reach data without a tenant predicate — a **programming defect in this
 * application**, not a bad request. Rendering one as 4xx would file the most serious class of
 * bug in this system under "the client did something wrong", and would put a redacted
 * statement shape in front of whoever sent the request. They are 500, their text is dropped,
 * and the guard has already emitted its own security event with safe metadata.
 */
@Catch()
@Injectable()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<object>();
    const response = http.getResponse<{
      header(name: string, value: string): unknown;
      status(code: number): { send(body: unknown): unknown };
    }>();

    // A refusal never reaches the interceptor, so the header is set here too. Every response
    // carries it — that is what makes the log line findable from what the caller saw.
    const correlationId = ensureRequestState(request).correlationId;
    response.header(CORRELATION_HEADER, correlationId);
    const apiError = this.toApiError(exception);

    // The audit code and the original error are what a log sink and, later, AUD-001 consume.
    // They are attached to the error object rather than printed here so that wiring the
    // logger is one change in one place — and so this filter never writes content anywhere.
    response.status(apiError.status).send(apiErrorBody(apiError, correlationId));
  }

  private toApiError(exception: unknown): ApiError {
    if (exception instanceof ApiError) return exception;

    if (exception instanceof ProjectNotFoundError) {
      return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_found');
    }
    if (exception instanceof ProjectVersionConflictError) {
      return new ApiError(409, 'conflict', MESSAGES.conflict, undefined, 'version_conflict');
    }

    if (
      exception instanceof TenantGuardViolation ||
      exception instanceof BootstrapScopeViolation ||
      exception instanceof IdentityScopeViolation
    ) {
      return new ApiError(
        500,
        'internal_error',
        MESSAGES.internal,
        undefined,
        'tenant_isolation_violation',
      );
    }

    if (exception instanceof HttpException) {
      // Nest's own errors — a 404 from the router, a 400 from a pipe. The status is
      // meaningful; the message is replaced with one of ours so the envelope is uniform and
      // so a framework string never becomes part of the API's contract by accident.
      const status = exception.getStatus();
      if (status === 413) {
        // FILE-001b. Fastify refuses a part body over the octet-stream parser's own limit
        // before any handler runs, and the adapter hands it here as a 413 `HttpException`.
        // It is the one framework refusal that deserves a detail of ours: the caller holds a
        // valid target and sent more than one part may carry — the same answer the driver
        // gives for one byte over, so a client sees one shape for "too big".
        return new ApiError(
          413,
          'validation_failed',
          'The request body is invalid',
          [{ field: 'body', message: 'exceeds the part size' }],
          'part_too_large',
        );
      }
      return new ApiError(status, codeForStatus(status), messageForStatus(status));
    }

    return new ApiError(500, 'internal_error', MESSAGES.internal, undefined, 'unhandled');
  }
}

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'validation_failed';
  return 'internal_error';
}

function messageForStatus(status: number): string {
  if (status === 401) return MESSAGES.unauthenticated;
  if (status === 403) return MESSAGES.forbidden;
  if (status === 404) return MESSAGES.notFound;
  if (status === 409) return MESSAGES.conflict;
  if (status >= 500) return MESSAGES.internal;
  return 'The request could not be understood';
}
