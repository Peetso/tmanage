import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { CORRELATION_HEADER } from './correlation.js';
import { ensureRequestState } from './request-state.js';

/**
 * Echoes the correlation id on a successful response.
 *
 * It no longer *establishes* the id — `ensureRequestState` does that on first touch, whoever
 * touches first. The reason is Nest's lifecycle: global interceptors run **after** guards, so
 * an interceptor that created the state would create it too late for every guard that needs
 * it, and for every request a guard refuses it would never run at all.
 *
 * The refusal path is covered by `HttpExceptionFilter`, which sets the same header. Between
 * them every response carries it, which is what makes a log line findable from what the caller
 * saw.
 */
@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const state = ensureRequestState(http.getRequest<object>());
    http
      .getResponse<{ header(name: string, value: string): unknown }>()
      .header(CORRELATION_HEADER, state.correlationId);
    return next.handle();
  }
}
