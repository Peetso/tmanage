/**
 * OBS-001. A minimal internal tracing seam.
 *
 * The OpenTelemetry SDK is **not** in the frozen lockfile (only `@opentelemetry/api` appears, and
 * only as an unfulfilled optional peer dependency of other packages), and this slice runs offline
 * with `--frozen-lockfile`, so adding it is a follow-up that needs network and a lockfile change
 * Peter should see. Rather than block the correlation half on that, spans are produced against
 * this tiny interface: `startSpan(name, attributes)` returns a {@link Span} you `end()`.
 *
 * The default {@link NOOP_TRACER} does nothing, so wiring it into the request pipeline is free.
 * When the SDK is added later, an exporter-backed `Tracer` is provided under {@link TRACER} in the
 * composition root and every span already carries the request correlation id (see
 * `correlation.interceptor.ts`) — the exporter is the only missing piece.
 */

/** The attribute value kinds a span records — the OpenTelemetry primitive set, minus arrays. */
export type SpanAttributeValue = string | number | boolean;

export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;

export interface Span {
  setAttribute(key: string, value: SpanAttributeValue): void;
  end(): void;
}

export interface Tracer {
  startSpan(name: string, attributes?: SpanAttributes): Span;
}

/** DI token for the active {@link Tracer}. Bound to {@link NOOP_TRACER} until an exporter exists. */
export const TRACER = Symbol('tmanage.tracer');

const NOOP_SPAN: Span = {
  setAttribute() {
    /* no-op */
  },
  end() {
    /* no-op */
  },
};

/** The default tracer: every span is a shared no-op that allocates nothing and exports nothing. */
export const NOOP_TRACER: Tracer = {
  startSpan() {
    return NOOP_SPAN;
  },
};

/** A span the {@link RecordingTracer} keeps in memory, for tests and future in-process inspection. */
export interface RecordedSpan {
  readonly name: string;
  readonly attributes: Record<string, SpanAttributeValue>;
  ended: boolean;
}

/**
 * A tracer that records its spans in memory rather than exporting them. It is what the
 * correlation test asserts against, and a ready seam for a future in-process debug endpoint.
 */
export class RecordingTracer implements Tracer {
  readonly spans: RecordedSpan[] = [];

  startSpan(name: string, attributes: SpanAttributes = {}): Span {
    const span: RecordedSpan = { name, attributes: { ...attributes }, ended: false };
    this.spans.push(span);
    return {
      setAttribute: (key, value) => {
        span.attributes[key] = value;
      },
      end: () => {
        span.ended = true;
      },
    };
  }
}
