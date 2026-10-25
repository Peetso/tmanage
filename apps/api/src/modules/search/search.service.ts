import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { SearchIndexRepository } from './search-index.repository.js';
import type { SearchAudience, SearchIndexHitRow } from './search-index.repository.js';

/**
 * SRCH-01 (x111), ranked by SRCH ranking (x148). The application service for global search — one
 * read that returns a unified, tenant-scoped, **relevance-ranked** result set the client renders.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question `search.use`: does this role's ceiling
 * include search at all. That is all a guard can answer, because no row has been loaded. This
 * service adds the **relation** check with each hit's project in hand, and it is the security
 * spine of a cross-module read: a search must never surface an item the item's own direct read
 * would deny. So every hit is authorized with `work.read` against the hit's own
 * organization/project/audience — the same capability and resource `WorkItemsService` and
 * `DocumentsService` gate their reads with (`doc.read` is a declared ceiling-mirror of `work.read`,
 * so the relation rule is identical) — and a hit that fails is dropped, not returned. A non-member,
 * or a client principal, therefore sees exactly what they could reach one screen at a time.
 *
 * ## Order and bound
 *
 * The order is the ranking: `SearchIndexRepository.searchRanked` returns hits by relevance
 * descending, then `updated_at` descending, then id — computed by the FULLTEXT `MATCH … AGAINST`
 * over the tenant's index (0054). The service preserves that order (the relation filter only
 * *drops* rows, never reorders), so the client renders results in score order without re-sorting.
 * `limit` defaults to 20 and is capped at 50 (the x93/x98 bounded-list precedent); the repository
 * bounds the read and the service bounds the filtered set again.
 *
 * All six source kinds are searched live from their source tables (COL-04): work items, documents,
 * meetings, decisions, projects and channel messages. Body/snippet excerpts and an AI answer are
 * still deferred — `snippet` stays part of the contract so it can be filled without a reshape.
 */

export type SearchResultKind =
  'work_item' | 'document' | 'meeting' | 'message' | 'decision' | 'project';

/** What a caller is allowed to see of one hit. `organizationId` is deliberately absent. */
export interface SearchResultView {
  readonly kind: SearchResultKind;
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  /**
   * A short contextual excerpt. Null this slice: a body excerpt needs the snippet extraction
   * deferred to NS-13. The field is part of the contract now so the client can render an excerpt
   * the moment it lands, without a shape change.
   */
  readonly snippet: string | null;
  /** The hit's audience — the card's "internal" / "client visible" pill (SR-02). */
  readonly audience: SearchAudience;
  /** ISO-8601 instant of the source row's last change. */
  readonly updatedAt: string;
}

/** SR-02 TIME facet windows. `all` (or omitted) applies no time bound. */
export type SearchTimeWindow = '7d' | '30d' | 'all';

const WINDOW_DAYS: Readonly<Record<Exclude<SearchTimeWindow, 'all'>, number>> = {
  '7d': 7,
  '30d': 30,
};
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SearchOptions {
  /** The query. The controller has already rejected an empty one and bounded its length. */
  readonly q: string;
  /** Optional project filter; resolved tenant-scoped before the search (Known-trap). */
  readonly projectId?: string;
  readonly limit?: number;
  /**
   * SR-02 AUDIENCE facet: only hits whose audience is listed. A pure narrowing filter — it never
   * widens what `authorize()` lets through; every surviving hit is still relation-checked.
   */
  readonly audiences?: readonly SearchAudience[];
  /** SR-02 TIME facet: only hits changed within the window. */
  readonly since?: SearchTimeWindow;
}

/** The lower bound on `updated_at` a time window implies, or undefined for all time. */
export function windowStart(since: SearchTimeWindow | undefined, now: Date): Date | undefined {
  if (since === undefined || since === 'all') return undefined;
  return new Date(now.getTime() - WINDOW_DAYS[since] * DAY_MS);
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export function effectiveSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

export class SearchService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: SearchIndexRepository = new SearchIndexRepository(),
    /**
     * Read-only, and used for one thing: proving an optional `projectId` filter names a project
     * that exists **inside this tenant** before the search runs, exactly as `MeetingsService`
     * resolves a project before a write. Without it an unknown or cross-tenant id would simply
     * match nothing and return an empty set — indistinguishable from "no hits" — where the honest
     * answer is 404.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    /** The clock the TIME facet measures its window from; injectable for tests. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Run a tenant-scoped, relation-filtered, relevance-ranked search.
   *
   * When `projectId` is given it is resolved tenant-scoped **first** (Known-trap, FAST-PROTOCOL
   * 19:55): a missing id, or one from another tenant, is 404 and no rows are read — never a 500,
   * and never an empty set that hides the difference between "no matches" and "not your project".
   */
  async search(
    context: TenantContext,
    principal: Principal,
    options: SearchOptions,
  ): Promise<readonly SearchResultView[]> {
    const limit = effectiveSearchLimit(options.limit);
    const projectId = options.projectId;
    const updatedSince = windowStart(options.since, this.now());

    const rankedOptions = {
      query: options.q,
      limit,
      ...(projectId === undefined ? {} : { projectId }),
      ...(options.audiences === undefined ? {} : { audiences: options.audiences }),
      ...(updatedSince === undefined ? {} : { updatedSince }),
    };

    const hits = await this.database.read(context, async (runner) => {
      // Known-trap: resolve the named project inside the tenant before touching the index.
      if (projectId !== undefined) {
        const project = await this.projects.findById(runner, context, projectId);
        if (!project) {
          throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
        }
      }

      const ranked = await this.repository.searchRanked(runner, context, rankedOptions);

      // F22: channel membership narrows a message hit for every caller without org-wide scope,
      // exactly as `ConversationsService.mayReach` narrows the channel's own reads — a project
      // member removed from (or never added to) a channel must not read its text here either.
      if (principal.hasOrgWideScope) return { ranked, memberOf: null };
      const channelIds = [
        ...new Set(
          ranked.flatMap((hit) =>
            hit.targetKind === 'message' && hit.conversationId !== undefined
              ? [hit.conversationId]
              : [],
          ),
        ),
      ];
      const memberOf =
        channelIds.length === 0
          ? new Set<string>()
          : await this.repository.listMemberConversationIds(
              runner,
              context,
              principal.userId,
              channelIds,
            );
      return { ranked, memberOf };
    });

    const results: SearchResultView[] = [];
    for (const hit of hits.ranked) {
      if (hit.targetKind === 'message' && hits.memberOf !== null) {
        if (hit.conversationId === undefined || !hits.memberOf.has(hit.conversationId)) continue;
      }
      if (this.mayRead(principal, hit)) results.push(toView(hit));
    }
    return results.slice(0, limit);
  }

  /**
   * Whether this principal may read the hit, judged against the hit's own project and audience —
   * the single relation rule (`authorize()`), so a search can never surface a row the row's own
   * direct read would refuse.
   */
  private mayRead(principal: Principal, hit: SearchIndexHitRow): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: hit.organizationId,
        projectId: hit.projectId,
        audience: hit.audience,
        lifecycle: 'active',
      },
    }).allowed;
  }
}

function toView(hit: SearchIndexHitRow): SearchResultView {
  return {
    kind: hit.targetKind,
    id: hit.targetId,
    title: hit.title,
    projectId: hit.projectId,
    snippet: null,
    audience: hit.audience,
    updatedAt: hit.updatedAt.toISOString(),
  };
}
