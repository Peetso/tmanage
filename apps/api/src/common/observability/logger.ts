import { redactFields } from './redact.js';

/**
 * OBS-001. The one serializer structured log lines go through.
 *
 * There is no central logger in this process yet — structured events are written with
 * `console.*` at the site that produces them — so this is the seam that guarantees redaction
 * happens before any object reaches a log sink. Call sites serialize their payload with this
 * rather than `JSON.stringify` directly (see `app-composition.ts`'s tenant-guard event), and the
 * day a real logger is introduced this is the function its serializer hook installs.
 */
export function serializeForLog(payload: unknown): string {
  return JSON.stringify(redactFields(payload));
}
