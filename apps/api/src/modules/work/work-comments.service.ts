import { authorize, extractMentionedUserIds } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemCommentRow, WorkItemRow } from '../../common/database/schema.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { AuditEventsRepository } from '../audit/audit-events.repository.js';
import { WorkCommentsRepository } from './work-comments.repository.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { ReviewMentionCandidatesRepository } from '../files/review-mention-candidates.repository.js';
import type { MentionCandidateRow } from '../files/review-mention-candidates.repository.js';

/**
 * x147's application service — a work item's comments / activity (Work module 7).
 *
 * It is `WorkItemsService`'s shape at a smaller scale: the repository stays free of policy, the
 * controller stays free of both, and the two rules that matter live here.
 *
 * ## Resolve the parent, tenant-scoped, BEFORE authorizing or writing
 *
 * Both routes name a `workItemId` in the path. The parent work item is read first, scoped to the
 * acting tenant — a `work_item_id` from another studio simply does not resolve, and the answer is
 * the same 404 an absent id gives. Only once the row is in hand is `authorize()` asked whether
 * this principal may act on it, judged against the work item's own project and audience. That
 * order is the trap x147 was briefed on: a cross-tenant (or unrelated) parent is a 404 with no
 * write, never a comment created against somebody else's work.
 *
 * ## `authorize()` is the one place the rule is written
 *
 * A comment has no audience of its own; it inherits the parent work item's. The read gate is
 * `work.read` on that item; the write gate is `work.update`. A caller who may read the item but
 * not comment on it gets a 403 (their access to the item is not a secret); a caller with no
 * relation to the item at all gets a 404 (its existence is). A comment is internal-only — it is
 * authored by a membership of the studio and never projected to a client surface.
 */

