import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { INBOX_SAVED_FILTERS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  InboxSavedFilterInput,
  InboxSavedFilterView,
  InboxSavedFiltersService,
} from './inbox-saved-filters.service.js';

/**
 * INBOX saved filters (IN-02 "All inbox", x261). The HTTP surface over `inbox_saved_filters` — a
 * member's own named inbox filter sets (create / list / delete).
 *
 * Every route sits behind `@RequireCapability('work.read')` — the capability `InboxController`
 * already requires, **reused** so this slice stays off `capabilities.ts` and the role grid. A caller
 * without it (a client principal) is refused by the global `CapabilityGuard` with a 403 before any
 * handler runs. No route reads an `organizationId` or a `membershipId` from anywhere: the tenant and
 * the acting membership are `TenantContextGuard`'s, and a saved filter is always the acting
 * membership's own — the object rule the service and repository enforce (own-scoped list/create and
 * delete; a foreign id is a 404).
 */
@Controller('v1/organizations/:orgSlug/inbox/saved-filters')
export class InboxSavedFiltersController {
  constructor(
    @Inject(INBOX_SAVED_FILTERS_SERVICE)
    private readonly savedFilters: InboxSavedFiltersService,
  ) {}

  /** The acting membership's saved inbox filters, newest first (200). */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
  ): Promise<{ readonly savedFilters: readonly InboxSavedFilterView[] }> {
    return { savedFilters: await this.savedFilters.list(context) };
  }

  /** Persist a new saved inbox filter owned by the acting membership (201). A duplicate name is 409. */
  @Post()
  @RequireCapability('work.read')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @Body() body: SavedFilterBody,
  ): Promise<InboxSavedFilterView> {
    return this.savedFilters.create(context, parseBody(body));
  }

  /**
   * Delete one of the acting membership's saved filters by id (200). Own-scoped: an id that names
   * another membership's row, another studio's row or nothing removes nothing and answers 404, so a
   * saved filter's existence is never disclosed to anyone but its owner.
   */
  @Delete(':savedFilterId')
  @RequireCapability('work.read')
  @HttpCode(200)
  async remove(
    @Ctx() context: TenantContext,
    @Param('savedFilterId') savedFilterId: string,
  ): Promise<{ readonly savedFilters: readonly InboxSavedFilterView[] }> {
    await this.savedFilters.delete(context, savedFilterId);
    return { savedFilters: await this.savedFilters.list(context) };
  }
}

interface SavedFilterBody {
  readonly name?: unknown;
  readonly filter?: unknown;
}

/** `inbox_saved_filters.name` is `VARCHAR(200)`. */
const MAX_NAME_LENGTH = 200;
/** The serialized facet set is a bounded payload, not an unbounded blob. */
const MAX_FILTER_LENGTH = 4000;

/**
 * Validate the request body into a {@link InboxSavedFilterInput}, or throw a 400 with field details.
 * `name` must be a non-empty, bounded string; `filter` must be a bounded string (its content is the
 * client's opaque, serialized facet set, never parsed here). A malformed body never reaches the write.
 */
function parseBody(body: SavedFilterBody): InboxSavedFilterInput {
  const details: { field: string; message: string }[] = [];

  const name = typeof body?.name === 'string' ? body.name.trim() : undefined;
  if (!name) details.push({ field: 'name', message: 'must be a non-empty string' });
  else if (name.length > MAX_NAME_LENGTH) {
    details.push({ field: 'name', message: `must be ${MAX_NAME_LENGTH} characters or fewer` });
  }

  const filter = typeof body?.filter === 'string' ? body.filter : undefined;
  if (filter === undefined) details.push({ field: 'filter', message: 'must be a string' });
  else if (filter.length > MAX_FILTER_LENGTH) {
    details.push({ field: 'filter', message: `must be ${MAX_FILTER_LENGTH} characters or fewer` });
  }

  if (details.length > 0 || !name || filter === undefined) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  return { name, filter };
}
