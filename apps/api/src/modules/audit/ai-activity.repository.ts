import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { auditEvents } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * **The member's own connected-AI activity: the read half (AI panel, gap 1).**
 *
 * Reads only `mcp.tool_called` rows (the one row per `/mcp` tool call that
 * `mcp/mcp-call-audit.ts` appends) in the caller's organization, whose actor is the caller's
 * user **and** whose `membership_id` is the caller's membership, newest first on the
 * `(organization_id, actor_user_id, created_at)` index. Another member's rows, another
 * workspace's rows and every other action are never read. The in-app TManage AI is not the
 * member's own connected AI, so its `tmanage-ai` client is left out.
 *
 * Only identifiers and classifications come back, extracted from `metadata_json` one key at a
 * time (`JSON_UNQUOTE(JSON_EXTRACT(...))` reads alike on MySQL 8 and on MariaDB 11.8, where JSON
 * is LONGTEXT). A key the row does not have, or holds as JSON `null`, reads `null`: rows written
 * before the subject keys existed come back with a kind-less, id-less subject.
 */

/** One audit row of a tool call, as the activity list needs it. */
export interface AiToolCallRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly clientId: string | null;
  readonly opId: string | null;
  readonly tool: string | null;
  readonly outcome: string | null;
  readonly targetKind: string | null;
  readonly targetId: string | null;
  readonly targetCount: number | null;
  readonly projectId: string | null;
}

/** A keyset position: the last row of the page before. */
export interface AiActivityCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/** The in-app TManage AI's client id (`copilot-chat.adapters.ts` `TMANAGE_AI_CLIENT`). */
const TMANAGE_AI_CLIENT_ID = 'tmanage-ai';

const MCP_TOOL_CALLED = 'mcp.tool_called';

function metadataKey(key: string): SQL<string | null> {
  return sql<string | null>`json_unquote(json_extract(${auditEvents.metadataJson}, ${`$.${key}`}))`;
}

/** `JSON_UNQUOTE` of a JSON `null` is the text `null`; both mean "absent". */
function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const string = String(value);
  return string === '' || string === 'null' ? null : string;
}

function count(value: unknown): number | null {
  const string = text(value);
  if (string === null) return null;
  const parsed = Number(string);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export class AiActivityRepository {
  /** At most `limit` of the caller's own tool-call rows older than `before`, newest first. */
  async listOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    before: AiActivityCursor | null,
    limit: number,
  ): Promise<AiToolCallRow[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: auditEvents.id,
        createdAt: auditEvents.createdAt,
        clientId: metadataKey('client_id'),
        opId: metadataKey('op_id'),
        tool: metadataKey('tool'),
        outcome: metadataKey('outcome'),
        targetKind: metadataKey('target_kind'),
        targetId: metadataKey('target_id'),
        targetCount: metadataKey('target_count'),
        projectId: metadataKey('project_id'),
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, context.organizationId),
          eq(auditEvents.actorUserId, context.userId),
          eq(auditEvents.action, MCP_TOOL_CALLED),
          sql`${metadataKey('membership_id')} = ${context.membershipId}`,
          sql`coalesce(${metadataKey('client_id')}, '') <> ${TMANAGE_AI_CLIENT_ID}`,
          ...(before === null
            ? []
            : [
                or(
                  lt(auditEvents.createdAt, before.createdAt),
                  and(eq(auditEvents.createdAt, before.createdAt), lt(auditEvents.id, before.id)),
                ),
              ]),
        ),
      )
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      clientId: text(row.clientId),
      opId: text(row.opId),
      tool: text(row.tool),
      outcome: text(row.outcome),
      targetKind: text(row.targetKind),
      targetId: text(row.targetId),
      targetCount: count(row.targetCount),
      projectId: text(row.projectId),
    }));
  }
}
