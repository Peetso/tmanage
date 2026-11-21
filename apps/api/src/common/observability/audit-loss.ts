/**
 * The lost-audit-row counter (OWASP ASVS 5.0 V16: logs of security-relevant events must not be
 * silently lost).
 *
 * A few audit writers are fail-open by design, because the event they record has already been
 * decided and a logging outage must not change it: the AI assistant's read-only turns
 * (`copilot/ai-audit.ts`), the `/mcp` tool-call rows (`mcp/mcp-call-audit.ts`) and the guard
 * refusals in `authentication_events` (`http/authentication-event-recorder.ts`). A lost row is
 * logged at error level by its writer and counted here, per source, since the process started.
 * `GET /healthz/deep` reports the reading as its `audit_log` check (states only on that public
 * route; the counts are in the error log lines).
 *
 * Writers whose rows guard a change (an AI confirm, undo or run-at-once, and every route's own
 * audit row) are fail-closed instead and never reach this counter: the change fails with its row.
 */

export const AUDIT_LOSS_SOURCES = ['ai_turn', 'mcp_tool_call', 'auth_guard_refusal'] as const;
export type AuditLossSource = (typeof AUDIT_LOSS_SOURCES)[number];

export type AuditLogSourceState = 'ok' | 'rows_lost';

/** The `/healthz/deep` reading: the worst state, and each source's state. No counts. */
export interface AuditLogCheck {
  readonly state: AuditLogSourceState;
  readonly sources: Readonly<Record<AuditLossSource, AuditLogSourceState>>;
}

export class AuditLossCounter {
  private readonly lost = new Map<AuditLossSource, number>();

  /** Count `rows` lost rows for `source`; returns that source's total since start. */
  record(source: AuditLossSource, rows = 1): number {
    const total = (this.lost.get(source) ?? 0) + Math.max(0, Math.trunc(rows));
    this.lost.set(source, total);
    return total;
  }

  /** Lost rows for one source since start. */
  count(source: AuditLossSource): number {
    return this.lost.get(source) ?? 0;
  }

  check(): AuditLogCheck {
    const sources = Object.fromEntries(
      AUDIT_LOSS_SOURCES.map((source) => [source, this.count(source) > 0 ? 'rows_lost' : 'ok']),
    ) as Record<AuditLossSource, AuditLogSourceState>;
    const state = Object.values(sources).includes('rows_lost') ? 'rows_lost' : 'ok';
    return { state, sources };
  }
}

/** The process's counter. One API process serves one deployment, so the count is since boot. */
export const AUDIT_LOSS = new AuditLossCounter();
