import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  approvals,
  clientMemberships,
  clientOrganizations,
  deliverables,
  fileAssets,
  fileVersions,
  projectClients,
  users,
} from '../../common/database/schema.js';
import type {
  ApprovalRow,
  DeliverableRow,
  FileAssetRow,
  FileVersionRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 0211 (audit gap 1). The deliverable aggregate and the few reads "send for approval" needs.
 *
 * `ClientRequestsRepository`'s shape: `TenantContext` is the scoping parameter, no input carries an
 * `organizationId`, and a scoped read returns another tenant's row as absent. No delete: approvals
 * and client projections refer to a deliverable, and both are append-only.
 */

export class DeliverableNotFoundError extends Error {
  constructor(readonly deliverableId: string) {
    super(`Deliverable ${deliverableId} was not found`);
    this.name = 'DeliverableNotFoundError';
  }
}

export interface CreateDeliverableInput {
  readonly projectId: string;
  readonly title: string;
  readonly description: string | null;
  readonly createdByUserId: string;
}

/** A client person on the project, with the role the approver picker filters on. */
export interface ClientPersonRow {
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  readonly clientOrganizationId: string;
  readonly clientOrganizationName: string;
}

export class DeliverablesRepository {
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateDeliverableInput,
  ): Promise<DeliverableRow> {
    const id = uuidv7();
    const now = new Date();
    await tenantDrizzle(runner).insert(deliverables).values({
      id,
      organizationId: context.organizationId,
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    });
    return this.requireById(runner, context, id);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableId: string,
  ): Promise<DeliverableRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(deliverables)
      .where(
        and(
          eq(deliverables.organizationId, context.organizationId),
          eq(deliverables.id, deliverableId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * A live deliverable, or {@link DeliverableNotFoundError}: a deleted one (FIX6 item 8) is absent
   * to every action but restore, which reads {@link findById}.
   */
  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableId: string,
  ): Promise<DeliverableRow> {
    const found = await this.findById(runner, context, deliverableId);
    if (!found || found.deletedAt !== null) throw new DeliverableNotFoundError(deliverableId);
    return found;
  }

  /** FIX6 item 8: delete (a date and who) or restore (`null`) one deliverable. */
  async setDeleted(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableId: string,
    deleted: { readonly at: Date; readonly byUserId: string } | null,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(deliverables)
      .set({ deletedAt: deleted?.at ?? null, deletedByUserId: deleted?.byUserId ?? null })
      .where(
        and(
          eq(deliverables.organizationId, context.organizationId),
          eq(deliverables.id, deliverableId),
        ),
      );
  }

  async listByProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly DeliverableRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(deliverables)
      .where(
        and(
          eq(deliverables.organizationId, context.organizationId),
          eq(deliverables.projectId, projectId),
          isNull(deliverables.deletedAt),
        ),
      )
      .orderBy(desc(deliverables.updatedAt), desc(deliverables.id));
  }

  /** Bump `updated_at` when a version lands, so the project list sorts by latest activity. */
  async touch(runner: TenantQueryRunner, context: TenantContext, deliverableId: string) {
    await tenantDrizzle(runner)
      .update(deliverables)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(deliverables.organizationId, context.organizationId),
          eq(deliverables.id, deliverableId),
        ),
      );
  }

  /** Every approval opened on any version of this deliverable, newest first. */
  async approvalsFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableId: string,
  ): Promise<readonly ApprovalRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.organizationId, context.organizationId),
          eq(approvals.deliverableId, deliverableId),
        ),
      )
      .orderBy(desc(approvals.createdAt), desc(approvals.id));
  }

  /** A file asset in this tenant with its newest version (null when nothing was uploaded yet). */
  async fileWithLatestVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
  ): Promise<{ readonly asset: FileAssetRow; readonly version: FileVersionRow | null } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ asset: fileAssets, version: fileVersions })
      .from(fileAssets)
      .leftJoin(
        fileVersions,
        and(
          eq(fileVersions.organizationId, fileAssets.organizationId),
          eq(fileVersions.fileAssetId, fileAssets.id),
        ),
      )
      .where(
        and(eq(fileAssets.organizationId, context.organizationId), eq(fileAssets.id, fileAssetId)),
      )
      .orderBy(desc(fileVersions.versionNo))
      .limit(1)
      // Security review L2: lock the file row, as the file delete does, so attaching a file and
      // deleting it cannot both pass their checks at the same moment.
      .for('update');
    const row = rows[0];
    return row ? { asset: row.asset, version: row.version ?? null } : null;
  }

  /**
   * The active client people on a project — the same set the worker's client-action notice reads
   * (client memberships whose client organization the project is shared with). The caller filters
   * on the role's `approval.decide`.
   */
  async clientPeopleFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly ClientPersonRow[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({
        userId: clientMemberships.userId,
        displayName: users.displayName,
        role: clientMemberships.role,
        clientOrganizationId: clientMemberships.clientOrganizationId,
        clientOrganizationName: clientOrganizations.name,
      })
      .from(clientMemberships)
      .innerJoin(
        projectClients,
        and(
          eq(projectClients.organizationId, clientMemberships.organizationId),
          eq(projectClients.clientOrganizationId, clientMemberships.clientOrganizationId),
        ),
      )
      .innerJoin(users, eq(users.id, clientMemberships.userId))
      .innerJoin(
        clientOrganizations,
        and(
          eq(clientOrganizations.organizationId, clientMemberships.organizationId),
          eq(clientOrganizations.id, clientMemberships.clientOrganizationId),
        ),
      )
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          eq(projectClients.projectId, projectId),
          eq(clientMemberships.status, 'active'),
          or(isNull(clientMemberships.expiresAt), gt(clientMemberships.expiresAt, sql`NOW(3)`)),
        ),
      )
      .orderBy(users.displayName);
    return rows;
  }
}
