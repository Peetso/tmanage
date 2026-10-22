import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { isAuditAction, isSafeAuditMetadata } from '@tmanage/domain';
import type { AuditAction, AuditMetadata, AuditResult } from '@tmanage/domain';
import type { CatalogRuntime, CatalogTool, RunResult } from '@tmanage/mcp-server';
import { withActorChannel } from '../../common/database/tenant-context.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { AuditEventsRepository } from '../audit/audit-events.repository.js';
import {
  MembershipNotResolvedError,
  MembershipResolver,
} from '../tenancy/membership-resolver.repository.js';
import { argsSha256 } from './internal-grant.js';

/**
 * **One audit event per `/mcp` tool call (plan §4.4, architecture B6).**
 *
 * The endpoint wraps its catalogue runtime with {@link auditedRuntime}: every `tools/call` — an op
 * tool or a meta-tool — produces exactly one {@link McpToolCallAudit}, and the
 * {@link DatabaseMcpCallAuditor} appends it to `audit_events` through the same
 * {@link AuditEventsRepository} every other writer uses (so `assertSafeAuditMetadata` gates it and
 * `actor_channel=ai_assistant` is stamped by the AUT-08 context).
 *
 * What a row holds: the token's user (the row's actor), the AI client id, the tool name, the
 * registry op id, the outcome, the latency and a SHA-256 of the canonical arguments. Never the
 * token, never an argument value, never a result body. Values outside the safe identifier shape
 * (a CIMD client id is a URL) are recorded as a short hash rather than refused or dropped.
 *
 * Best-effort, like `AuditService.recordDenial`: the tool call's answer never waits on, or fails
 * because of, its audit row. A lost row is reported on the log, never turned into an error.
 */

/** The closed `audit_events.action` this writer uses. It must exist in the domain catalogue. */
export const MCP_TOOL_CALL_ACTION_NAME = 'mcp.tool_called';

/**
 * The action, if the domain catalogue (`AUDIT_ACTION_CATALOG`) names it. The vocabulary is closed
 * on purpose, so this writer never casts its way past it: until the catalogue gains the action the
 * database auditor appends nothing and the redacted `mcp.tool_call` log line is the only trace.
 */
export function mcpToolCallAuditAction(): AuditAction | undefined {
  const name: string = MCP_TOOL_CALL_ACTION_NAME;
  return isAuditAction(name) ? name : undefined;
}

export type McpToolCallOutcome = 'ok' | 'tool_error' | 'failed';

/** Who made the call — the token's binding. No token, no header. */
export interface McpCallAuditScope {
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
  /** The OAuth client id, or `pat:<id>` for a personal access token. */
  readonly clientId: string;
  readonly correlationId: string;
}

/** One tool call, redacted by construction. */
export interface McpToolCallAudit {
  readonly tool: string;
  /** The registry op the call ran or asked for (`tmanage_run_action`), else null. */
  readonly opId: string | null;
  readonly outcome: McpToolCallOutcome;
  /** SHA-256 of the canonical arguments. Never the arguments themselves. */
  readonly argsSha256: string;
  readonly latencyMs: number;
}

export interface McpCallAuditor {
  /** Best-effort: returns at once, never throws and never rejects into the caller. */
  record(scope: McpCallAuditScope, call: McpToolCallAudit): void;
}

export const MCP_CALL_AUDITOR = Symbol.for('tmanage.McpCallAuditor');

const SAFE_VALUE = /^[A-Za-z0-9._:-]{0,64}$/;

/** A value as-is when it is a safe identifier, otherwise `sha256:` and 32 hex characters of it. */
export function safeAuditValue(value: string): string {
  return SAFE_VALUE.test(value)
    ? value
    : `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

/** The `audit_events.result` a tool call is filed under. */
export function auditResultFor(outcome: McpToolCallOutcome): AuditResult {
  return outcome === 'ok' ? 'allowed' : 'error';
}

/** The row's metadata: identifiers and classifications only. */
export function mcpToolCallMetadata(
  scope: McpCallAuditScope,
  call: McpToolCallAudit,
): AuditMetadata {
  return {
    actor_kind: 'ai',
    client_id: safeAuditValue(scope.clientId),
    membership_id: scope.membershipId,
    tool: safeAuditValue(call.tool),
    op_id: call.opId === null ? null : safeAuditValue(call.opId),
    outcome: call.outcome,
    args_sha256: call.argsSha256,
    latency_ms: Math.max(0, Math.round(call.latencyMs)),
  };
}

/**
 * The catalogue runtime with one audit record per tool call. Resource reads are passed through
 * unchanged: their inner REST calls are not tool calls.
 */
export function auditedRuntime(
  runtime: CatalogRuntime,
  onToolCall: (call: McpToolCallAudit) => void,
): CatalogRuntime {
  return {
    async runTool(tool: CatalogTool, args: Record<string, unknown>): Promise<RunResult> {
      const actionId = tool.name === 'tmanage_run_action' ? args['action_id'] : undefined;
      const base = {
        tool: tool.name,
        opId: tool.opId ?? (typeof actionId === 'string' ? actionId : null),
        argsSha256: argsSha256(args),
      };
      const startedAt = Date.now();
      try {
        const result = await runtime.runTool(tool, args);
        onToolCall({
          ...base,
          outcome: result.isError ? 'tool_error' : 'ok',
          latencyMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        onToolCall({ ...base, outcome: 'failed', latencyMs: Date.now() - startedAt });
        throw error;
      }
    },
    readResource: (resource, uri, variables) => runtime.readResource(resource, uri, variables),
  };
}

/** The production auditor: `audit_events`, in the token's own organization, as the token's user. */
export class DatabaseMcpCallAuditor implements McpCallAuditor {
  private readonly logger = new Logger('McpCallAudit');

  constructor(
    private readonly database: TenantDatabase,
    private readonly events: AuditEventsRepository = new AuditEventsRepository(),
    private readonly memberships: MembershipResolver = new MembershipResolver(database),
    private readonly action: AuditAction | undefined = mcpToolCallAuditAction(),
  ) {}

  record(scope: McpCallAuditScope, call: McpToolCallAudit): void {
    if (this.action === undefined) return;
    this.append(this.action, scope, call).catch((error: unknown) => {
      this.logger.warn(
        JSON.stringify({
          event: 'mcp.tool_call_audit_failed',
          correlationId: scope.correlationId,
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
    });
  }

  private async append(
    action: AuditAction,
    scope: McpCallAuditScope,
    call: McpToolCallAudit,
  ): Promise<void> {
    let resolved;
    try {
      resolved = await this.memberships.resolve({
        userId: scope.userId,
        organization: { organizationId: scope.organizationId },
        correlationId: scope.correlationId,
      });
    } catch (error) {
      if (error instanceof MembershipNotResolvedError) return;
      throw error;
    }
    if (
      resolved.context.organizationId !== scope.organizationId ||
      resolved.context.membershipId !== scope.membershipId
    ) {
      return;
    }
    const context = withActorChannel(resolved.context, 'ai_assistant');
    const metadata = mcpToolCallMetadata(scope, call);
    await this.database.transaction(context, (tx) =>
      this.events.append(tx, context, {
        action,
        result: auditResultFor(call.outcome),
        objectId: null,
        metadata: isSafeAuditMetadata(metadata)
          ? metadata
          : { metadata_was_unsafe: true, outcome: call.outcome },
      }),
    );
  }
}
