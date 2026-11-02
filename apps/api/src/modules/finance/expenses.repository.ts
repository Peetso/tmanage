import { and, desc, eq, gte, inArray, isNull, lt, lte, ne, or } from 'drizzle-orm';
import { isCustomRoleId } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  customRoles,
  expenses,
  fileAssets,
  fileVersions,
  memberships,
  orgSettings,
  projectMemberships,
  projects,
} from '../../common/database/schema.js';
import type { ExpenseRow } from '../../common/database/schema.js';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { ExpenseQuery } from './expenses-rules.js';

/**
 * 52-07 — storage for `expenses` (0292) and the few reads around it (receipt asset, threshold
 * setting, approvers). Every statement carries the `organization_id` predicate; another
 * organization's row is simply absent. No policy here.
 */

export interface ReceiptAsset {
  readonly ownerUserId: string;
  readonly purpose: string;
  readonly deleted: boolean;
  readonly versionId: string | null;
}

export interface ApproverCandidate {
  readonly userId: string;
  readonly role: string;
  readonly customCapabilitiesJson: string | null;
}

export type ExpenseChange = Partial<
  Omit<ExpenseRow, 'id' | 'organizationId' | 'membershipId' | 'createdAt'>
>;

export class ExpensesRepository {
  async insert(runner: TenantQueryRunner, row: ExpenseRow): Promise<void> {
    await tenantDrizzle(runner).insert(expenses).values(row);
  }

  async find(
    runner: TenantQueryRunner,
    organizationId: string,
    id: string,
    lock = false,
  ): Promise<ExpenseRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(expenses)
      .where(and(eq(expenses.organizationId, organizationId), eq(expenses.id, id)))
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async update(
    runner: TenantQueryRunner,
    organizationId: string,
    id: string,
    change: ExpenseChange,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(expenses)
      .set(change)
      .where(and(eq(expenses.organizationId, organizationId), eq(expenses.id, id)));
  }

  async remove(runner: TenantQueryRunner, organizationId: string, id: string): Promise<void> {
    await tenantDrizzle(runner)
      .delete(expenses)
      .where(and(eq(expenses.organizationId, organizationId), eq(expenses.id, id)));
  }

  /** Newest first by id (uuidv7); `ownMembershipId` narrows to one member's rows. */
  async list(
    runner: TenantQueryRunner,
    organizationId: string,
    filter: ExpenseQuery,
    ownMembershipId: string | null,
    limit: number,
  ): Promise<readonly ExpenseRow[]> {
    const predicates = [eq(expenses.organizationId, organizationId)];
    if (ownMembershipId !== null) predicates.push(eq(expenses.membershipId, ownMembershipId));
    if (filter.projectId !== null) predicates.push(eq(expenses.projectId, filter.projectId));
    if (filter.state !== null) predicates.push(eq(expenses.state, filter.state));
    if (filter.billable !== null) predicates.push(eq(expenses.billable, filter.billable));
    if (filter.from !== null) predicates.push(gte(expenses.spentOn, filter.from));
    if (filter.to !== null) predicates.push(lte(expenses.spentOn, filter.to));
    if (filter.cursor !== null) predicates.push(lt(expenses.id, filter.cursor));
    return tenantDrizzle(runner)
      .select()
      .from(expenses)
      .where(and(...predicates))
      .orderBy(desc(expenses.id))
      .limit(limit);
  }

