import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { SearchRepository } from './search.repository.js';
import type { SearchHitRow } from './search.repository.js';

/**
 * SRCH-01 (x111). The application service for global search — the smallest useful unit the audit
 * asks for: one read that returns a unified, tenant-scoped result set the client renders.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question `search.use`: does this role's ceiling
 * include search at all. That is all a guard can answer, because no row has been loaded. This
 * service adds the **relation** check with each hit's project in hand, and it is the security
 * spine of a cross-module read: a search must never surface an item the item's own direct read
 * would deny. So every hit is authorized with `work.read` against the hit's own
 * organization/project/audience — the same capability and resource `WorkItemsService`,
 * `DocumentsService` and `MeetingsService` gate their reads with (`meeting.read`/`doc.read` are
 * declared ceiling-mirrors of `work.read`, so the relation rule is identical for all three) — and
 * a hit that fails is dropped, not returned. A non-member, or a client principal, therefore sees
 * exactly what they could reach one screen at a time, never more.
 *
 * ## Order and bound
 *
 * The result is deterministic — kind (work item, then document, then meeting), then title, then
 * id — so the same query returns the same page, and the client renders groups without re-sorting.
 * `limit` defaults to 20 and is capped at 50 (the x93/x98 bounded-list precedent); each kind is
 * read up to `limit` rows, the merged set is sorted, and the first `limit` are returned.
 *
 * Title-only this slice, over the existing indexes. Ranking/relevance, a full-text index,
 * conversation/note bodies and AI answer synthesis are deferred (NEXT-SCOPES-9).
 */

export type SearchResultKind = 'work_item' | 'document' | 'meeting';

/** What a caller is allowed to see of one hit. `organizationId` is deliberately absent. */
export interface SearchResultView {
  readonly kind: SearchResultKind;
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  /**
   * A short contextual excerpt. Null this slice: the match is over titles only, so the title is
   * the whole of the hit's text and a body excerpt would need the body reads this slice defers
   * (NEXT-SCOPES-9). The field is part of the contract now so the client can render an excerpt
   * the moment body search lands, without a shape change.
   */
  readonly snippet: string | null;
}

export interface SearchOptions {
  /** The query. The controller has already rejected an empty one. */
  readonly q: string;
  /** Optional project filter; resolved tenant-scoped before the search (Known-trap). */
  readonly projectId?: string;
  readonly limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export function effectiveSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

/**
 * Escape the LIKE metacharacters so a query is matched literally: a caller typing `50%` or `a_b`
 * searches for those characters, not for "any run" or "any single character". MySQL's default
 * LIKE escape is backslash, so backslash is escaped first.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Fixed kind order for the deterministic sort. */
const KIND_RANK: Record<SearchResultKind, number> = {
  work_item: 0,
  document: 1,
  meeting: 2,
};

export class SearchService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: SearchRepository = new SearchRepository(),
    /**
     * Read-only, and used for one thing: proving an optional `projectId` filter names a project
     * that exists **inside this tenant** before the search runs, exactly as `MeetingsService`
     * resolves a project before a write. Without it an unknown or cross-tenant id would simply
     * match nothing and return an empty set — indistinguishable from "no hits" — where the honest
     * answer is 404. A stateless repository is cheap to own a second handle on.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /**
   * Run a tenant-scoped, relation-filtered search.
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
    const likePattern = `%${escapeLike(options.q)}%`;
    const projectId = options.projectId;

    const readOptions = {
      likePattern,
      limit,
      ...(projectId === undefined ? {} : { projectId }),
    };

    const { workHits, documentHits, meetingHits } = await this.database.read(
      context,
      async (runner) => {
        // Known-trap: resolve the named project inside the tenant before touching any table.
        if (projectId !== undefined) {
          const project = await this.projects.findById(runner, context, projectId);
          if (!project) {
            throw new ApiError(
              404,
              'not_found',
              MESSAGES.notFound,
              undefined,
              'project_not_visible',
            );
          }
        }

        const [workHits, documentHits, meetingHits] = await Promise.all([
          this.repository.searchWorkItems(runner, context, readOptions),
          this.repository.searchDocuments(runner, context, readOptions),
          this.repository.searchMeetings(runner, context, readOptions),
        ]);
        return { workHits, documentHits, meetingHits };
      },
    );

    const results: SearchResultView[] = [];
    for (const row of workHits) {
      if (this.mayRead(principal, row, row.audience ?? 'internal')) {
        results.push(toView('work_item', row));
      }
    }
    for (const row of documentHits) {
      if (this.mayRead(principal, row, 'internal')) results.push(toView('document', row));
    }
    for (const row of meetingHits) {
      if (this.mayRead(principal, row, 'internal')) results.push(toView('meeting', row));
    }

    results.sort(compareResults);
    return results.slice(0, limit);
  }

  /**
   * Whether this principal may read the hit, judged against the hit's own project and audience.
   * The single relation rule — `authorize()` — so a search can never surface a row the row's own
   * direct read would refuse.
   */
  private mayRead(
    principal: Principal,
    row: SearchHitRow,
    audience: 'internal' | 'client_visible' | 'client_action_required',
  ): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience,
        lifecycle: 'active',
      },
    }).allowed;
  }
}

function toView(kind: SearchResultKind, row: SearchHitRow): SearchResultView {
  return { kind, id: row.id, title: row.title, projectId: row.projectId, snippet: null };
}

/** Deterministic: kind, then title, then id. */
function compareResults(a: SearchResultView, b: SearchResultView): number {
  if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
