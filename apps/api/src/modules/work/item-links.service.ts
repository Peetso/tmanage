import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkItemLinksRepository } from './item-links.repository.js';
import type { BlockingEdge, WorkItemLinkWithTarget } from './item-links.repository.js';

/**
 * x204's application service — typed links between work items (Work module 7).
 *
 * It is `WorkChecklistService`'s shape with a second parent: every route names the item the link is
 * authored on (`workItemId`, the path item), and create also names a target (`toWorkItemId`, the
 * body). The controller stays free of policy, the repository free of both, and the rules that
 * matter live here.
 *
 * ## Both ends are resolved tenant-scoped BEFORE authorizing or writing
 *
 * The path item is read first, tenant-scoped, and the read gate (`work.read`) or write gate
 * (`work.update`) is applied against it. On create the **target** is then resolved the same way:
 * a `toWorkItemId` from another studio does not resolve and earns the same 404 an absent id gives,
 * so a cross-tenant target can never leak its existence and no foreign-key 500 is possible. Only
 * once both rows are in hand is anything written.
 *
 * ## The four refusals of a create
 *
 * - **self-link** (`from = to`) → 400: not a relationship.
 * - **duplicate** (the exact typed edge already exists) → 400.
 * - **cycle** on `blocks` / `blocked_by` → 400: the prospective directed edge is walked against the
 *   tenant's existing blocking graph, and a link that would close a loop is refused. `relates` is
 *   undirected and never forms a cycle.
 * - **no `work.update`** on the path item → 403 (the caller may read it, so its existence is not a
 *   secret from them); **no relation at all** → 404.
 */

export const WORK_ITEM_LINK_TYPES = ['blocks', 'blocked_by', 'relates'] as const;
export type WorkItemLinkType = (typeof WORK_ITEM_LINK_TYPES)[number];

/** The client-facing projection of one link. Paired in `e2e/contracts`. */
export interface WorkItemLinkView {
  readonly id: string;
  readonly fromWorkItemId: string;
  readonly toWorkItemId: string;
  readonly toWorkItemTitle: string;
  readonly toWorkItemState: string;
  readonly linkType: WorkItemLinkType;
  readonly createdAt: string;
}

export interface CreateWorkItemLinkInput {
  readonly toWorkItemId: string;
  readonly linkType: WorkItemLinkType;
}

export class WorkItemLinksService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly links: WorkItemLinksRepository = new WorkItemLinksRepository(),
  ) {}

  /** The links authored on an item, oldest first. Behind `work.read` on the path item. */
  async list(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<readonly WorkItemLinkView[]> {
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const rows = await this.links.listFromItem(runner, context, workItemId);
      // F51: the far end is authorized on its own project and audience, as relations-graph does.
      // A target that is soft-deleted or that this caller may not read is omitted — its title and
      // state are never disclosed through a link authored on a readable item.
      return rows
        .filter(
          (row) => row.toWorkItem.deletedAt === null && this.mayRead(principal, row.toWorkItem),
        )
        .map(toView);
    });
  }

  /** Create a typed link from the path item to another item. Behind `work.update`. */
  async create(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    input: CreateWorkItemLinkInput,
  ): Promise<WorkItemLinkView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);

      // A self-link is not a relationship.
      if (input.toWorkItemId === workItemId) {
        throw new ApiError(400, 'validation_failed', 'a work item cannot link to itself', [
          { field: 'toWorkItemId', message: 'must be a different work item' },
        ]);
      }

      // The target is resolved tenant-scoped and must be readable by this caller: a cross-tenant or
      // unrelated `toWorkItemId` earns the same 404 an absent id gives, so it cannot leak existence.
      const target = await this.workItems.findById(tx, context, input.toWorkItemId);
      if (!target || target.deletedAt !== null || !this.mayRead(principal, target)) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'target_not_visible');
      }

      // Duplicate: the exact typed edge already exists.
      if (
        await this.links.edgeExists(tx, context, workItemId, input.toWorkItemId, input.linkType)
      ) {
        throw new ApiError(400, 'validation_failed', 'this link already exists', [
          { field: 'linkType', message: 'a link of this type already joins these items' },
        ]);
      }

      // Cycle: a blocking edge that would close a loop in the tenant's blocking graph.
      if (input.linkType !== 'relates') {
        const prospective = normalize(workItemId, input.toWorkItemId, input.linkType);
        const existing = await this.links.listBlockingEdges(tx, context);
        if (wouldCycle(existing, prospective)) {
          throw new ApiError(400, 'validation_failed', 'this link would create a cycle', [
            { field: 'linkType', message: 'the blocking relationship is circular' },
          ]);
        }
      }

      const row = await this.links.create(tx, context, {
        fromWorkItemId: workItemId,
        toWorkItemId: input.toWorkItemId,
        linkType: input.linkType,
        createdByUserId: context.userId,
      });
      return toView({
        link: row,
        toWorkItemTitle: target.title,
        toWorkItemState: target.state,
        toWorkItem: target,
      });
    });
  }

  /** Remove a link by id. Behind `work.update` on the path item. */
  async remove(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    linkId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);

      // The link must exist in the tenant AND be authored on the item named in the path: a link id
      // that names another item's edge is not this route's to remove, so it earns the same 404.
      const link = await this.links.findById(tx, context, linkId);
      if (!link || link.fromWorkItemId !== workItemId) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'link_not_visible');
      }

      await this.links.deleteById(tx, context, linkId);
    });
  }

  /**
   * Read the path work item, tenant-scoped, and refuse a caller who may not read it. The 404 for
   * "no relation" is produced here, before any write, and is the same 404 the work-item read
   * produces for a row that does not exist.
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
      // Forbidden rather than not-found: the caller has already been allowed to read this item.
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return authorize({ principal, capability: 'work.read', resource: resourceOf(row) }).allowed;
  }
}

/** Normalize a typed link to a directed blocker → blocked edge for the cycle walk. */
function normalize(
  fromWorkItemId: string,
  toWorkItemId: string,
  linkType: 'blocks' | 'blocked_by',
): BlockingEdge {
  return linkType === 'blocks'
    ? { blocker: fromWorkItemId, blocked: toWorkItemId }
    : { blocker: toWorkItemId, blocked: fromWorkItemId };
}

/**
 * True when adding `prospective` (blocker → blocked) closes a loop in `existing`: there is already
 * a path from `blocked` back to `blocker` following blocker → blocked edges, so the new edge would
 * complete a cycle. A bounded breadth-first walk over the tenant's small blocking graph.
 */
export function wouldCycle(existing: readonly BlockingEdge[], prospective: BlockingEdge): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of existing) {
    const list = adjacency.get(edge.blocker);
    if (list) list.push(edge.blocked);
    else adjacency.set(edge.blocker, [edge.blocked]);
  }

  const seen = new Set<string>();
  const queue: string[] = [prospective.blocked];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    if (node === prospective.blocker) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adjacency.get(node) ?? []) queue.push(next);
  }
  return false;
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

function toView(joined: WorkItemLinkWithTarget): WorkItemLinkView {
  return {
    id: joined.link.id,
    fromWorkItemId: joined.link.fromWorkItemId,
    toWorkItemId: joined.link.toWorkItemId,
    toWorkItemTitle: joined.toWorkItemTitle,
    toWorkItemState: joined.toWorkItemState,
    linkType: joined.link.linkType,
    createdAt: joined.link.createdAt.toISOString(),
  };
}
