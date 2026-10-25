import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { SuggestionsRepository } from './suggestions.repository.js';
import type { SuggestCandidateRow } from './suggestions.repository.js';

/**
 * SRCH typeahead / suggestions (x289) — the application service behind
 * `GET …/search/suggest?q=<prefix>&limit=`.
 *
 * Given a query **prefix** it returns ranked suggestion strings (indexed entity titles) so the client
 * can render a typeahead list under the search box, distinct from the recent-history and the
 * command-palette lists. Read-only, no new table: {@link SuggestionsRepository} reads the live work
 * items and documents (NV12 — never the frozen `search_index` snapshot), so every candidate is
 * authorised against its current project, audience and lifecycle.
 *
 * ## The two authorization layers — identical to global search (x111/x148)
 *
 * `CapabilityGuard` on the route answers the coarse `search.use` question (does this role's ceiling
 * include search at all) with no row loaded. This service adds the **relation** check with each
 * candidate's own project and audience in hand: every candidate is authorised with `work.read`
 * against its own organization/project/audience — the same rule {@link SearchService} runs per hit —
 * and one that fails is dropped, never suggested. So a prefix can never surface the title of an item
 * the caller's own direct read would deny; a cross-tenant candidate (already excluded by the
 * repository's `organization_id` predicate) is dropped here too, belt-and-braces.
 *
 * Titles are de-duplicated (two items can share a title) and the set is bounded (default 8, max 20).
 */

export const SUGGEST_DEFAULT_LIMIT = 8;
export const SUGGEST_MAX_LIMIT = 20;

/**
 * How many index rows to read before the relation filter and de-duplication. Bounded so the read is
 * cheap; larger than {@link SUGGEST_MAX_LIMIT} so that dropping unreadable or duplicate-title rows
 * still leaves a full page of suggestions when the tenant has them.
 */
const CANDIDATE_LIMIT = 100;

export function effectiveSuggestLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SUGGEST_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), SUGGEST_MAX_LIMIT);
}

export interface SuggestOptions {
  /** The query prefix. A blank one yields an empty list without touching the database. */
  readonly q: string;
  readonly limit?: number;
}

export class SuggestionsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: SuggestionsRepository = new SuggestionsRepository(),
  ) {}

  /**
   * Return up to `limit` distinct, relation-gated title suggestions for the prefix, tenant-scoped
   * and ordered by recency. A blank prefix returns an empty list without touching the database.
   */
  async suggest(
    context: TenantContext,
    principal: Principal,
    options: SuggestOptions,
  ): Promise<readonly string[]> {
    const prefix = options.q.trim();
    if (prefix === '') return [];

    const limit = effectiveSuggestLimit(options.limit);

    const candidates = await this.database.read(context, (runner) =>
      this.repository.suggestByPrefix(runner, context, { prefix, limit: CANDIDATE_LIMIT }),
    );

    const suggestions: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (seen.has(candidate.title)) continue;
      if (!this.mayRead(principal, candidate)) continue;
      seen.add(candidate.title);
      suggestions.push(candidate.title);
      if (suggestions.length >= limit) break;
    }
    return suggestions;
  }

  /**
   * Whether this principal may read the candidate, judged against its own project and audience —
   * the single relation rule ({@link authorize}), so a suggestion can never surface a title the
   * candidate's own direct read would refuse.
   */
  private mayRead(principal: Principal, candidate: SuggestCandidateRow): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: candidate.organizationId,
        projectId: candidate.projectId,
        audience: candidate.audience,
        lifecycle: candidate.lifecycle,
      },
    }).allowed;
  }
}
