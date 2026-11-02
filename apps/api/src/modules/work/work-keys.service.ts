import { authorize, formatWorkKey, normalizeWorkKeyPrefix } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemCodeLinkRow, WorkItemRow } from '../../common/database/schema.js';
import { AuditEventsRepository } from '../audit/audit-events.repository.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkKeysRepository } from './work-keys.repository.js';

/**
 * R16-e (54-10 GitHub Phase 0) — work keys and the code links on a work item.
 *
 * - `setPrefix` (`project.manage`): a prefix is unique per organization (409 `prefix_taken`) and,
 *   once set, fixed (409 `work_key_prefix_locked`): keys are typed into commits and branch names,
 *   so renaming them would orphan every reference already pushed. Setting it backfills keys for
 *   the project's items, oldest first, in batches of 500, each batch one transaction that reserves
 *   its numbers on the atomic counter.
 * - `listLinks` (`work.read`) / `removeLink` (`work.update`): internal members only. A client
 *   principal is a 404 whatever the item's audience — code links are never in a client projection.
 */

export const WORK_KEY_BACKFILL_BATCH = 500;
/** 200 batches = 100 000 items; a larger project finishes on its next PUT (idempotent). */
const MAX_BACKFILL_BATCHES = 200;

export interface CodeLinkView {
  readonly id: string;
  readonly provider: string;
  readonly repo: string;
  readonly kind: string;
  readonly externalId: string;
  readonly title: string | null;
  readonly state: string | null;
  readonly url: string;
  readonly actorLogin: string | null;
  readonly updatedAt: string;
}