  /** The receipt upload and its newest version, or `null` when this tenant holds no such file. */
  async receiptAsset(
    runner: TenantQueryRunner,
    organizationId: string,
    assetId: string,
  ): Promise<ReceiptAsset | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({
        ownerUserId: fileAssets.ownerUserId,
        purpose: fileAssets.purpose,
        deletedAt: fileAssets.deletedAt,
      })
      .from(fileAssets)
      .where(and(eq(fileAssets.organizationId, organizationId), eq(fileAssets.id, assetId)))
      .limit(1);
    const asset = rows[0];
    if (!asset) return null;
    const versions = await db
      .select({ id: fileVersions.id })
      .from(fileVersions)
      .where(
        and(eq(fileVersions.organizationId, organizationId), eq(fileVersions.fileAssetId, assetId)),
      )
      .orderBy(desc(fileVersions.versionNo))
      .limit(1);
    return {
      ownerUserId: asset.ownerUserId,
      purpose: asset.purpose,
      deleted: asset.deletedAt !== null,
      versionId: versions[0]?.id ?? null,
    };
  }

  /**
   * Another expense since `since` whose receipt version has the same content hash as `versionId`;
   * `null` when the version has no hash (the check is skipped) or none matches.
   */
  async duplicateOf(
    runner: TenantQueryRunner,
    organizationId: string,
    expenseId: string,
    versionId: string,
    since: Date,
  ): Promise<string | null> {
    const db = tenantDrizzle(runner);
    const own = await db
      .select({ hash: fileVersions.contentHash })
      .from(fileVersions)
      .where(and(eq(fileVersions.organizationId, organizationId), eq(fileVersions.id, versionId)))
      .limit(1);
    const hash = own[0]?.hash ?? null;
    if (hash === null || hash === '') return null;
    const rows = await db
      .select({ id: expenses.id })
      .from(expenses)
      .innerJoin(
        fileVersions,
        and(
          eq(fileVersions.organizationId, expenses.organizationId),
          eq(fileVersions.id, expenses.receiptFileVersionId),
        ),
      )
      .where(
        and(
          eq(expenses.organizationId, organizationId),
          ne(expenses.id, expenseId),
          gte(expenses.createdAt, since),
          eq(fileVersions.contentHash, hash),
        ),
      )
      .orderBy(desc(expenses.id))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async setting(
    runner: TenantQueryRunner,
    organizationId: string,
    key: string,
  ): Promise<string | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ value: orgSettings.settingValue })
      .from(orgSettings)
      .where(and(eq(orgSettings.organizationId, organizationId), eq(orgSettings.settingKey, key)))
      .limit(1);
    return rows[0]?.value;
  }

  async membershipUser(
    runner: TenantQueryRunner,
    organizationId: string,
    membershipId: string,
  ): Promise<string | null> {
    const rows = await tenantDrizzle(runner)
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.id, membershipId)))
      .limit(1);
    return rows[0]?.userId ?? null;
  }

  /**
   * Active internal members with a relation to `projectId` (org-wide scope, the project's
   * workspace, or a project membership); every active member when `projectId` is null. The caller
   * keeps those whose role holds the approving capability.
   */
  async approverCandidates(
    runner: TenantQueryRunner,
    organizationId: string,
    projectId: string | null,
  ): Promise<readonly ApproverCandidate[]> {
    const db = tenantDrizzle(runner);
    const active = and(
      eq(memberships.organizationId, organizationId),
      eq(memberships.status, 'active'),
      isNull(memberships.platformSupportSessionId),
    );
    let where = active;
    if (projectId !== null) {
      const project = await db
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(and(eq(projects.organizationId, organizationId), eq(projects.id, projectId)))
        .limit(1);
      const onProject = (
        await db
          .select({ userId: projectMemberships.userId })
          .from(projectMemberships)
          .where(
            and(
              eq(projectMemberships.organizationId, organizationId),
              eq(projectMemberships.projectId, projectId),
            ),
          )
          .limit(500)
      ).map((row) => row.userId);
      const workspaceId = project[0]?.workspaceId ?? null;
      const relations = [eq(memberships.hasOrgWideScope, true)];
      if (onProject.length > 0) relations.push(inArray(memberships.userId, onProject));
      if (workspaceId !== null) relations.push(eq(memberships.workspaceScopeId, workspaceId));
      where = and(active, or(...relations));
    }
    const rows = await db
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(where)
      .limit(500);
    const customIds = [
      ...new Set(rows.map((row) => row.role.toLowerCase()).filter(isCustomRoleId)),
    ];
    const custom = new Map<string, string>();
    if (customIds.length > 0) {
      const roleRows = await db
        .select({ id: customRoles.id, capabilitiesJson: customRoles.capabilitiesJson })
        .from(customRoles)
        .where(
          and(eq(customRoles.organizationId, organizationId), inArray(customRoles.id, customIds)),
        );
      for (const row of roleRows) custom.set(row.id, row.capabilitiesJson);
    }
    return rows.map((row) => ({
      userId: row.userId,
      role: row.role,
      customCapabilitiesJson: custom.get(row.role.toLowerCase()) ?? null,
    }));
  }
}
