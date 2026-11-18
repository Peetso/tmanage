import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { isActivityKind, type Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  ACTIVITY_SERVICE,
  MAX_ACTIVITY_PAGE,
  type ActivityPageView,
  type ActivityQuery,
  type ActivityService,
} from './activity.service.js';

/**
 * 62-A2 (B02) — the Activity tab reads, one controller per parent:
 *
 * - `GET …/projects/:projectId/activity` — `work.read`, the project page's own gate.
 * - `GET …/client-organizations/:clientOrganizationId/activity` — `org.manage`, the client page's.
 *
 * Both are two path segments below a one-segment read, so neither collides with a sibling. The
 * tenant comes from the `TenantContext` the guard built, never from the path, a header or the query.
 * Query: `kind` (an activity kind), `person` (a user id), `from` / `to` (a day `YYYY-MM-DD`, `to`
 * inclusive, or an ISO instant, `to` exclusive), `cursor` (from the previous page), `limit`
 * (1..{@link MAX_ACTIVITY_PAGE}). The parent check, the per-entry read rule and the paging are the
 * service's.
 */

/** The query as the router hands it over: a repeated key arrives as an array, so nothing is trusted. */
export interface RawActivityQuery {
  readonly kind?: unknown;
  readonly person?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly cursor?: unknown;
  readonly limit?: unknown;
}

@Controller('v1/organizations/:orgSlug/projects/:projectId/activity')
export class ProjectActivityController {
  constructor(@Inject(ACTIVITY_SERVICE) private readonly activity: ActivityService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query() query: RawActivityQuery,
  ): Promise<ActivityPageView> {
    return this.activity.projectActivity(context, principal, projectId, parseActivityQuery(query));
  }
}

@Controller('v1/organizations/:orgSlug/client-organizations/:clientOrganizationId/activity')
export class ClientActivityController {
  constructor(@Inject(ACTIVITY_SERVICE) private readonly activity: ActivityService) {}

  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientOrganizationId') clientOrganizationId: string,
    @Query() query: RawActivityQuery,
  ): Promise<ActivityPageView> {
    return this.activity.clientActivity(
      context,
      principal,
      clientOrganizationId,
      parseActivityQuery(query),
    );
  }
}

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[0-9a-f-]{36}$/;
const MAX_CURSOR_LENGTH = 200;

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', `${field} ${message}`, [{ field, message }]);
}

/** A day or an instant; a day used as `to` covers the whole day. */
function parseInstant(field: 'from' | 'to', value: string): Date {
  const parsed = new Date(DAY.test(value) ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime()) || value.length > 40) {
    throw invalid(field, 'must be a day (YYYY-MM-DD) or an ISO-8601 instant');
  }
  return field === 'to' && DAY.test(value) ? new Date(parsed.getTime() + DAY_MS) : parsed;
}

/** One query value: absent, or exactly one string. */
function single(field: keyof RawActivityQuery, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(field, 'must be given once');
  return value;
}

export function parseActivityQuery(input: RawActivityQuery): ActivityQuery {
  const raw = {
    kind: single('kind', input.kind),
    person: single('person', input.person),
    from: single('from', input.from),
    to: single('to', input.to),
    cursor: single('cursor', input.cursor),
    limit: single('limit', input.limit),
  };
  const query: { -readonly [K in keyof ActivityQuery]: ActivityQuery[K] } = {};
  if (raw.kind !== undefined) {
    if (!isActivityKind(raw.kind)) throw invalid('kind', 'is not an activity kind');
    query.kind = raw.kind;
  }
  if (raw.person !== undefined) {
    if (!ID.test(raw.person)) throw invalid('person', 'must be a user id');
    query.actorUserId = raw.person;
  }
  if (raw.from !== undefined) query.from = parseInstant('from', raw.from);
  if (raw.to !== undefined) query.to = parseInstant('to', raw.to);
  if (query.from !== undefined && query.to !== undefined && query.from >= query.to) {
    throw invalid('to', 'must be after from');
  }
  if (raw.cursor !== undefined) {
    if (raw.cursor.length === 0 || raw.cursor.length > MAX_CURSOR_LENGTH) {
      throw invalid('cursor', 'is not a cursor this feed issued');
    }
    query.cursor = raw.cursor;
  }
  if (raw.limit !== undefined) {
    const limit = Number(raw.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ACTIVITY_PAGE) {
      throw invalid('limit', `must be an integer from 1 to ${String(MAX_ACTIVITY_PAGE)}`);
    }
    query.limit = limit;
  }
  return query;
}