/** The client-facing projection of one work-item comment. Paired in `e2e/contracts`. */
export interface WorkCommentView {
  readonly id: string;
  readonly workItemId: string;
  readonly authorMembershipId: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface AddCommentInput {
  readonly body: string;
}

/** 53-11: one person a work-item comment may @mention — somebody who can see the item. */
export interface WorkMentionCandidateView {
  readonly userId: string;
  readonly displayName: string;
  /** The token to put in the body (`@<userId>`), the form the mention notice reads. */
  readonly mention: string;
}

/** The most people one comment can notify; more ids in a body are ignored. */
const MAX_NOTIFIED_MENTIONS = 20;
const MAX_CANDIDATES = 25;

export class WorkCommentsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly comments: WorkCommentsRepository = new WorkCommentsRepository(),
    private readonly audit: AuditEventsRepository = new AuditEventsRepository(),
    /** 53-11: optional so a suite can construct the service without the outbox. */
    private readonly outbox?: OutboxEventsRepository,
    private readonly people: Pick<
      ReviewMentionCandidatesRepository,
      'search'
    > = new ReviewMentionCandidatesRepository(),
  ) {}

  /**
   * 53-11: the people a comment on this item may @mention — active internal members on the item's
   * project, plus members with organization-wide scope; the caller excluded. A caller who cannot
   * read the item gets the same 404 as the list. Comments are internal, so client contacts never
   * appear.
   */
  async mentionCandidates(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    query: string,
    limit = 10,
  ): Promise<readonly WorkMentionCandidateView[]> {
    const prefix = query.trim().replace(/^@/u, '');
    if (prefix.length > 100) {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', [
        { field: 'q', message: 'must be 100 characters or fewer' },
      ]);
    }
    const capped = Math.min(Math.max(1, Math.trunc(limit)), MAX_CANDIDATES);
    const rows = await this.database.read(context, async (runner) => {
      const parent = await this.readableParent(runner, context, principal, workItemId);
      return this.visiblePeople(runner, context, parent, { prefix, limit: capped + 1 });
    });
    return dedupe(rows)
      .filter((row) => row.userId !== principal.userId)
      .slice(0, capped)
      .map((row) => ({
        userId: row.userId,
        displayName: row.displayName,
        mention: `@${row.userId}`,
      }));
  }

  /** Staff who can see the item: on its project, or with organization-wide scope. */
  private visiblePeople(
    runner: TenantQueryRunner,
    context: TenantContext,
    parent: WorkItemRow,
    input: {
      readonly prefix: string;
      readonly limit: number;
      readonly userIds?: readonly string[];
    },
  ): Promise<readonly MentionCandidateRow[]> {
    return this.people.search(runner, context, {
      projectId: parent.projectId,
      prefix: input.prefix,
      userIds: input.userIds,
      includeStaff: true,
      includeClients: false,
      limit: input.limit,
    });
  }

  /** The work item's comments, created-at ascending. Behind `work.read` on the parent item. */
  async list(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<readonly WorkCommentView[]> {
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const rows = await this.comments.listForWorkItem(runner, context, workItemId);
      return rows.map(toView);
    });
  }

  /** Append a comment. Behind `work.update` on the parent item. */
  async add(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    input: AddCommentInput,
  ): Promise<WorkCommentView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);

      // The author is the acting membership. A `work.update` holder is always an internal
      // member of this studio, so a membership id is present; a principal without one could not
      // have passed the write gate and there is no client author of an internal comment.
      const authorMembershipId = principal.membershipId;
      if (!authorMembershipId) {
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
      }

      const row = await this.comments.create(tx, context, {
        workItemId,
        authorMembershipId,
        body: input.body,
      });
      // A comment written through a connected AI app is attributed to the member AND the app: one
      // audit row on the item (the append stamps channel and app), read back by the activity feed.
      // 53-11: the people this comment @mentions who can see the item are told by the worker
      // (kind `mention`), which re-checks each one's access at delivery. A mention of somebody
      // who cannot see the item stays text: no notice, nothing about the item reaches them.
      const mentioned = extractMentionedUserIds(input.body)
        .map((id) => id.toLowerCase())
        .filter((id) => id !== principal.userId.toLowerCase())
        .slice(0, MAX_NOTIFIED_MENTIONS);
      if (this.outbox && mentioned.length > 0) {
        const visible = await this.visiblePeople(tx, context, parent, {
          prefix: '',
          userIds: mentioned,
          limit: MAX_NOTIFIED_MENTIONS * 2,
        });
        const allowed = new Set(visible.map((person) => person.userId.toLowerCase()));
        const mentionedUserIds = mentioned.filter((id) => allowed.has(id));
        if (mentionedUserIds.length > 0) {
          await this.outbox.append(tx, context, {
            type: 'work_item.comment_created.v1',
            aggregateId: workItemId,
            payload: {
              workItemId,
              commentId: row.id,
              projectId: parent.projectId,
              authorUserId: context.userId,
              mentionedUserIds,
            },
          });
        }
      }
      if (context.actorChannel !== undefined) {
        await this.audit.append(tx, context, {
          action: 'work_item.commented',
          result: 'allowed',
          objectId: workItemId,
          metadata: { entry_id: row.id },
        });
      }
      return toView(row);
    });
  }

  /**
   * Read the parent work item, tenant-scoped, and refuse a caller who may not read it. The 404
   * for "no relation" is produced here, before any write, and is the same 404 the work-item read
   * produces for a row that does not exist — so a caller cannot discover an item by trying to
   * hang a comment off it.
   */
  private async readableParent(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRow> {
    const row = await this.workItems.findById(runner, context, workItemId);
    if (!row || row.deletedAt !== null || !this.mayRead(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  private requireWrite(principal: Principal, parent: WorkItemRow): void {
    const verdict = authorize({
      principal,
      capability: 'work.update',
      resource: resourceOf(parent),
    });
    if (!verdict.allowed) {
      // Forbidden rather than not-found: the caller has already been allowed to read this item,
      // so its existence is not a secret from them.
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
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

function dedupe(rows: readonly MentionCandidateRow[]): readonly MentionCandidateRow[] {
  const seen = new Set<string>();
  const out: MentionCandidateRow[] = [];
  for (const row of [...rows].sort((a, b) => a.displayName.localeCompare(b.displayName))) {
    if (seen.has(row.userId)) continue;
    seen.add(row.userId);
    out.push(row);
  }
  return out;
}

function toView(row: WorkItemCommentRow): WorkCommentView {
  return {
    id: row.id,
    workItemId: row.workItemId,
    authorMembershipId: row.authorMembershipId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}
