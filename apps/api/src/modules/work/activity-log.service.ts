import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  AuditEventRow,
  WorkItemCommentRow,
  WorkItemRow,
} from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { AuditEventsRepository } from '../audit/audit-events.repository.js';
import { WorkCommentsRepository } from './work-comments.repository.js';

/**
 * x291's application service — a work item's merged activity timeline (Work module 7).
 *
 * Read-only, and by design it owns no table. The item's history already lives in rows other
 * slices write: status changes, creation, audience changes and dependency removals in
 * `audit_events` (objectType `work_item`, objectId this item), and member comments in
 * `work_item_comments` (x147). This service reads both, tenant-scoped to the resolved parent,
 * and merges them into one chronological feed — newest first — so the detail screen can show
 * the item's story in one place without a new store or a new write path.
 *
 * ## Resolve the parent, tenant-scoped, BEFORE authorizing or reading the feed
 *
 * The route names a `workItemId` in the path. The parent work item is read first, scoped to the
 * acting tenant — a `work_item_id` from another studio simply does not resolve, and the answer is
 * the same 404 an absent id gives. Only once the row is in hand is `authorize()` asked whether
 * this principal may *read* it. That order is the trap x291 was briefed on: a cross-tenant (or
 * unrelated) parent is a 404 read from **no** source table — the feed queries never run, so an
 * outsider cannot learn an item exists, nor read a single audit or comment row, by asking for its
 * activity. `work.read` is the whole gate; there is no write and no new capability.
 *
 * ## The feed is a projection, not the sources
 *
 * Each entry is `{ id, kind, action, actorId, summary, occurredAt }`. It is distinct from x274's
 * relations view (a link graph) and from the work-comments CRUD (this reads comments, it never
 * writes one). Comment bodies are already readable under `work.read` on the item, so a comment's
 * body is its summary; an audit entry's summary is a plain phrase derived from its action.
 */

const KIND_AUDIT = 'audit' as const;
const KIND_COMMENT = 'comment' as const;

/** The largest activity page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_ACTIVITY_PAGE = 100;
const DEFAULT_ACTIVITY_PAGE = 50;

/** A comment body is truncated to this many characters in the timeline summary. */
const SUMMARY_MAX = 280;

/** Plain-language phrases for the work-item audit actions this feed surfaces. */
const AUDIT_SUMMARIES: Readonly<Record<string, string>> = {
  'work_item.created': 'Created this item',
  'work_item.transitioned': 'Changed the status',
  'work_item.audience_changed': 'Changed who can see this item',
  'work_item.deleted': 'Deleted this item',
  'work_item.dependency_removed': 'Removed a dependency',
};

/**
 * One entry in a work item's activity feed. Paired `Exact` with the web `WorkActivityEntry` in
 * `e2e/contracts`. `actorId` is the user who acted for an audit entry and the author membership
 * for a comment — a display handle, never an email; `null` means a system-initiated action.
 */
export interface WorkActivityEntryView {
  readonly id: string;
  readonly kind: typeof KIND_AUDIT | typeof KIND_COMMENT;
  readonly action: string;
  readonly actorId: string | null;
  readonly summary: string;
  readonly occurredAt: string;
}

export interface ActivityFeedOptions {
  readonly limit?: number;
}

export class WorkActivityLogService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly audit: AuditEventsRepository = new AuditEventsRepository(),
    private readonly comments: WorkCommentsRepository = new WorkCommentsRepository(),
  ) {}

  /**
   * The item's merged activity, newest first, bounded to one page. Behind `work.read` on the
   * parent item — a caller who may not read the item gets a 404 and no source row is read.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    options: ActivityFeedOptions = {},
  ): Promise<readonly WorkActivityEntryView[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_ACTIVITY_PAGE, 1), MAX_ACTIVITY_PAGE);
    return this.database.read(context, async (runner) => {
      // Resolve-then-authorize FIRST. Only past this line does a single source row get read.
      await this.readableParent(runner, context, principal, workItemId);

      const [auditRows, commentRows] = await Promise.all([
        this.audit.historyOf(runner, context, 'work_item', workItemId, { limit }),
        this.comments.listForWorkItem(runner, context, workItemId, limit),
      ]);

      const entries = [...auditRows.map(toAuditEntry), ...commentRows.map(toCommentEntry)];
      // Newest first; a shared millisecond falls back to id descending so a page is stable.
      entries.sort((a, b) => {
        if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1;
        return a.id < b.id ? 1 : -1;
      });
      return entries.slice(0, limit);
    });
  }

  /**
   * Read the parent work item, tenant-scoped, and refuse a caller who may not read it with the
   * same 404 a missing item gives — so a caller cannot discover an item, or read any of its
   * history, by asking for its activity.
   */
  private async readableParent(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRow> {
    const row = await this.workItems.findById(runner, context, workItemId);
    if (!row || !this.mayRead(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return authorize({ principal, capability: 'work.read', resource: resourceOf(row) }).allowed;
  }
}

function resourceOf(row: WorkItemRow) {
  return {
    organizationId: row.organizationId,
    projectId: row.projectId,
    audience: row.audience,
    lifecycle: row.deletedAt
      ? ('soft_deleted' as const)
      : row.state === 'archived'
        ? ('archived' as const)
        : ('active' as const),
  };
}

function toAuditEntry(row: AuditEventRow): WorkActivityEntryView {
  return {
    id: row.id,
    kind: KIND_AUDIT,
    action: row.action,
    actorId: row.actorUserId,
    summary: AUDIT_SUMMARIES[row.action] ?? row.action,
    occurredAt: row.createdAt.toISOString(),
  };
}

function toCommentEntry(row: WorkItemCommentRow): WorkActivityEntryView {
  const body = row.body.trim();
  return {
    id: row.id,
    kind: KIND_COMMENT,
    action: 'work_item.commented',
    actorId: row.authorMembershipId,
    summary: body.length > SUMMARY_MAX ? `${body.slice(0, SUMMARY_MAX)}…` : body,
    occurredAt: row.createdAt.toISOString(),
  };
}
