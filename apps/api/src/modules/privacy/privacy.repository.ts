import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  memberProfiles,
  memberships,
  organizations,
  privacyDeletionRequests,
  privacyExports,
  users,
} from '../../common/database/schema.js';
import type { PrivacyDeletionRequestRow, PrivacyExportRow } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * D5 (Figma F5, 0231) — the SQL of the data-rights workflow: the two privacy tables, the
 * organization and member reads the Privacy page shows, and the two writes a deletion carries out
 * (offboard one membership; close the organization). Every tenant statement carries the
 * organization predicate from the context; the three cross-tenant "which organizations have work"
 * questions run through `bootstrapRead` with a declared table list.
 */

export type PrivacyExportKind = PrivacyExportRow['kind'];
export type PrivacyDeletionKind = PrivacyDeletionRequestRow['kind'];

/** One internal member, as the "Export a member's data" picker lists them. */
export interface PrivacyMemberRow {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly jobTitle: string | null;
  readonly role: string;
  readonly status: string;
}

export class PrivacyRepository {
  /** The acting organization (id + name), or undefined when it does not resolve in this tenant. */
  async organization(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<{ readonly id: string; readonly name: string } | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .limit(1);
    return rows[0];
  }

  /** Every active internal member with their name and job title, alphabetical. */
  async activeMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly PrivacyMemberRow[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        displayName: users.displayName,
        jobTitle: memberProfiles.jobTitle,
        role: memberships.role,
        status: memberships.status,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(
        memberProfiles,
        and(
          eq(memberProfiles.organizationId, memberships.organizationId),
          eq(memberProfiles.userId, memberships.userId),
        ),
      )
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
        ),
      )
      .orderBy(asc(users.displayName), asc(memberships.id));
    return rows.map((row) => ({ ...row, jobTitle: row.jobTitle ?? null }));
  }

  /** Names for a set of user ids (requesters, subjects). Unknown ids are simply absent. */
  async displayNames(
    runner: TenantQueryRunner,
    context: TenantContext,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({ userId: memberships.userId, displayName: users.displayName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          inArray(memberships.userId, ids),
        ),
      );
    return new Map(rows.map((row) => [row.userId, row.displayName] as const));
  }

  async findExport(
    runner: TenantQueryRunner,
    context: TenantContext,
    exportId: string,
  ): Promise<PrivacyExportRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(privacyExports)
      .where(
        and(
          eq(privacyExports.organizationId, context.organizationId),
          eq(privacyExports.id, exportId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** Exports of one kind, newest first. `subjectUserId`/`requestedBy` narrow it when given. */
  async listExports(
    runner: TenantQueryRunner,
    context: TenantContext,
    filter: {
      readonly kind: PrivacyExportKind;
      readonly subjectUserId?: string;
      readonly requestedByUserId?: string;
      readonly limit: number;
    },
  ): Promise<readonly PrivacyExportRow[]> {
    const conditions = [
      eq(privacyExports.organizationId, context.organizationId),
      eq(privacyExports.kind, filter.kind),
    ];
    if (filter.subjectUserId !== undefined) {
      conditions.push(eq(privacyExports.subjectUserId, filter.subjectUserId));
    }
    if (filter.requestedByUserId !== undefined) {
      conditions.push(eq(privacyExports.requestedByUserId, filter.requestedByUserId));
    }
    return tenantDrizzle(runner)
      .select()
      .from(privacyExports)
      .where(and(...conditions))
      .orderBy(desc(privacyExports.requestedAt), desc(privacyExports.id))
      .limit(filter.limit);
  }

  async insertExport(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly kind: PrivacyExportKind;
      readonly subjectUserId: string | null;
      readonly requestedByUserId: string;
      readonly now: Date;
    },
  ): Promise<string> {
    const id = uuidv7();
    await tenantDrizzle(runner).insert(privacyExports).values({
      id,
      organizationId: context.organizationId,
      kind: input.kind,
      subjectUserId: input.subjectUserId,
      requestedByUserId: input.requestedByUserId,
      status: 'preparing',
      progressPercent: 0,
      requestedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    });
    return id;
  }

  /**
   * Serialise this organization's privacy writes: a locking read of its own row, so two "request
   * deletion" calls cannot both see no active request and both insert one. Drizzle's proxy dialect
   * has no `.for('update')`, so the statement is written out (the conversations allocator's form).
   */
  async lockOrganization(runner: TenantQueryRunner, context: TenantContext): Promise<boolean> {
    const rows = await runner.execute(`select id from organizations where id = ? for update`, [
      context.organizationId,
    ]);
    return rows.length === 1;
  }

  /** The active (scheduled) deletion of this kind for this subject. */
  async activeDeletion(
    runner: TenantQueryRunner,
    context: TenantContext,
    kind: PrivacyDeletionKind,
    subjectUserId: string | null,
  ): Promise<PrivacyDeletionRequestRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(privacyDeletionRequests)
      .where(
        and(
          eq(privacyDeletionRequests.organizationId, context.organizationId),
          eq(privacyDeletionRequests.kind, kind),
          eq(privacyDeletionRequests.status, 'scheduled'),
          subjectUserId === null
            ? isNull(privacyDeletionRequests.subjectUserId)
            : eq(privacyDeletionRequests.subjectUserId, subjectUserId),
        ),
      )
      .orderBy(desc(privacyDeletionRequests.requestedAt))
      .limit(1);
    return rows[0];
  }

  async insertDeletion(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly kind: PrivacyDeletionKind;
      readonly subjectUserId: string | null;
      readonly requestedByUserId: string;
      readonly now: Date;
      readonly scheduledFor: Date;
    },
  ): Promise<string> {
    const id = uuidv7();
    await tenantDrizzle(runner).insert(privacyDeletionRequests).values({
      id,
      organizationId: context.organizationId,
      kind: input.kind,
      subjectUserId: input.subjectUserId,
      requestedByUserId: input.requestedByUserId,
      status: 'scheduled',
      requestedAt: input.now,
      scheduledFor: input.scheduledFor,
      createdAt: input.now,
      updatedAt: input.now,
    });
    return id;
  }

  /** `scheduled → cancelled`, conditional on the version read. True when this call moved it. */
  async cancelDeletion(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: PrivacyDeletionRequestRow,
    cancelledByUserId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(privacyDeletionRequests)
      .set({
        status: 'cancelled',
        cancelledAt: now,
        cancelledByUserId,
        version: sql`${privacyDeletionRequests.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(privacyDeletionRequests.organizationId, context.organizationId),
          eq(privacyDeletionRequests.id, row.id),
          eq(privacyDeletionRequests.status, 'scheduled'),
          eq(privacyDeletionRequests.version, row.version),
        ),
      );
    return affected(result) === 1;
  }

  /** How many active owners the organization has (the last-owner rule). */
  async activeOwnerCount(runner: TenantQueryRunner, context: TenantContext): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ count: sql<number>`count(*)` })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.role, 'owner'),
          eq(memberships.status, 'active'),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }

  // ── The privacy job's statements ──────────────────────────────────────────────────────────────

  /** Organizations holding an export to build (unclaimed or with a stale claim). Cross-tenant. */
  async organizationsWithPreparingExports(
    runner: BootstrapQueryRunner,
    staleBefore: Date,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ organizationId: privacyExports.organizationId })
      .from(privacyExports)
      .where(
        and(
          eq(privacyExports.status, 'preparing'),
          or(isNull(privacyExports.claimedAt), lt(privacyExports.claimedAt, staleBefore)),
        ),
      )
      .orderBy(asc(privacyExports.organizationId));
    return rows.map((row) => row.organizationId);
  }

  /** Organizations holding a ready archive whose link has expired and whose bytes remain. */
  async organizationsWithExpiredExports(
    runner: BootstrapQueryRunner,
    now: Date,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ organizationId: privacyExports.organizationId })
      .from(privacyExports)
      .where(
        and(
          eq(privacyExports.status, 'ready'),
          isNull(privacyExports.purgedAt),
          isNotNull(privacyExports.expiresAt),
          lte(privacyExports.expiresAt, now),
        ),
      )
      .orderBy(asc(privacyExports.organizationId));
    return rows.map((row) => row.organizationId);
  }

  /** Organizations holding a scheduled deletion whose grace period has ended. */
  async organizationsWithDueDeletions(
    runner: BootstrapQueryRunner,
    now: Date,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ organizationId: privacyDeletionRequests.organizationId })
      .from(privacyDeletionRequests)
      .where(
        and(
          eq(privacyDeletionRequests.status, 'scheduled'),
          lte(privacyDeletionRequests.scheduledFor, now),
        ),
      )
      .orderBy(asc(privacyDeletionRequests.organizationId));
    return rows.map((row) => row.organizationId);
  }

  async listClaimableExports(
    runner: TenantQueryRunner,
    context: TenantContext,
    staleBefore: Date,
    limit: number,
  ): Promise<readonly PrivacyExportRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(privacyExports)
      .where(
        and(
          eq(privacyExports.organizationId, context.organizationId),
          eq(privacyExports.status, 'preparing'),
          or(isNull(privacyExports.claimedAt), lt(privacyExports.claimedAt, staleBefore)),
        ),
      )
      .orderBy(asc(privacyExports.requestedAt), asc(privacyExports.id))
      .limit(limit);
  }

  /** Take the claim on a preparing export, conditional on the version read. */
  async claimExport(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: PrivacyExportRow,
    now: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(privacyExports)
      .set({
        claimedAt: now,
        progressPercent: 5,
        version: sql`${privacyExports.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(privacyExports.organizationId, context.organizationId),
          eq(privacyExports.id, row.id),
          eq(privacyExports.status, 'preparing'),
          eq(privacyExports.version, row.version),
        ),
      );
    return affected(result) === 1;
  }

  async setProgress(
    runner: TenantQueryRunner,
    context: TenantContext,
    exportId: string,
    percent: number,
    now: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(privacyExports)
      .set({ progressPercent: Math.max(0, Math.min(99, Math.round(percent))), updatedAt: now })
      .where(
        and(
          eq(privacyExports.organizationId, context.organizationId),
          eq(privacyExports.id, exportId),
          eq(privacyExports.status, 'preparing'),
        ),
      );
  }

  async markExportReady(
    runner: TenantQueryRunner,
    context: TenantContext,
    exportId: string,
    input: {
      readonly objectKey: string;
      readonly sizeBytes: number;
      readonly scanStatus: 'clean' | 'not_scanned';
      readonly now: Date;
      readonly expiresAt: Date;
    },
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(privacyExports)
      .set({
        status: 'ready',
        progressPercent: 100,
        objectKey: input.objectKey,
        sizeBytes: input.sizeBytes,
        scanStatus: input.scanStatus,
        completedAt: input.now,
        expiresAt: input.expiresAt,
        version: sql`${privacyExports.version} + 1`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(privacyExports.organizationId, context.organizationId),
          eq(privacyExports.id, exportId),
          eq(privacyExports.status, 'preparing'),
        ),
      );
    return affected(result) === 1;
  }

  async markExportFailed(
    runner: TenantQueryRunner,
    context: TenantContext,
    exportId: string,
    failureCode: string,
    now: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(privacyExports)
      .set({
        status: 'failed',
        failureCode,
        completedAt: now,
        version: sql`${privacyExports.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(privacyExports.organizationId, context.organizationId),
          eq(privacyExports.id, exportId),
          eq(privacyExports.status, 'preparing'),
        ),
      );
    return affected(result) === 1;
  }

  /** Ready archives whose bytes should go: expired links, or every one when `all` (company closed). */
  async listPurgeableExports(
    runner: TenantQueryRunner,
    context: TenantContext,
    now: Date,
    all: boolean,
  ): Promise<readonly PrivacyExportRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(privacyExports)
      .where(
        and(
          eq(privacyExports.organizationId, context.organizationId),
          eq(privacyExports.status, 'ready'),
          isNull(privacyExports.purgedAt),
          ...(all ? [] : [isNotNull(privacyExports.expiresAt), lte(privacyExports.expiresAt, now)]),
        ),
      )
      .orderBy(asc(privacyExports.id))
      .limit(200);
  }

  async markExportPurged(
    runner: TenantQueryRunner,
    context: TenantContext,
    exportId: string,
    now: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(privacyExports)
      .set({ purgedAt: now, updatedAt: now })
      .where(
        and(
          eq(privacyExports.organizationId, context.organizationId),
          eq(privacyExports.id, exportId),
        ),
      );
  }

  async listDueDeletions(
    runner: TenantQueryRunner,
    context: TenantContext,
    now: Date,
  ): Promise<readonly PrivacyDeletionRequestRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(privacyDeletionRequests)
      .where(
        and(
          eq(privacyDeletionRequests.organizationId, context.organizationId),
          eq(privacyDeletionRequests.status, 'scheduled'),
          lte(privacyDeletionRequests.scheduledFor, now),
        ),
      )
      .orderBy(asc(privacyDeletionRequests.scheduledFor), asc(privacyDeletionRequests.id))
      .limit(100);
  }

  /** `scheduled → executed`, conditional on the version read. */
  async markDeletionExecuted(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: PrivacyDeletionRequestRow,
    now: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(privacyDeletionRequests)
      .set({
        status: 'executed',
        executedAt: now,
        version: sql`${privacyDeletionRequests.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(privacyDeletionRequests.organizationId, context.organizationId),
          eq(privacyDeletionRequests.id, row.id),
          eq(privacyDeletionRequests.status, 'scheduled'),
          eq(privacyDeletionRequests.version, row.version),
        ),
      );
    return affected(result) === 1;
  }

  /**
   * An account deletion's effect in this studio: the membership is offboarded, so the person can no
   * longer sign in here and their shared work stays, shown as a former member. Bumps the policy
   * version so every cached principal of theirs is rotated at once.
   */
  async offboardMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(memberships)
      .set({
        status: 'offboarded',
        version: sql`${memberships.version} + 1`,
        policyVersion: sql`${memberships.policyVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.userId, userId),
          inArray(memberships.status, ['active', 'suspended']),
        ),
      );
    return affected(result) >= 1;
  }

  /**
   * A company deletion's effect: the organization is archived and suspended, which the membership
   * resolver refuses for every member and client. Idempotent (`archived_at IS NULL`).
   */
  async closeOrganization(
    runner: TenantQueryRunner,
    context: TenantContext,
    now: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(organizations)
      .set({
        archivedAt: now,
        suspendedAt: sql`coalesce(${organizations.suspendedAt}, ${now})`,
        updatedAt: now,
      })
      .where(and(eq(organizations.id, context.organizationId), isNull(organizations.archivedAt)));
    return affected(result) === 1;
  }
}

/** mysql2's ResultSetHeader, as drizzle hands it back from an UPDATE. */
function affected(result: unknown): number {
  const header = Array.isArray(result) ? (result[0] as unknown) : result;
  const rows = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}
