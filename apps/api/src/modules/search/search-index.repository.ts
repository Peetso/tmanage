import { and, asc, desc, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  conversationMemberships,
  conversations,
  decisions,
  documents,
  meetings,
  messages,
  projects,
  workItems,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { FileAssetRow } from '../../common/database/schema.js';
import { clientAudienceVisible } from '../work/work-item-client-audience.repository.js';
import { searchFinanceAndFiles } from './search-finance-files.repository.js';
import type { SearchReachScope } from './search-finance-files.repository.js';
import { textMatcher } from './search-text-match.repository.js';

export { likePattern } from './search-normalise.js';

/**
 * SRCH (COL-04). The read side of global search.
 *
 * ## Why this reads the live source tables rather than a separate index
 *
 * The original design fed a denormalised `search_index` table (0054) that a deferred incremental
 * reindex job (NS-13) was meant to keep in step with every source write. That job never landed, so
 * nothing populated the index after the one-time migration backfill — and because the app's own
 * data is created through the API *after* migration, the index was empty in practice and search
 * returned nothing (COL-04: "the search index is empty; messages, decisions and projects are not
 * indexed"). Rather than wire the indexer into every write path across six modules (unverifiable
 * without the DB suite and a standing risk to critical writes), this scans the six source tables
 * directly at read time. Search is therefore always complete and always fresh, with nothing to
 * keep in sync.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read.** Every method takes the `TenantQueryRunner` for the current unit of work
 *    and the `TenantContext`; there is no overload without one.
 * 2. **The tenant comes from the context, never the caller.** `organization_id = ?` is a predicate
 *    on every statement, built from `context.organizationId`, so the guard (`drizzle.ts`) admits it
 *    and a cross-tenant row can never match. Each kind is a single-table, tenant-scoped scan — no
 *    join — so the per-statement scope is trivially the first predicate the guard requires.
 *
 * The relation (project-membership) rule is *not* here — that is `authorize()`'s, run per hit by
 * `SearchService`, the single place the rule lives. This layer carries `project_id` and `audience`
 * on each hit so the service can run it over one read without a join back to the source.
 */

/** The source kinds global search surfaces. */
export type SearchIndexTargetKind =
  | 'work_item'
  | 'document'
  | 'meeting'
  | 'message'
  | 'decision'
  | 'project'
  | 'invoice'
  | 'quote'
  | 'expense'
  | 'file';

/** A hit — only what the service needs to authorise and project it. */
export interface SearchIndexHitRow {
  readonly organizationId: string;
  /** The hit's project; null for an invoice, quote or expense that names none (53-17). */
  readonly projectId: string | null;
  readonly targetKind: SearchIndexTargetKind;
  readonly targetId: string;
  readonly title: string;
  /**
   * The source row's audience, carried so the service authorises each hit against the row's own
   * audience (a `client_visible` item is readable where an `internal` one is not), exactly as the
   * direct read does. Documents, meetings, decisions, projects and messages are `internal`.
   */
  readonly audience: SearchAudience;
  /** The source row's last change, for the TIME facet and the card's date line. */
  readonly updatedAt: Date;
  /**
   * F22: a `message` hit's channel, so the service can apply the channel-membership narrowing
   * `ConversationsService.mayReach` applies to every direct read. Absent for every other kind.
   */
  readonly conversationId?: string;
  /** 53-17: an invoice's or file's client organization, for the client-projection rule. */
  readonly clientOrganizationId?: string | null;
  /** 53-17: an invoice's or quote's state (a client never sees a draft or void invoice). */
  readonly state?: string;
  /** 53-17: an expense's submitter, for the "own expense" read. */
  readonly ownerMembershipId?: string;
  /** 53-17: a file hit's asset row, for the purpose policy and the client relation. */
  readonly asset?: FileAssetRow;
}

/** The three audiences a source row can carry (the AUDIENCE facet's values). */
export type SearchAudience = 'internal' | 'client_visible' | 'client_action_required';

export interface SearchRankedOptions {
  /** The query, matched case-insensitively as a substring of the title/body. */
  readonly query: string;
  /** Optional project filter, already resolved tenant-scoped by the service (Known-trap). */
  readonly projectId?: string;
  /** The bound on rows returned; the service bounds again defensively. */
  readonly limit: number;
  /**
   * AUDIENCE facet (SR-02): keep only rows whose audience is one of these. A kind that is always
   * `internal` is scanned only when `internal` is in the set. Omitted = every audience.
   */
  readonly audiences?: readonly SearchAudience[];
  /** TIME facet (SR-02): keep only rows changed at or after this instant. Omitted = all time. */
  readonly updatedSince?: Date;
  /** 53-17 TYPE facet: only these kinds are scanned. Omitted = every kind. */
  readonly kinds?: readonly SearchIndexTargetKind[];
  /**
   * 53-17: what the service decided about the caller, used to skip or narrow the finance and file
   * scans. Omitted = those four kinds are not scanned at all (the safe default).
   */
  readonly reach?: SearchReachScope;
}

/**
 * One row to (re)index — a projection of a source row into a flat shape. Retained for the indexer
 * helpers (`search-index.indexer.ts`) and any future incremental reindex job; the live read above
 * does not depend on it.
 */
export interface SearchIndexEntry {
  readonly targetKind: SearchIndexTargetKind;
  readonly targetId: string;
  readonly projectId: string;
  readonly title: string;
  readonly bodyText: string;
  readonly audience: SearchAudience;
  readonly updatedAt: Date;
}

/** The longest substring of a message body we surface as its title. */
const MESSAGE_TITLE_LENGTH = 140;

export class SearchIndexRepository {
  /**
   * Find this tenant's rows matching the query across the six source kinds, newest first.
   *
   * Each kind is a single-table, tenant-scoped scan bounded to `limit`; the results are merged,
   * ordered by recency (then id for a deterministic tiebreak) and cut to `limit`. The service then
   * drops any hit the caller may not read and bounds the set again. `organization_id = ?` leads
   * every statement, so a cross-tenant row never matches.
   */
  async searchRanked(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: SearchRankedOptions,
  ): Promise<readonly SearchIndexHitRow[]> {
    const db = tenantDrizzle(runner);
    const org = context.organizationId;
    // 53-17: the query and the stored text are folded the same way (Arabic letter forms, marks).
    const matcher = textMatcher(options.query);
    const { limit, projectId, updatedSince, audiences, kinds } = options;
    const wants = (kind: SearchIndexTargetKind): boolean => !kinds || kinds.includes(kind);

    // A kind that only ever carries `internal` is scanned only when the audience facet admits it.
    const admitsInternal = !audiences || audiences.includes('internal');
    const wantsInternal = (kind: SearchIndexTargetKind): boolean => admitsInternal && wants(kind);

    const hits: SearchIndexHitRow[] = [];

    // ── Work items (the one kind with a real audience) ───────────────────────
    if (wants('work_item')) {
      const predicates = [
        eq(workItems.organizationId, org),
        isNull(workItems.deletedAt),
        matcher.matches(workItems.title),
      ];
      if (projectId) predicates.push(eq(workItems.projectId, projectId));
      if (audiences && audiences.length > 0) {
        predicates.push(inArray(workItems.audience, [...audiences]));
      }
      if (updatedSince) predicates.push(gte(workItems.updatedAt, updatedSince));
      // C25: a client never finds an item narrowed away from their client company.
      const visible = clientAudienceVisible(context);
      if (visible) predicates.push(visible);
      const rows = await db
        .select({
          projectId: workItems.projectId,
          id: workItems.id,
          title: workItems.title,
          audience: workItems.audience,
          updatedAt: workItems.updatedAt,
        })
        .from(workItems)
        .where(and(...predicates))
        .orderBy(desc(workItems.updatedAt), asc(workItems.id))
        .limit(limit);
      for (const row of rows) {
        hits.push({
          organizationId: org,
          projectId: row.projectId,
          targetKind: 'work_item',
          targetId: row.id,
          title: row.title,
          audience: row.audience as SearchAudience,
          updatedAt: row.updatedAt,
        });
      }
    }

    // ── Documents (internal by construction for search, as the original index treated them) ──
    if (wantsInternal('document')) {
      const predicates = [
        eq(documents.organizationId, org),
        or(matcher.matches(documents.title), matcher.matches(documents.body)),
      ];
      if (projectId) predicates.push(eq(documents.projectId, projectId));
      if (updatedSince) predicates.push(gte(documents.updatedAt, updatedSince));
      const rows = await db
        .select({
          projectId: documents.projectId,
          id: documents.id,
          title: documents.title,
          updatedAt: documents.updatedAt,
        })
        .from(documents)
        .where(and(...predicates))
        .orderBy(desc(documents.updatedAt), asc(documents.id))
        .limit(limit);
      for (const row of rows) {
        hits.push({
          organizationId: org,
          projectId: row.projectId,
          targetKind: 'document',
          targetId: row.id,
          title: row.title,
          audience: 'internal',
          updatedAt: row.updatedAt,
        });
      }
    }

    // ── Meetings ─────────────────────────────────────────────────────────────
    if (wantsInternal('meeting')) {
      const predicates = [
        eq(meetings.organizationId, org),
        or(matcher.matches(meetings.title), matcher.matches(meetings.agendaNote)),
      ];
      if (projectId) predicates.push(eq(meetings.projectId, projectId));
      if (updatedSince) predicates.push(gte(meetings.updatedAt, updatedSince));
      const rows = await db
        .select({
          projectId: meetings.projectId,
          id: meetings.id,
          title: meetings.title,
          updatedAt: meetings.updatedAt,
        })
        .from(meetings)
        .where(and(...predicates))
        .orderBy(desc(meetings.updatedAt), asc(meetings.id))
        .limit(limit);
      for (const row of rows) {
        hits.push({
          organizationId: org,
          projectId: row.projectId,
          targetKind: 'meeting',
          targetId: row.id,
          title: row.title,
          audience: 'internal',
          updatedAt: row.updatedAt,
        });
      }
    }

    // ── Decisions (recency is `decided_at`; the register's own sort column) ──
    if (wantsInternal('decision')) {
      const predicates = [
        eq(decisions.organizationId, org),
        or(matcher.matches(decisions.title), matcher.matches(decisions.statement)),
      ];
      if (projectId) predicates.push(eq(decisions.projectId, projectId));
      if (updatedSince) predicates.push(gte(decisions.decidedAt, updatedSince));
      const rows = await db
        .select({
          projectId: decisions.projectId,
          id: decisions.id,
          title: decisions.title,
          decidedAt: decisions.decidedAt,
        })
        .from(decisions)
        .where(and(...predicates))
        .orderBy(desc(decisions.decidedAt), asc(decisions.id))
        .limit(limit);
      for (const row of rows) {
        hits.push({
          organizationId: org,
          projectId: row.projectId,
          targetKind: 'decision',
          targetId: row.id,
          title: row.title,
          audience: 'internal',
          updatedAt: row.decidedAt,
        });
      }
    }

    // ── Projects (the project is its own relation subject: project_id = its id) ──
    if (wantsInternal('project')) {
      const predicates = [
        eq(projects.organizationId, org),
        isNull(projects.archivedAt),
        matcher.matches(projects.name),
      ];
      if (projectId) predicates.push(eq(projects.id, projectId));
      if (updatedSince) predicates.push(gte(projects.updatedAt, updatedSince));
      const rows = await db
        .select({
          id: projects.id,
          name: projects.name,
          updatedAt: projects.updatedAt,
        })
        .from(projects)
        .where(and(...predicates))
        .orderBy(desc(projects.updatedAt), asc(projects.id))
        .limit(limit);
      for (const row of rows) {
        hits.push({
          organizationId: org,
          projectId: row.id,
          targetKind: 'project',
          targetId: row.id,
          title: row.name,
          audience: 'internal',
          updatedAt: row.updatedAt,
        });
      }
    }

    // ── Messages (project resolved from the channel, in a second tenant-scoped read — no join,
    //    so the guard sees a single tenant table per statement) ───────────────
    if (wantsInternal('message')) {
      const messagePredicates = [
        eq(messages.organizationId, org),
        isNull(messages.deletedAt),
        matcher.matches(messages.body),
      ];
      if (updatedSince) messagePredicates.push(gte(messages.updatedAt, updatedSince));
      const messageRows = await db
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          body: messages.body,
          updatedAt: messages.updatedAt,
        })
        .from(messages)
        .where(and(...messagePredicates))
        .orderBy(desc(messages.updatedAt), asc(messages.id))
        .limit(limit);

      if (messageRows.length > 0) {
        const conversationIds = [...new Set(messageRows.map((row) => row.conversationId))];
        const channelRows = await db
          .select({ id: conversations.id, projectId: conversations.projectId })
          .from(conversations)
          .where(
            and(eq(conversations.organizationId, org), inArray(conversations.id, conversationIds)),
          );
        const projectByConversation = new Map(channelRows.map((row) => [row.id, row.projectId]));

        for (const row of messageRows) {
          const messageProjectId = projectByConversation.get(row.conversationId);
          // A message whose channel is not in this tenant cannot be authorised; drop it.
          if (!messageProjectId) continue;
          if (projectId && messageProjectId !== projectId) continue;
          hits.push({
            organizationId: org,
            projectId: messageProjectId,
            targetKind: 'message',
            targetId: row.id,
            title: row.body.slice(0, MESSAGE_TITLE_LENGTH),
            audience: 'internal',
            updatedAt: row.updatedAt,
            conversationId: row.conversationId,
          });
        }
      }
    }

    // ── 53-17: client invoices, quotes, expenses and files ───────────────────
    if (options.reach) {
      const more = await searchFinanceAndFiles(db, {
        organizationId: org,
        matcher,
        limit,
        scope: options.reach,
        wants,
        ...(projectId === undefined ? {} : { projectId }),
        ...(audiences === undefined ? {} : { audiences }),
        ...(updatedSince === undefined ? {} : { updatedSince }),
      });
      for (const row of more) {
        hits.push({
          organizationId: org,
          projectId: row.projectId,
          targetKind: row.kind,
          targetId: row.id,
          title: row.title,
          audience: row.audience,
          updatedAt: row.updatedAt,
          ...(row.clientOrganizationId === undefined
            ? {}
            : { clientOrganizationId: row.clientOrganizationId }),
          ...(row.state === undefined ? {} : { state: row.state }),
          ...(row.ownerMembershipId === undefined
            ? {}
            : { ownerMembershipId: row.ownerMembershipId }),
          ...(row.asset === undefined ? {} : { asset: row.asset }),
        });
      }
    }

    // Merge the per-kind scans into one recency order, breaking ties by id for determinism.
    hits.sort((left, right) => {
      const byTime = right.updatedAt.getTime() - left.updatedAt.getTime();
      if (byTime !== 0) return byTime;
      return left.targetId < right.targetId ? -1 : left.targetId > right.targetId ? 1 : 0;
    });
    return hits.slice(0, limit);
  }

  /**
   * F22: which of `conversationIds` the user holds a `conversation_memberships` row for —
   * one tenant-scoped IN query per search, so message hits can be narrowed like `mayReach`.
   */
  async listMemberConversationIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
    conversationIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (conversationIds.length === 0) return new Set();
    const rows = await tenantDrizzle(runner)
      .select({ id: conversationMemberships.conversationId })
      .from(conversationMemberships)
      .where(
        and(
          eq(conversationMemberships.organizationId, context.organizationId),
          eq(conversationMemberships.userId, userId),
          inArray(conversationMemberships.conversationId, [...conversationIds]),
        ),
      );
    return new Set(rows.map((row) => row.id));
  }
}
