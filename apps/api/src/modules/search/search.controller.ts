import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { SEARCH_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { SearchResultView, SearchService } from './search.service.js';

/**
 * SRCH-01 (x111). Global tenant-scoped search: one read endpoint returning a unified result set
 * over work items, documents and meetings.
 *
 * Like every tenant-scoped controller here, it never reads `organizationId` from the query, a
 * header, or its own `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard`
 * built from a membership row and passes it on. The route is behind `search.use`; the object-level
 * relation rule (a hit is only returned if the caller may read it) is the service's.
 */

/** `work_items.title`, `documents.title` and `meetings.title` are each `VARCHAR(300)`. */
const MAX_QUERY_LENGTH = 300;

@Controller('v1/organizations/:orgSlug/search')
export class SearchController {
  constructor(@Inject(SEARCH_SERVICE) private readonly search: SearchService) {}

  @Get()
  @RequireCapability('search.use')
  async run(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('q') q?: string,
    @Query('projectId') projectId?: string,
    @Query('limit') limit?: string,
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

    return {
      results: await this.search.search(context, principal, {
        q: query,
        ...(projectId === undefined ? {} : { projectId }),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      }),
    };
  }
}
