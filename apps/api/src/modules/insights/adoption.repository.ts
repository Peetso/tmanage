import { and, eq, gte, inArray, isNotNull, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  approvals,
  clientRequests,
  conversations,
  decisions,
  deliverableVersions,
  fileAssets,
  meetings,
  memberships,
  messages,
  messageWorkLinks,
  projects,
  workItems,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * INS-06's read seam — the org-wide adoption roll-up.
 *
 * "Adoption" is the audit's plain question: is the studio actually using the product? INS-06 answers
 * it with three org-level facts, all already stored — how many people hold an active membership, how
 * many of them have created any work lately, and how many meetings the studio has held lately. It is
 * the org-level counterpart to INS-05's per-project workload roll-up (x123), and like it owns no
 * table and adds no column: a pure read, computed on demand, no write, no schedule, no migration.
 *
 * ## Read-only over existing data
 *
 * Each read is a tenant-scoped `SELECT` over a table another module owns — `memberships` (tenancy),
 * `work_items` (work, x88's), `meetings` (calendar, x90's) — and nothing here writes. The reads
 * carry **no policy**: the org-level `work.read` gate and the belt-and-braces tenant re-check live in
 * the controller, exactly as INS-05 keeps `authorize()` out of `WorkloadRepository`. The two
 * activity reads take a `windowDays` bound the controller has already clamped to `[1, 90]`; the
 * window boundary is computed in SQL against `now(3)` so no client clock or session time zone enters
 * the count.
 *
 * ## Tenancy is enforced in SQL, and re-checked above
 *
 * Every read filters on `organization_id = context.organizationId`, so a cross-tenant row is never
 * returned in production. Each row still carries its `organizationId` so the controller can drop a
 * foreign row belt-and-braces before it contributes to a count — the FAST-PROTOCOL Known-trap
 * (scope before the count), the same defence INS-05 applies per project.
 */

/** One active membership — the org it belongs to and the user it names. No `View` suffix: not a wire projection. */
export interface AdoptionMemberRow {
  readonly organizationId: string;
  readonly userId: string;
}

/** One recent work item's owner — the org it belongs to and the user who owns it. */
export interface AdoptionWorkOwnerRow {
  readonly organizationId: string;
  readonly ownerUserId: string | null;
}

/** One meeting held in the window — the org it belongs to and its id. */
export interface AdoptionMeetingRow {
  readonly organizationId: string;
  readonly meetingId: string;
}

/** One work item created in the last two windows: whether it is in the current one, and whether it carries a date. */
export interface AdoptionDatedWorkRow {
  readonly organizationId: string;
  readonly inWindow: boolean;
  readonly dated: boolean;
}

/** One channel (conversation) — live, or one that has had work created from it. */
export interface AdoptionChannelRow {
  readonly organizationId: string;
  readonly conversationId: string;
}

/** One approval requested in the last two windows, with the hash it was sent with. */
export interface AdoptionApprovalHashRow {
  readonly organizationId: string;
  readonly deliverableId: string;
  readonly deliverableVersionId: string;
  readonly contentHash: string;
  readonly inWindow: boolean;
}

/** One deliverable version's stored hash. */
export interface AdoptionVersionHashRow {
  readonly organizationId: string;
  readonly versionId: string;
  readonly contentHash: string;
}

/** A row that names the project it belongs to — the shape every data-gap read returns. */
export interface AdoptionGapRow {
  readonly organizationId: string;
  readonly projectId: string;
}

/** A project's display name, for a gap that sits in a single project. */
export interface AdoptionProjectNameRow {
  readonly organizationId: string;
  readonly projectId: string;
  readonly name: string;
}

/** Request states that are finished — a request in one of these needs no committed answer. */
const CLOSED_REQUEST_STATES = ['declined', 'delivered', 'withdrawn'] as const;

/** A 0/1 SQL flag as a boolean (the driver hands positional values back as text or numbers). */
function sqlFlag(value: unknown): boolean {
  return Number(value) === 1;
}

/** `created_at` within the current window — the SQL flag the two-window reads select. */
function inWindowFlag(column: AnyMySqlColumn, windowDays: number) {
  return sql<boolean>`(${column} >= date_sub(now(3), interval ${windowDays} day))`.mapWith(sqlFlag);
}

/** `created_at` within the current or the preceding window of the same length. */
function inTwoWindows(column: AnyMySqlColumn, windowDays: number) {
  return gte(column, sql`date_sub(now(3), interval ${windowDays * 2} day)`);
}

export class InsightsAdoptionRepository {
  /**
   * The organization's active memberships — one row per active member, tenant-scoped. Suspended,
   * invited and offboarded memberships are not active use and are excluded in SQL. Distinct-by-user
   * counting is the controller's (a member has at most one membership per org by the
   * `uq_memberships_org_user` unique index, but the controller counts distinct users anyway so a
   * duplicated row could never inflate the figure).
   */
  async listActiveMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly AdoptionMemberRow[]> {
    return tenantDrizzle(runner)
      .select({ organizationId: memberships.organizationId, userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
        ),
      );
  }

  /**
   * The owners of work items created within the window — tenant-scoped, owner present, not
   * soft-deleted. One row per matching item; the controller counts distinct owners, so a person who
   * created several items in the window is one adopting member, not several. The window is
   * `created_at >= now(3) - windowDays` in SQL.
   */
  async listRecentWorkOwners(
    runner: TenantQueryRunner,
    context: TenantContext,
    windowDays: number,
  ): Promise<readonly AdoptionWorkOwnerRow[]> {
    return tenantDrizzle(runner)
      .select({ organizationId: workItems.organizationId, ownerUserId: workItems.ownerUserId })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          isNotNull(workItems.ownerUserId),
          isNull(workItems.deletedAt),
          gte(workItems.createdAt, sql`date_sub(now(3), interval ${windowDays} day)`),
        ),
      );
  }

  /**
   * The meetings held within the window — tenant-scoped, `starts_at` in `[now(3) - windowDays,
   * now(3)]`. A meeting scheduled in the future has not been held and is excluded by the upper
   * bound. One row per meeting; the controller counts them.
   */
  async listMeetingsHeld(
    runner: TenantQueryRunner,
    context: TenantContext,
    windowDays: number,
  ): Promise<readonly AdoptionMeetingRow[]> {
    return tenantDrizzle(runner)
      .select({ organizationId: meetings.organizationId, meetingId: meetings.id })
      .from(meetings)
      .where(
        and(
          eq(meetings.organizationId, context.organizationId),
          gte(meetings.startsAt, sql`date_sub(now(3), interval ${windowDays} day)`),
          lte(meetings.startsAt, sql`now(3)`),
        ),
      );
  }

  /**
   * Work items created in the current window and the one before it, each flagged with which window
   * it is in and whether it carries a committed date (`due_at`). The controller turns this into
   * "N% of work items carry a committed date, was M%".
   */
  async listDatedWork(
    runner: TenantQueryRunner,
    context: TenantContext,
    windowDays: number,
  ): Promise<readonly AdoptionDatedWorkRow[]> {
    return tenantDrizzle(runner)
      .select({
        organizationId: workItems.organizationId,
        inWindow: inWindowFlag(workItems.createdAt, windowDays),
        dated: sql<boolean>`(${workItems.dueAt} is not null)`.mapWith(sqlFlag),
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          isNull(workItems.deletedAt),
          inTwoWindows(workItems.createdAt, windowDays),
        ),
      );
  }

  /** The organization's live channels (conversations not archived). */
  async listChannels(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly AdoptionChannelRow[]> {
    return tenantDrizzle(runner)
      .select({ organizationId: conversations.organizationId, conversationId: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, context.organizationId),
          isNull(conversations.archivedAt),
        ),
      );
  }

  /**
   * The channels that have ever had a work item created from one of their messages — distinct
   * conversation ids over `message_work_links` joined to `messages`, both tenant-scoped.
   */
  async listChannelsWithWork(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly AdoptionChannelRow[]> {
    return tenantDrizzle(runner)
      .selectDistinct({
        organizationId: messages.organizationId,
        conversationId: messages.conversationId,
      })
      .from(messageWorkLinks)
      .innerJoin(messages, eq(messages.id, messageWorkLinks.messageId))
      .where(
        and(
          eq(messageWorkLinks.organizationId, context.organizationId),
          eq(messages.organizationId, context.organizationId),
        ),
      );
  }

  /** Approvals requested in the current window and the one before, with the hash each was sent with. */
  async listApprovalHashes(
    runner: TenantQueryRunner,
    context: TenantContext,
    windowDays: number,
  ): Promise<readonly AdoptionApprovalHashRow[]> {
    return tenantDrizzle(runner)
      .select({
        organizationId: approvals.organizationId,
        deliverableId: approvals.deliverableId,
        deliverableVersionId: approvals.deliverableVersionId,
        contentHash: approvals.contentHash,
        inWindow: inWindowFlag(approvals.createdAt, windowDays),
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.organizationId, context.organizationId),
          inTwoWindows(approvals.createdAt, windowDays),
        ),
      );
  }

  /** The stored hashes of the given deliverable versions. An empty list reads nothing. */
  async listVersionHashes(
    runner: TenantQueryRunner,
    context: TenantContext,
    versionIds: readonly string[],
  ): Promise<readonly AdoptionVersionHashRow[]> {
    if (versionIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select({
        organizationId: deliverableVersions.organizationId,
        versionId: deliverableVersions.id,
        contentHash: deliverableVersions.contentHash,
      })
      .from(deliverableVersions)
      .where(
        and(
          eq(deliverableVersions.organizationId, context.organizationId),
          inArray(deliverableVersions.id, [...versionIds]),
        ),
      );
  }

  /** Decisions logged in the window — one row each, counted by the controller. */
  async listDecisionsLogged(
    runner: TenantQueryRunner,
    context: TenantContext,
    windowDays: number,
  ): Promise<readonly AdoptionGapRow[]> {
    return tenantDrizzle(runner)
      .select({ organizationId: decisions.organizationId, projectId: decisions.projectId })
      .from(decisions)
      .where(
        and(
          eq(decisions.organizationId, context.organizationId),
          gte(decisions.decidedAt, sql`date_sub(now(3), interval ${windowDays} day)`),
        ),
      );
  }

  /** Approvals decided in the window — one row each, counted by the controller. */
  async listApprovalsDecided(
    runner: TenantQueryRunner,
    context: TenantContext,
    windowDays: number,
  ): Promise<readonly AdoptionGapRow[]> {
    return tenantDrizzle(runner)
      .select({ organizationId: approvals.organizationId, projectId: approvals.projectId })
      .from(approvals)
      .where(
        and(
          eq(approvals.organizationId, context.organizationId),
          isNotNull(approvals.decidedAt),
          gte(approvals.decidedAt, sql`date_sub(now(3), interval ${windowDays} day)`),
        ),
      );
  }

  /**
   * Data gap — work created from a chat message that nobody triaged: no owner and no committed
   * date, so it is absent from every forecast. Live (not deleted, not completed) items only; one
   * row per item even when several messages link to it.
   */
  async listUntriagedChatWork(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly AdoptionGapRow[]> {
    return tenantDrizzle(runner)
      .selectDistinct({
        organizationId: workItems.organizationId,
        projectId: workItems.projectId,
        workItemId: workItems.id,
      })
      .from(workItems)
      .innerJoin(messageWorkLinks, eq(messageWorkLinks.workItemId, workItems.id))
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(messageWorkLinks.organizationId, context.organizationId),
          isNull(workItems.deletedAt),
          isNull(workItems.completedAt),
          isNull(workItems.ownerUserId),
          isNull(workItems.dueAt),
        ),
      );
  }

  /**
   * Data gap — files tied to a client organization (shared towards the portal) whose audience is
   * still the default `internal`, so nobody can tell from the record whether the client may see it.
   */
  async listClientFilesMarkedInternal(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly AdoptionGapRow[]> {
    return tenantDrizzle(runner)
      .select({ organizationId: fileAssets.organizationId, projectId: fileAssets.projectId })
      .from(fileAssets)
      .where(
        and(
          eq(fileAssets.organizationId, context.organizationId),
          isNotNull(fileAssets.clientOrganizationId),
          eq(fileAssets.audience, 'internal'),
          isNull(fileAssets.purgedAt),
        ),
      );
  }

  /**
   * Data gap — open client requests that carry a desired date but no committed answer
   * (`commitment` unset). Finished requests (declined, delivered, withdrawn) are excluded.
   */
  async listRequestsAwaitingCommitment(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly AdoptionGapRow[]> {
    return tenantDrizzle(runner)
      .select({
        organizationId: clientRequests.organizationId,
        projectId: clientRequests.projectId,
      })
      .from(clientRequests)
      .where(
        and(
          eq(clientRequests.organizationId, context.organizationId),
          isNotNull(clientRequests.desiredAt),
          isNull(clientRequests.commitment),
          notInArray(clientRequests.state, [...CLOSED_REQUEST_STATES]),
        ),
      );
  }

  /** The names of the given projects — used to label a gap that sits in a single project. */
  async listProjectNames(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly AdoptionProjectNameRow[]> {
    if (projectIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select({
        organizationId: projects.organizationId,
        projectId: projects.id,
        name: projects.name,
      })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, context.organizationId),
          inArray(projects.id, [...projectIds]),
        ),
      );
  }
}
