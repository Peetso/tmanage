import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { SEARCH_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { SEARCH_RESULT_KINDS } from './search.service.js';
import type {
  SearchResultKind,
  SearchResultView,
  SearchService,
  SearchTimeWindow,
} from './search.service.js';
import type { SearchAudience } from './search-index.repository.js';
import { SavedSearchesRepository } from './saved-searches.repository.js';
import { RECENT_LIMIT } from './saved-searches.service.js';

/**
 * SRCH-01 (x111), 53-17. Global tenant-scoped search: one read endpoint returning a unified result
 * set over work, docs, meetings, decisions, projects, chat messages, invoices, quotes, expenses and
 * files, each hit permission-filtered by the service.
 *
 * Like every tenant-scoped controller here, it never reads `organizationId` from the query, a
 * header, or its own `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard`
 * built from a membership row and passes it on. The route is behind `search.use`; the object-level
 * relation rule (a hit is only returned if the caller may read it) is the service's.
 */

/** `work_items.title`, `documents.title` and `meetings.title` are each `VARCHAR(300)`. */
const MAX_QUERY_LENGTH = 300;

const AUDIENCES: readonly SearchAudience[] = [
  'internal',
  'client_visible',
  'client_action_required',
];
const TIME_WINDOWS: readonly SearchTimeWindow[] = ['7d', '30d', 'all'];

/**
 * SR-02 AUDIENCE facet: a comma-separated subset of the three audiences (`audience=internal,
 * client_visible`). Unknown values are a 400, never silently dropped; duplicates collapse.
 */
export function parseAudiences(raw: string | undefined): readonly SearchAudience[] | undefined {
  if (raw === undefined) return undefined;
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const invalid = values.filter((value) => !AUDIENCES.includes(value as SearchAudience));
  if (values.length === 0 || invalid.length > 0) {
    throw new ApiError(400, 'validation_failed', 'audience is invalid', [
      { field: 'audience', message: `must be a comma-separated subset of ${AUDIENCES.join(', ')}` },
    ]);
  }
  return [...new Set(values as SearchAudience[])];
}

/**
 * 53-17 TYPE facet: a comma-separated subset of the result kinds (`kinds=invoice,file`). Unknown
 * values are a 400; duplicates collapse. It only narrows — every hit is still permission-checked.
 */
export function parseKinds(raw: string | undefined): readonly SearchResultKind[] | undefined {
  if (raw === undefined) return undefined;
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const invalid = values.filter(
    (value) => !SEARCH_RESULT_KINDS.includes(value as SearchResultKind),
  );
  if (values.length === 0 || invalid.length > 0) {
    throw new ApiError(400, 'validation_failed', 'kinds is invalid', [
      {
        field: 'kinds',
        message: `must be a comma-separated subset of ${SEARCH_RESULT_KINDS.join(', ')}`,
      },
    ]);
  }
  return [...new Set(values as SearchResultKind[])];
}

/** SR-02 TIME facet: `7d`, `30d` or `all`. */
export function parseTimeWindow(raw: string | undefined): SearchTimeWindow | undefined {
  if (raw === undefined) return undefined;
  if (!TIME_WINDOWS.includes(raw as SearchTimeWindow)) {
    throw new ApiError(400, 'validation_failed', 'since is invalid', [
      { field: 'since', message: `must be one of ${TIME_WINDOWS.join(', ')}` },
    ]);
  }
  return raw as SearchTimeWindow;
}

@Controller('v1/organizations/:orgSlug/search')
export class SearchController {
  constructor(
    @Inject(SEARCH_SERVICE) private readonly search: SearchService,
    // SRCH saved/recent (x214). A successful global search records a recent query for the acting
    // user, so `GET …/search/recent` can return them. Optional and best-effort: recording is a
    // convenience, never the search's contract, so a recording failure must not fail the search.
    // `TENANT_DATABASE` is `@Global`; the repository is stateless (constructed here as the sibling
    // repositories are). Both `@Optional()` so a bare construction (the capability-metadata test)
    // needs no DI.
    @Optional() @Inject(TENANT_DATABASE) private readonly database?: TenantDatabase,
    @Optional()
    @Inject(SavedSearchesRepository)
    private readonly recents: SavedSearchesRepository = new SavedSearchesRepository(),
  ) {}

  @Get()
  @RequireCapability('search.use')
  async run(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('q') q?: string,
    @Query('projectId') projectId?: string,
    @Query('limit') limit?: string,
    @Query('audience') audience?: string,
    @Query('since') since?: string,
    @Query('kinds') kinds?: string,
  ): Promise<{ readonly results: readonly SearchResultView[] }> {
    const query = typeof q === 'string' ? q.trim() : '';
    if (query === '') {
      throw new ApiError(400, 'validation_failed', 'q is required', [
        { field: 'q', message: 'must be a non-empty string' },
      ]);
    }
    if (query.length > MAX_QUERY_LENGTH) {
      throw new ApiError(400, 'validation_failed', 'q is too long', [
        { field: 'q', message: `must be ${MAX_QUERY_LENGTH} characters or fewer` },
      ]);
    }

    if (projectId !== undefined && (typeof projectId !== 'string' || projectId === '')) {
      throw new ApiError(400, 'validation_failed', 'projectId must be a non-empty string', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    const audiences = parseAudiences(audience);
    const window = parseTimeWindow(since);
    const kindFilter = parseKinds(kinds);

    const results = await this.search.search(context, principal, {
      q: query,
      ...(audiences === undefined ? {} : { audiences }),
      ...(window === undefined ? {} : { since: window }),
      ...(kindFilter === undefined ? {} : { kinds: kindFilter }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
    });

    await this.recordRecent(context, query);

    return { results };
  }

  /**
   * Record the acting user's recent query, best-effort. A failure here (a missing grant in an
   * environment that has not run 0092, say) is swallowed: the recents list is a convenience and must
   * never turn a working search into an error. The write is tenant- and owner-scoped in the
   * repository, so it can only ever touch the acting user's own recents in the acting studio.
   */
  private async recordRecent(context: TenantContext, query: string): Promise<void> {
    if (!this.database) return;
    try {
      await this.database.transaction(context, (tx) =>
        this.recents.recordRecent(tx, context, query, RECENT_LIMIT),
      );
    } catch {
      // Intentionally ignored — recording a recent must not fail the search it accompanies.
    }
  }
}
