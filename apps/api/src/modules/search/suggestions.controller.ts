import { Controller, Get, Inject, Module, Optional, Query } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { SUGGEST_MAX_LIMIT, SuggestionsService } from './suggestions.service.js';

/**
 * SRCH typeahead / suggestions (x289) — `GET …/search/suggest?q=<prefix>&limit=`, behind the reused
 * `search.use` capability (the same coarse ceiling global search and the command palette read
 * under — no new capability, no `capabilities.ts` edit). Read-only, tenant-scoped by the
 * `TenantContext` the guard built; every candidate is relation-gated with `work.read` in the
 * service, so a suggestion never surfaces a title the caller's own read would deny.
 *
 * A second controller on the search base path rather than an edit to {@link SearchController}, so
 * the suggestions slice stays file-disjoint from the ranked-search (x111/x148), command-palette
 * (x181) and saved/recent (x214) slices. It shares the base path only. There is no new table, no
 * migration and no write: it reads the existing `search_index` (0054).
 *
 * ## Distinct from x288 recent history and x181 commands
 *
 * A suggestion is a bare title **string** predicted from what the caller is typing — not a recent
 * query the caller ran (x288) and not a fixed navigation/quick-action command (x181). Keeping the
 * response `{ suggestions: string[] }` a shape of its own means a consumer can render typeahead
 * without mistaking a prediction for a stored history entry or a command.
 */

/** Matches `search_index.title` (`VARCHAR(300)`); a longer prefix is rejected rather than truncated. */
const MAX_QUERY_LENGTH = 300;

@Controller('v1/organizations/:orgSlug/search/suggest')
export class SuggestionsController {
  private readonly suggestions: SuggestionsService;

  constructor(
    // `@Optional()` so the capability-metadata test can construct the controller with no DI, exactly
    // as the sibling search controllers do. In the app the `@Global` `TENANT_DATABASE` is always
    // present, so the service is always backed by a real tenant database.
    @Optional() @Inject(TENANT_DATABASE) database?: TenantDatabase,
    @Optional() @Inject(SuggestionsService) suggestions?: SuggestionsService,
  ) {
    this.suggestions = suggestions ?? new SuggestionsService(database as unknown as TenantDatabase);
  }

  @Get()
  @RequireCapability('search.use')
  async run(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly suggestions: readonly string[] }> {
    const query = typeof q === 'string' ? q.trim() : '';
    if (query.length > MAX_QUERY_LENGTH) {
      throw new ApiError(400, 'validation_failed', 'q is too long', [
        { field: 'q', message: `must be ${MAX_QUERY_LENGTH} characters or fewer` },
      ]);
    }

    let parsedLimit: number | undefined;
    if (limit !== undefined) {
      const value = Number(limit);
      if (!Number.isInteger(value) || value < 1 || value > SUGGEST_MAX_LIMIT) {
        throw new ApiError(400, 'validation_failed', 'limit is invalid', [
          { field: 'limit', message: `must be a whole number between 1 and ${SUGGEST_MAX_LIMIT}` },
        ]);
      }
      parsedLimit = value;
    }

    // A blank prefix is an empty list, not an error (200) — the service short-circuits before any read.
    if (query === '') return { suggestions: [] };

    const suggestions = await this.suggestions.suggest(context, principal, {
      q: query,
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
    });
    return { suggestions };
  }
}

/**
 * x289's wiring — a self-contained module registered from `app.module.ts` (the shared append point)
 * beside {@link SearchModule}, so the search slices stay file-disjoint. The controller constructs its
 * own {@link SuggestionsService} over the `@Global` `TENANT_DATABASE`, so there is no provider to
 * declare and no new DI token to add.
 */
@Module({})
export class SuggestionsModule {
  static register(): DynamicModule {
    return {
      module: SuggestionsModule,
      controllers: [SuggestionsController],
    };
  }
}