/** An explicit projection: a column added later is invisible until named here. */
export function toCodeLinkView(row: WorkItemCodeLinkRow): CodeLinkView {
  return {
    id: row.id,
    provider: row.provider,
    repo: row.repoFullName,
    kind: row.linkKind,
    externalId: row.externalId,
    title: row.title ?? null,
    state: row.state ?? null,
    url: row.url,
    actorLogin: row.actorLogin ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Give a new work item its key when its project has a prefix; a no-op otherwise. Called from
 * `WorkItemsService.create()` inside the create transaction, right after the insert. A unit of
 * work without a query runner (the service suites' bare doubles) has nothing to key.
 */
export async function ensureWorkKey(
  runner: TenantQueryRunner,
  context: TenantContext,
  workItemId: string,
  keys: WorkKeysRepository = new WorkKeysRepository(),
): Promise<string | null> {
  if (typeof (runner as Partial<TenantQueryRunner>).query !== 'function') return null;
  const item = await keys.findItem(runner, context, workItemId);
  if (!item) return null;
  if (item.workKey !== null) return item.workKey;
  const project = await keys.findProject(runner, context, item.projectId);
  if (!project?.workKeyPrefix) return null;
  const number = await keys.reserve(runner, context, project.id, 1);
  const workKey = formatWorkKey(project.workKeyPrefix, number);
  await keys.setWorkKey(runner, context, workItemId, workKey);
  return workKey;
}

/** MySQL / MariaDB duplicate key, directly or on Drizzle's `.cause`. */
function isDuplicateKey(error: unknown): boolean {
  const marks = (candidate: unknown): boolean =>
    typeof candidate === 'object' &&
    candidate !== null &&
    ((candidate as { errno?: number }).errno === 1062 ||
      (candidate as { code?: string }).code === 'ER_DUP_ENTRY');
  return (
    marks(error) ||
    (typeof error === 'object' && error !== null && marks((error as { cause?: unknown }).cause))
  );
}

export interface WorkKeysDeps {
  readonly audit?: Pick<AuditEventsRepository, 'append'>;
}

export class WorkKeysService {
  private readonly audit: Pick<AuditEventsRepository, 'append'>;

  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: Pick<WorkItemsRepository, 'findById'>,
    private readonly keys: WorkKeysRepository = new WorkKeysRepository(),
    deps: WorkKeysDeps = {},
  ) {
    this.audit = deps.audit ?? new AuditEventsRepository();
  }

  async setPrefix(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    rawPrefix: unknown,
  ): Promise<{ readonly projectId: string; readonly prefix: string; readonly keyed: number }> {
    const prefix = normalizeWorkKeyPrefix(rawPrefix);
    if (prefix === null) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        {
          field: 'prefix',
          message: 'must be 2-10 Latin letters or digits, starting with a letter',
        },
      ]);
    }
    const verdict = authorize({
      principal,
      capability: 'project.manage',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) throw this.notFound(verdict.code);

    try {
      await this.database.transaction(context, async (runner) => {
        const project = await this.keys.findProject(runner, context, projectId, true);
        if (!project || project.archivedAt !== null) throw this.notFound();
        if (project.workKeyPrefix === prefix) return;
        if (project.workKeyPrefix !== null) {
          throw new ApiError(
            409,
            'conflict',
            'This project already has a work key prefix',
            undefined,
            'work_key_prefix_locked',
          );
        }
        if ((await this.keys.projectWithPrefix(runner, context, prefix)) !== null) {
          throw this.prefixTaken();
        }
        await this.keys.setPrefix(runner, context, projectId, prefix);
        await this.audit.append(runner, context, {
          action: 'project.work_key_prefix_set',
          result: 'allowed',
          objectId: projectId,
          metadata: { prefix },
        });
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw this.prefixTaken();
      throw error;
    }
    return { projectId, prefix, keyed: await this.backfill(context, projectId, prefix) };
  }

  /** Key the project's unkeyed items, oldest first. Returns how many were keyed. */
  async backfill(context: TenantContext, projectId: string, prefix: string): Promise<number> {
    let keyed = 0;
    for (let batch = 0; batch < MAX_BACKFILL_BATCHES; batch += 1) {
      const count = await this.database.transaction(context, async (runner) => {
        const ids = await this.keys.unkeyedItems(
          runner,
          context,
          projectId,
          WORK_KEY_BACKFILL_BATCH,
        );
        if (ids.length === 0) return 0;
        const first = await this.keys.reserve(runner, context, projectId, ids.length);
        for (const [index, id] of ids.entries()) {
          await this.keys.setWorkKey(runner, context, id, formatWorkKey(prefix, first + index));
        }
        return ids.length;
      });
      keyed += count;
      if (count < WORK_KEY_BACKFILL_BATCH) break;
    }
    return keyed;
  }

  async listLinks(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<{ readonly workKey: string | null; readonly links: readonly CodeLinkView[] }> {
    return this.database.read(context, async (runner) => {
      await this.readableItem(runner, context, principal, workItemId);
      const [item, rows] = await Promise.all([
        this.keys.findItem(runner, context, workItemId),
        this.keys.listLinks(runner, context, workItemId),
      ]);
      return { workKey: item?.workKey ?? null, links: rows.map(toCodeLinkView) };
    });
  }

  async removeLink(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    linkId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (runner) => {
      const item = await this.readableItem(runner, context, principal, workItemId);
      const verdict = authorize({
        principal,
        capability: 'work.update',
        resource: resourceOf(item),
      });
      if (!verdict.allowed) {
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
      }
      const link = await this.keys.findLink(runner, context, workItemId, linkId);
      if (!link) throw this.notFound('code_link_not_found');
      await this.keys.removeLink(runner, context, linkId);
      await this.audit.append(runner, context, {
        action: 'work_item.code_link_removed',
        result: 'allowed',
        objectId: workItemId,
        metadata: { link_id: linkId, link_kind: link.linkKind, provider: link.provider },
      });
    });
  }

  /** Internal members who may read the item; a client or an unreadable item is the same 404. */
  private async readableItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRow> {
    if (principal.kind !== 'internal') throw this.notFound();
    const row = await this.workItems.findById(runner, context, workItemId);
    if (
      !row ||
      row.deletedAt !== null ||
      !authorize({ principal, capability: 'work.read', resource: resourceOf(row) }).allowed
    ) {
      throw this.notFound();
    }
    return row;
  }

  private prefixTaken(): ApiError {
    return new ApiError(
      409,
      'conflict',
      'Another project already uses this prefix',
      undefined,
      'prefix_taken',
    );
  }

  private notFound(code?: string): ApiError {
    return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, code);
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
