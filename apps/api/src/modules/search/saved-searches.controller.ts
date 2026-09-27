import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { SAVED_SEARCHES_SERVICE } from '../../common/http/tokens.js';
import type { SavedSearchFilter } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  RecentSearchView,
  SavedSearchInput,
  SavedSearchView,
  SavedSearchesService,
} from './saved-searches.service.js';

/**
 * SRCH saved/recent searches (x214). The HTTP surface over `saved_searches` — a member's own named
 * saved searches (create/list/delete) and their recent queries (read).
 *
 * Every route sits behind `@RequireCapability('search.use')` — the SRCH-01 search capability,
 * **reused** so this slice stays off `capabilities.ts` and the role grid. A caller without it (a
 * client principal) is refused by the global `CapabilityGuard` with a 403 before any handler runs.
 * No route reads an `organizationId` or a `userId` from anywhere: the tenant and the acting user are
 * `TenantContextGuard`'s, and a saved/recent search is always the acting user's own — the object
 * rule the service and repository enforce (own-scoped reads and delete; a foreign id is a 404).
 */
@Controller('v1/organizations/:orgSlug/search')
export class SavedSearchesController {
  constructor(
    @Inject(SAVED_SEARCHES_SERVICE) private readonly savedSearches: SavedSearchesService,
  ) {}

  /** The acting user's saved searches, newest first (200). */
  @Get('saved')
  @RequireCapability('search.use')
  async listSaved(
    @Ctx() context: TenantContext,
  ): Promise<{ readonly savedSearches: readonly SavedSearchView[] }> {
    return { savedSearches: await this.savedSearches.listSaved(context) };
  }

  /** Persist a new saved search owned by the acting user (201). */
  @Post('saved')
  @RequireCapability('search.use')
  @HttpCode(201)
  async createSaved(
    @Ctx() context: TenantContext,
    @Body() body: SavedSearchBody,
  ): Promise<SavedSearchView> {
    return this.savedSearches.createSaved(context, parseSavedSearchBody(body));
  }

  /**
   * Delete one of the acting user's saved searches by id (200 — nothing new was created). Own-scoped:
   * an id that names another user's row, another studio's row or nothing removes nothing and answers
   * 404 (the service maps the no-op delete), so a saved search's existence is never disclosed to
   * anyone but its owner.
   */
  @Delete('saved/:savedSearchId')
  @RequireCapability('search.use')
  @HttpCode(200)
  async deleteSaved(
    @Ctx() context: TenantContext,
    @Param('savedSearchId') savedSearchId: string,
  ): Promise<{ readonly savedSearches: readonly SavedSearchView[] }> {
    await this.savedSearches.deleteSaved(context, savedSearchId);
    return { savedSearches: await this.savedSearches.listSaved(context) };
  }

  /** The acting user's recent queries, most-recent first and bounded (200). */
  @Get('recent')
  @RequireCapability('search.use')
  async listRecent(
    @Ctx() context: TenantContext,
  ): Promise<{ readonly recent: readonly RecentSearchView[] }> {
    return { recent: await this.savedSearches.listRecent(context) };
  }
}

interface SavedSearchBody {
  readonly name?: unknown;
  readonly query?: unknown;
  readonly filters?: unknown;
}

/** `saved_searches.name` and `.query_text` are each `VARCHAR(300)`. */
const MAX_TEXT_LENGTH = 300;
/** A saved search remembers a handful of filters, not an unbounded blob. */
const MAX_FILTERS = 50;

/**
 * Validate the request body into a {@link SavedSearchInput}, or throw a 400 with field details. A
 * filter is a `{ field, value }` of short strings; a malformed or unbounded blob never reaches the
 * JSON column.
 */
function parseSavedSearchBody(body: SavedSearchBody): SavedSearchInput {
  const details: { field: string; message: string }[] = [];

  const name = typeof body?.name === 'string' ? body.name.trim() : undefined;
  if (!name) details.push({ field: 'name', message: 'must be a non-empty string' });
  else if (name.length > MAX_TEXT_LENGTH) {
    details.push({ field: 'name', message: `must be ${MAX_TEXT_LENGTH} characters or fewer` });
  }

  const query = typeof body?.query === 'string' ? body.query.trim() : undefined;
  if (!query) details.push({ field: 'query', message: 'must be a non-empty string' });
  else if (query.length > MAX_TEXT_LENGTH) {
    details.push({ field: 'query', message: `must be ${MAX_TEXT_LENGTH} characters or fewer` });
  }

  const filters = parseFilters(body?.filters, details);

  if (details.length > 0 || !name || !query || filters === undefined) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  return { name, query, filters };
}

function parseFilters(
  raw: unknown,
  details: { field: string; message: string }[],
): readonly SavedSearchFilter[] | undefined {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    details.push({ field: 'filters', message: 'must be an array' });
    return undefined;
  }
  if (raw.length > MAX_FILTERS) {
    details.push({ field: 'filters', message: `must have ${MAX_FILTERS} or fewer` });
    return undefined;
  }

  const filters: SavedSearchFilter[] = [];
  for (const [index, entry] of raw.entries()) {
    const item = entry as Record<string, unknown> | null;
    const field = item && typeof item['field'] === 'string' ? (item['field'] as string) : undefined;
    const value = item && typeof item['value'] === 'string' ? (item['value'] as string) : undefined;
    if (
      field === undefined ||
      value === undefined ||
      field.length > MAX_TEXT_LENGTH ||
      value.length > MAX_TEXT_LENGTH
    ) {
      details.push({ field: `filters[${index}]`, message: 'must be { field, value } of strings' });
    } else {
      filters.push({ field, value });
    }
  }

  return details.some((detail) => detail.field.startsWith('filters')) ? undefined : filters;
}
