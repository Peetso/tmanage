import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { finalize } from 'rxjs';
import type { Observable } from 'rxjs';
import { CORRELATION_HEADER } from './correlation.js';
import { ensureRequestState } from './request-state.js';
import { NOOP_TRACER, TRACER } from '../observability/tracer.js';
import type { Tracer } from '../observability/tracer.js';

/**
 * The attribute every request span carries. OpenTelemetry has no standard key for an
 * application correlation id, so it is namespaced under `tmanage.` — the value is the same id
 * the response header and every log line carry, which is what ties a span to a caller's report.
 */
export const SPAN_CORRELATION_ATTRIBUTE = 'tmanage.correlation_id';

/**
 * Echoes the correlation id on a successful response, and opens the request's trace span.
 *
 * It no longer *establishes* the id — `ensureRequestState` does that on first touch, whoever
 * touches first. The reason is Nest's lifecycle: global interceptors run **after** guards, so
 * an interceptor that created the state would create it too late for every guard that needs
 * it, and for every request a guard refuses it would never run at all.
 *
 * The refusal path is covered by `HttpExceptionFilter`, which sets the same header. Between
 * them every response carries it, which is what makes a log line findable from what the caller
 * saw.
 *
 * OBS-001: the span is started here so the request's correlation id is on it from the first
 * attribute, and `end()`ed via `finalize` whether the handler completes or errors. The tracer
 * is a {@link Tracer} seam that defaults to {@link NOOP_TRACER} (the OTel SDK is a follow-up,
 * see `observability/tracer.ts`), so this adds no route behaviour and no cost until an exporter
 * is provided under {@link TRACER}.
 */
@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  constructor(@Optional() @Inject(TRACER) private readonly tracer: Tracer = NOOP_TRACER) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const state = ensureRequestState(http.getRequest<object>());
    http
      .getResponse<{ header(name: string, value: string): unknown }>()
      .header(CORRELATION_HEADER, state.correlationId);
    const span = this.tracer.startSpan('http.request', {
      [SPAN_CORRELATION_ATTRIBUTE]: state.correlationId,
    });
    return next.handle().pipe(finalize(() => span.end()));
  }
}
