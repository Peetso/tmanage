import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { SEARCH_SCOPES_SERVICE } from '../../common/http/tokens.js';
import type { SearchScopeFilters } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  MAX_NAME_LENGTH,
  MAX_OBJECT_TYPES,
  SCOPE_OBJECT_TYPES,
  type SearchScopeInput,
  type SearchScopeView,
  type SearchScopesService,
} from './saved-scopes.service.js';

/**
 * SRCH saved scopes (x334). The HTTP surface over `search_scopes` — a member's own named search
 * filter scopes (create / list / replace / delete).
 *
 * Every route sits behind `@RequireCapability('search.use')` — the SRCH-01 search capability,
 * **reused** so this slice stays off `capabilities.ts` and the role grid. A caller without it is
 * refused by the global `CapabilityGuard` with a 403 before any handler runs. No route reads an
 * `organizationId` or a `userId` from anywhere: the tenant and the acting member are
 * `TenantContextGuard`'s, and a scope is always the acting member's own — the object rule the service
 * and repository enforce (own-scoped reads, replace and delete; a foreign id is a 404).
 */
@Controller('v1/organizations/:orgSlug/search/scopes')
export class SearchScopesController {
  constructor(@Inject(SEARCH_SCOPES_SERVICE) private readonly scopes: SearchScopesService) {}

  /** The acting member's saved scopes, newest first (200). */
  @Get()
  @RequireCapability('search.use')
  async list(
    @Ctx() context: TenantContext,
  ): Promise<{ readonly scopes: readonly SearchScopeView[] }> {
    return { scopes: await this.scopes.list(context) };
  }

  /** Persist a new scope owned by the acting member (201). */
  @Post()
  @RequireCapability('search.use')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @Body() body: SearchScopeBody,
  ): Promise<SearchScopeView> {
    return this.scopes.create(context, parseScopeBody(body));
  }

  /** Replace one of the acting member's scopes in place by id (200, idempotent PUT). */
  @Put(':scopeId')
  @RequireCapability('search.use')
  @HttpCode(200)
  async replace(
    @Ctx() context: TenantContext,
    @Param('scopeId') scopeId: string,
    @Body() body: SearchScopeBody,
  ): Promise<SearchScopeView> {
    return this.scopes.replace(context, scopeId, parseScopeBody(body));
  }

  /**
   * Delete one of the acting member's scopes by id (204). Own-scoped: an id that names another
   * member's row, another studio's row or nothing removes nothing and answers 404, so a scope's
   * existence is never disclosed to anyone but its owner.
   */
  @Delete(':scopeId')
  @RequireCapability('search.use')
  @HttpCode(204)
  async remove(@Ctx() context: TenantContext, @Param('scopeId') scopeId: string): Promise<void> {
    await this.scopes.remove(context, scopeId);
  }
}

interface SearchScopeBody {
  readonly name?: unknown;
  readonly filters?: unknown;
}

/**
 * Validate the request body into a {@link SearchScopeInput}, or throw a 400 with field details. The
 * name must be a non-empty, bounded string; the filters an object whose `objectTypes` are all on the
 * search-index allowlist and whose optional `projectId`/`from`/`to` are short strings. An
 * off-allowlist object type is a 400 here, so no write is attempted.
 */
function parseScopeBody(body: SearchScopeBody): SearchScopeInput {
  const details: { field: string; message: string }[] = [];

  const name = typeof body?.name === 'string' ? body.name.trim() : undefined;
  if (!name) details.push({ field: 'name', message: 'must be a non-empty string' });
  else if (name.length > MAX_NAME_LENGTH) {
    details.push({ field: 'name', message: `must be ${MAX_NAME_LENGTH} characters or fewer` });
  }

  const filters = parseFilters(body?.filters, details);

  if (details.length > 0 || name === undefined || filters === undefined) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  return { name, filters };
}

const ALLOWED_TYPES = new Set<string>(SCOPE_OBJECT_TYPES);
const MAX_DATE_LENGTH = 40;

function parseFilters(
  raw: unknown,
  details: { field: string; message: string }[],
): SearchScopeFilters | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    details.push({ field: 'filters', message: 'must be an object' });
    return undefined;
  }
  const record = raw as Record<string, unknown>;

  const objectTypes = parseObjectTypes(record['objectTypes'], details);
  const projectId = parseOptionalString(record['projectId'], 'filters.projectId', details);
  const from = parseOptionalDate(record['from'], 'filters.from', details);
  const to = parseOptionalDate(record['to'], 'filters.to', details);

  if (objectTypes === undefined || details.length > 0) return undefined;

  return {
    objectTypes,
    ...(projectId === undefined ? {} : { projectId }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

function parseObjectTypes(
  raw: unknown,
  details: { field: string; message: string }[],
): readonly string[] | undefined {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    details.push({ field: 'filters.objectTypes', message: 'must be an array' });
    return undefined;
  }
  if (raw.length > MAX_OBJECT_TYPES) {
    details.push({
      field: 'filters.objectTypes',
      message: `must have ${MAX_OBJECT_TYPES} or fewer`,
    });
    return undefined;
  }
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'string' || !ALLOWED_TYPES.has(entry)) {
      details.push({
        field: `filters.objectTypes[${index}]`,
        message: `must be one of ${[...ALLOWED_TYPES].join(', ')}`,
      });
    } else {
      seen.add(entry);
    }
  }
  if (details.some((detail) => detail.field.startsWith('filters.objectTypes'))) return undefined;
  return [...seen];
}

function parseOptionalString(
  raw: unknown,
  field: string,
  details: { field: string; message: string }[],
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    details.push({ field, message: 'must be a non-empty string when present' });
    return undefined;
  }
  return raw.trim();
}

function parseOptionalDate(
  raw: unknown,
  field: string,
  details: { field: string; message: string }[],
): string | undefined {
  const value = parseOptionalString(raw, field, details);
  if (value === undefined) return undefined;
  if (value.length > MAX_DATE_LENGTH || Number.isNaN(Date.parse(value))) {
    details.push({ field, message: 'must be an ISO-8601 date' });
    return undefined;
  }
  return value;
}
