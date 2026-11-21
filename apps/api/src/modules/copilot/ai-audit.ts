import { Logger } from '@nestjs/common';
import { isSafeAuditMetadata } from '@tmanage/domain';
import type { AuditMetadata, AuditResult } from '@tmanage/domain';
import { withActorChannel } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { AuditEventsRepository } from '../audit/audit-events.repository.js';
import { AUDIT_LOSS, type AuditLossCounter } from '../../common/observability/audit-loss.js';
import { MCP_TOOL_CALL_ACTION_NAME, safeAuditValue } from '../mcp/mcp-call-audit.js';

/**
 * 62-14 (plan 62 §7 "Audit"): one audit row per tool call the in-app AI made and one per turn,
 * never any text.
 *
 * - **Tool call**: `mcp.tool_called`, client `tmanage-ai` — the action the `/mcp` endpoint writes
 *   for an outside AI app, so one trail answers "what did an AI do" for both. Metadata: the tool,
 *   its registry op, the outcome, a SHA-256 of the arguments and the latency. Never an argument
 *   value or a result.
 * - **Turn**: `ai.turn_completed`, one per AI task (the router's own task included): model, tier,
 *   domain, outcome, stop, model calls, tokens, credits charged, tool calls, whether the turn was
 *   tainted and how many figures the answer guard withheld. Never the question or the answer.
 *
 * All rows of a turn are written in one transaction, stamped `actor_channel = ai_assistant` (the AI
 * acted on the member's behalf), after the task is closed. These rows describe reads and closed
 * turns, so they are fail-open: a lost row is logged at error level with the correlation id and
 * counted ({@link DatabaseAiAudit.lostRows}), and never takes the member's answer away. Changes
 * are different (OWASP ASVS 5.0 V16, security events must not be silently lost): a confirm, an
 * undo and a change run at once write their audit row fail-closed, before the change runs
 * (`ai-change.service.ts`, `CopilotChatDeps.changeAudit`).
 */

export const AI_CLIENT_ID = 'tmanage-ai';
export const AI_TURN_COMPLETED_ACTION = 'ai.turn_completed';

export type AiToolCallOutcome = 'ok' | 'error' | 'refused' | 'proposed';

/** One tool call of a turn, redacted by construction. */
export interface AiToolCallAudit {
  readonly tool: string;
  readonly opId: string | null;
  readonly outcome: AiToolCallOutcome;
  readonly argsSha256: string;
  readonly latencyMs: number;
}

/** One closed AI task: numbers and classifications only. */
export interface AiTurnAudit {
  readonly taskId: string;
  readonly model: string;
  readonly tier: string;
  readonly domain: string | null;
  readonly outcome: 'completed' | 'failed';
  readonly stop: string | null;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly chargedCredits: number;
  readonly tainted: boolean;
  readonly withheldFigures: number;
  readonly toolCalls: readonly AiToolCallAudit[];
}

/** The chat's port: awaited, never throws. */
export interface ChatAudit {
  turn(context: TenantContext, turn: AiTurnAudit): Promise<void>;
}

export function toolCallResult(outcome: AiToolCallOutcome): AuditResult {
  if (outcome === 'refused') return 'denied';
  if (outcome === 'error') return 'error';
  return 'allowed';
}

export function toolCallMetadata(context: TenantContext, call: AiToolCallAudit): AuditMetadata {
  return {
    actor_kind: 'ai',
    client_id: AI_CLIENT_ID,
    membership_id: context.membershipId,
    tool: safeAuditValue(call.tool),
    op_id: call.opId === null ? null : safeAuditValue(call.opId),
    outcome: call.outcome,
    args_sha256: call.argsSha256,
    latency_ms: Math.max(0, Math.round(call.latencyMs)),
  };
}

export function turnMetadata(turn: AiTurnAudit): AuditMetadata {
  return {
    client_id: AI_CLIENT_ID,
    model: safeAuditValue(turn.model),
    tier: safeAuditValue(turn.tier),
    domain: turn.domain === null ? null : safeAuditValue(turn.domain),
    outcome: turn.outcome,
    stop: turn.stop === null ? null : safeAuditValue(turn.stop),
    model_calls: turn.modelCalls,
    // Provider tokens. A key may not name `token` (the audit catalogue refuses it as content).
    input_size: turn.inputTokens,
    output_size: turn.outputTokens,
    charged_credits: turn.chargedCredits,
    tool_calls: turn.toolCalls.length,
    tainted: turn.tainted,
    withheld_figures: turn.withheldFigures,
  };
}

const safe = (metadata: AuditMetadata, outcome: string): AuditMetadata =>
  isSafeAuditMetadata(metadata) ? metadata : { metadata_was_unsafe: true, outcome };

export class DatabaseAiAudit implements ChatAudit {
  private readonly logger = new Logger('AiAudit');

  private lost = 0;

  /** Turn audit rows lost since start (a write failed); the metric the error log line carries. */
  get lostRows(): number {
    return this.lost;
  }

  constructor(
    private readonly database: TenantDatabase,
    private readonly events: AuditEventsRepository = new AuditEventsRepository(),
    private readonly loss: AuditLossCounter = AUDIT_LOSS,
  ) {}

  async turn(context: TenantContext, turn: AiTurnAudit): Promise<void> {
    const ai = withActorChannel(context, 'ai_assistant');
    try {
      await this.database.transaction(ai, async (tx) => {
        for (const call of turn.toolCalls) {
          await this.events.append(tx, ai, {
            action: MCP_TOOL_CALL_ACTION_NAME,
            result: toolCallResult(call.outcome),
            objectId: null,
            metadata: safe(toolCallMetadata(context, call), call.outcome),
          });
        }
        await this.events.append(tx, ai, {
          action: AI_TURN_COMPLETED_ACTION,
          result: turn.outcome === 'completed' ? 'allowed' : 'error',
          objectId: turn.taskId,
          metadata: safe(turnMetadata(turn), turn.outcome),
        });
      });
    } catch (error) {
      this.lost += turn.toolCalls.length + 1;
      this.loss.record('ai_turn', turn.toolCalls.length + 1);
      this.logger.error(
        JSON.stringify({
          event: 'ai.turn_audit_failed',
          correlationId: context.correlationId,
          error: error instanceof Error ? error.name : 'unknown',
          lostRows: turn.toolCalls.length + 1,
          lostRowsTotal: this.lost,
        }),
      );
    }
  }
}
