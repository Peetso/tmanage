import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  projectWorkKeys,
  workItemCodeLinks,
  workItemWorkKeys,
} from '../../common/database/schema.js';
import type { CodeLinkKind, WorkItemCodeLinkRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * R16-e (54-10 Phase 0) — storage for work keys (`projects.work_key_prefix` / `work_key_next`,
 * `work_items.work_key`, 0294) and `work_item_code_links`. Every statement carries the
 * `organization_id` from the caller's context; no input names an organization.
 */

export interface ProjectKeyState {
  readonly id: string;
  readonly archivedAt: Date | null;
  readonly workKeyPrefix: string | null;
  readonly workKeyNext: number;
}

export interface NewCodeLink {
  readonly workItemId: string;
  readonly connectionId: string | null;
  readonly repoFullName: string;
  readonly linkKind: CodeLinkKind;
  readonly externalId: string;
  readonly title: string | null;
  readonly state: string | null;
  readonly url: string;
  readonly actorLogin: string | null;
}

const MAX_LINKS_LISTED = 200;

export class WorkKeysRepository {
  async findProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    forUpdate = false,
  ): Promise<ProjectKeyState | null> {
    const query = tenantDrizzle(runner)
      .select({
        id: projectWorkKeys.id,
        archivedAt: projectWorkKeys.archivedAt,
        workKeyPrefix: projectWorkKeys.workKeyPrefix,
        workKeyNext: projectWorkKeys.workKeyNext,
      })
      .from(projectWorkKeys)
      .where(
        and(
          eq(projectWorkKeys.organizationId, context.organizationId),
          eq(projectWorkKeys.id, projectId),
        ),
      )
      .limit(1);
    const rows = forUpdate ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  /** The project already using `prefix` in this organization, or null. */
  async projectWithPrefix(
    runner: TenantQueryRunner,
    context: TenantContext,
    prefix: string,
  ): Promise<string | null> {
    const rows = await tenantDrizzle(runner)
      .select({ id: projectWorkKeys.id })
      .from(projectWorkKeys)
      .where(
        and(
          eq(projectWorkKeys.organizationId, context.organizationId),
          eq(projectWorkKeys.workKeyPrefix, prefix),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /** `prefix` per project id, for the projects in `projectIds` that have one and are not archived. */
  async activePrefixes(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (projectIds.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({ id: projectWorkKeys.id, prefix: projectWorkKeys.workKeyPrefix })
      .from(projectWorkKeys)
      .where(
        and(
          eq(projectWorkKeys.organizationId, context.organizationId),
          inArray(projectWorkKeys.id, [...projectIds]),
          isNull(projectWorkKeys.archivedAt),
        ),
      );
    return new Map(
      rows.flatMap((row) => (row.prefix === null ? [] : [[row.id, row.prefix] as const])),
    );
  }

  async setPrefix(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    prefix: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(projectWorkKeys)
      .set({ workKeyPrefix: prefix })
      .where(
        and(
          eq(projectWorkKeys.organizationId, context.organizationId),
          eq(projectWorkKeys.id, projectId),
        ),
      );
  }

  /**
   * Reserve `count` consecutive numbers on the project's counter and return the first. The
   * UPDATE takes the row lock, so two writers can never be handed the same number.
   */
  async reserve(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    count: number,
  ): Promise<number> {
    await tenantDrizzle(runner)
      .update(projectWorkKeys)
      .set({ workKeyNext: sql`work_key_next + ${count}` })
      .where(
        and(
          eq(projectWorkKeys.organizationId, context.organizationId),
          eq(projectWorkKeys.id, projectId),
        ),
      );
    const project = await this.findProject(runner, context, projectId);
    if (!project) throw new Error(`project ${projectId} vanished while reserving work keys`);
    return project.workKeyNext - count;
  }

  async findItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<{ readonly projectId: string; readonly workKey: string | null } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ projectId: workItemWorkKeys.projectId, workKey: workItemWorkKeys.workKey })
      .from(workItemWorkKeys)
      .where(
        and(
          eq(workItemWorkKeys.organizationId, context.organizationId),
          eq(workItemWorkKeys.id, workItemId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The project's items without a key, oldest first. */
  async unkeyedItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    limit: number,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .select({ id: workItemWorkKeys.id })
      .from(workItemWorkKeys)
      .where(
        and(
          eq(workItemWorkKeys.organizationId, context.organizationId),
          eq(workItemWorkKeys.projectId, projectId),
          isNull(workItemWorkKeys.workKey),
        ),
      )
      .orderBy(asc(workItemWorkKeys.createdAt), asc(workItemWorkKeys.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async setWorkKey(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    workKey: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(workItemWorkKeys)
      .set({ workKey })
      .where(
        and(
          eq(workItemWorkKeys.organizationId, context.organizationId),
          eq(workItemWorkKeys.id, workItemId),
          isNull(workItemWorkKeys.workKey),
        ),
      );
  }

  /** Live items whose key is one of `keys`, inside `projectIds` only. */
  async resolveKeys(
    runner: TenantQueryRunner,
    context: TenantContext,
    keys: readonly string[],
    projectIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (keys.length === 0 || projectIds.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({ id: workItemWorkKeys.id, workKey: workItemWorkKeys.workKey })
      .from(workItemWorkKeys)
      .where(
        and(
          eq(workItemWorkKeys.organizationId, context.organizationId),
          inArray(workItemWorkKeys.workKey, [...keys]),
          inArray(workItemWorkKeys.projectId, [...projectIds]),
          isNull(workItemWorkKeys.deletedAt),
        ),
      );
    return new Map(rows.map((row) => [row.workKey ?? '', row.id] as const));
  }

  async listLinks(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<readonly WorkItemCodeLinkRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemCodeLinks)
      .where(
        and(
          eq(workItemCodeLinks.organizationId, context.organizationId),
          eq(workItemCodeLinks.workItemId, workItemId),
        ),
      )
      .orderBy(desc(workItemCodeLinks.updatedAt), desc(workItemCodeLinks.id))
      .limit(MAX_LINKS_LISTED);
  }

  async findLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    linkId: string,
  ): Promise<WorkItemCodeLinkRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemCodeLinks)
      .where(
        and(
          eq(workItemCodeLinks.organizationId, context.organizationId),
          eq(workItemCodeLinks.workItemId, workItemId),
          eq(workItemCodeLinks.id, linkId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async removeLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(workItemCodeLinks)
      .where(
        and(
          eq(workItemCodeLinks.organizationId, context.organizationId),
          eq(workItemCodeLinks.id, linkId),
        ),
      );
  }

  /** Insert, or refresh title / state / url / actor on the UNIQUE (item, provider, kind, id). */
  async upsertLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    link: NewCodeLink,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(workItemCodeLinks)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        workItemId: link.workItemId,
        connectionId: link.connectionId,
        provider: 'github',
        repoFullName: link.repoFullName,
        linkKind: link.linkKind,
        externalId: link.externalId,
        title: link.title,
        state: link.state,
        url: link.url,
        actorLogin: link.actorLogin,
        updatedAt: at,
        createdAt: at,
      })
      .onDuplicateKeyUpdate({
        set: {
          title: link.title,
          state: link.state,
          url: link.url,
          actorLogin: link.actorLogin,
          updatedAt: at,
        },
      });
  }

  /** Remove the branch links named `branch` in `repoFullName` (a GitHub `delete` event). */
  async removeBranchLinks(
    runner: TenantQueryRunner,
    context: TenantContext,
    repoFullName: string,
    branch: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(workItemCodeLinks)
      .where(
        and(
          eq(workItemCodeLinks.organizationId, context.organizationId),
          eq(workItemCodeLinks.provider, 'github'),
          eq(workItemCodeLinks.repoFullName, repoFullName),
          eq(workItemCodeLinks.linkKind, 'branch'),
          eq(workItemCodeLinks.externalId, branch),
        ),
      );
  }
}
