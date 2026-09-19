import { describe, expect, it } from 'vitest';
import { lastValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { CorrelationInterceptor, SPAN_CORRELATION_ATTRIBUTE } from './correlation.interceptor.js';
import { RecordingTracer } from '../observability/tracer.js';

/**
 * OBS-001 correlation proof: the id a caller sees on the response header is the same id the
 * request's trace span carries, so a span can be found from what the caller reported. Exercised
 * against a {@link RecordingTracer} because the default tracer is a no-op until the OTel SDK
 * (a follow-up) is added.
 */

function contextFor(headers: Record<string, string>): {
  context: ExecutionContext;
  responseHeaders: Record<string, string>;
} {
  const responseHeaders: Record<string, string> = {};
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
      getResponse: () => ({
        header(name: string, value: string) {
          responseHeaders[name] = value;
        },
      }),
    }),
  } as unknown as ExecutionContext;
  return { context, responseHeaders };
}

const handler: CallHandler = { handle: () => of({ ok: true }) };

describe('the correlation interceptor span', () => {
  it("puts the request's correlation id on the span it opens", async () => {
    const tracer = new RecordingTracer();
    const interceptor = new CorrelationInterceptor(tracer);
    const correlationId = '018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b';
    const { context, responseHeaders } = contextFor({ 'x-correlation-id': correlationId });

    await lastValueFrom(interceptor.intercept(context, handler));

    // The header the caller sees and the span's attribute are the same id.
    expect(responseHeaders['x-correlation-id']).toBe(correlationId);
    expect(tracer.spans).toHaveLength(1);
    expect(tracer.spans[0]?.attributes[SPAN_CORRELATION_ATTRIBUTE]).toBe(correlationId);
    // The span is closed once the response stream completes.
    expect(tracer.spans[0]?.ended).toBe(true);
  });
});
