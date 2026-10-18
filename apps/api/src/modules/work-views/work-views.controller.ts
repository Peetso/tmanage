import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { parseCalendarRange } from './calendar-range.js';
import { WORK_VIEWS_SERVICE } from '../../common/http/tokens.js';
import type { SavedViewConfig } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  SavedViewInput,
  SavedViewView,
  WorkCalendarView,
  WorkloadView,
  WorkTimelineView,
  WorkViewsService,
} from './work-views.service.js';

/**
 * The Work views HTTP surface — WK-04 timeline (x94) and WK-08 saved views (x107).
 *
 * The same shape and the same tenant rule as `WorkItemsController`: no `organizationId` is read
 * from anywhere, because `TenantContextGuard` built the `TenantContext` and there is no field for
 * a caller to supply one.
 *
 * Everything here sits behind `@RequireCapability('work.read')` — the sibling work reads'
 * capability, **reused** so this slice stays off `capabilities.ts`/`role-operation-grid.ts` (a
 * dedicated work-views capability is the follow-up; NEXT-SCOPES §x94). The saved-view *writes* are
 * a deliberate reuse of the read capability as the route ceiling: the real authorization is the
 * object-level rule the service applies — a person may create and edit only their **own** view —
 * which a route guard, with no object loaded, cannot express.
 */
@Controller('v1/organizations/:orgSlug/work-views')
export class WorkViewsController {
  constructor(@Inject(WORK_VIEWS_SERVICE) private readonly workViews: WorkViewsService) {}

  /**
   * A project's work items with their dates and predecessor edges, ordered for a timeline. A pure
   * read composed from the existing work + work-graph reads; nothing here writes.
   */
  @Get('timeline/:projectId')
  @RequireCapability('work.read')
  async timeline(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<WorkTimelineView> {
    return this.workViews.projectTimeline(context, principal, projectId);
  }

  /**
   * A project's open work grouped by assignee, with per-assignee counts and derived load, ordered
   * for a workload list. A pure read composed from the existing work read; nothing here writes.
   * Behind the same reused `work.read` capability as the timeline above.
   */
  @Get('workload/:projectId')
  @RequireCapability('work.read')
  async workload(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<WorkloadView> {
    return this.workViews.projectWorkload(context, principal, projectId);
  }

  /**
   * A project's open work items bucketed by date into a calendar grid over a requested range. A
   * pure read composed from the existing work read; nothing here writes. `from`/`to` are required
   * `YYYY-MM-DD` days, both ends inclusive — an unbounded calendar is not a calendar.
   */
  @Get('calendar/:projectId')
  @RequireCapability('work.read')
  async calendar(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<WorkCalendarView> {
    const range = parseCalendarRange(from, to);

    return this.workViews.projectCalendar(context, principal, projectId, range);
  }
  /** The caller's own saved views plus the views shared inside their studio, deterministically. */
  @Get('saved')
  @RequireCapability('work.read')
  async listSaved(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly savedViews: readonly SavedViewView[] }> {
    return { savedViews: await this.workViews.listSavedViews(context, principal) };
  }

  /** Persist a new saved view owned by the acting user. */
  @Post('saved')
  @RequireCapability('work.read')
  @HttpCode(201)
  async createSaved(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: SavedViewBody,
  ): Promise<SavedViewView> {
    return this.workViews.createSavedView(context, principal, parseSavedViewBody(body));
  }

  /** Replace the editable fields of a saved view the acting user owns. */
  @Put('saved/:savedViewId')
  @RequireCapability('work.read')
  async updateSaved(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('savedViewId') savedViewId: string,
    @Body() body: SavedViewBody,
  ): Promise<SavedViewView> {
    return this.workViews.updateSavedView(
      context,
      principal,
      savedViewId,
      parseSavedViewBody(body),
    );
  }
}

interface SavedViewBody {
  readonly name?: unknown;
  readonly projectId?: unknown;
  readonly config?: unknown;
  readonly shared?: unknown;
}

/** `saved_views.name` is `VARCHAR(300)`. */
const MAX_NAME_LENGTH = 300;
/** A view remembers a handful of filters and columns, not an unbounded document. */
const MAX_CONFIG_ENTRIES = 100;
/** A filter field/value and a column name are short handles, not prose. */
const MAX_CONFIG_STRING_LENGTH = 300;

/**
 * Validate the request body into a {@link SavedViewInput}, or throw a 400 with field details.
 *
 * `projectId` is optional: absent or `null` means an org-wide view. `config` is required and its
 * shape is checked here — a filter is a `{ field, value }` of short strings, `grouping` is a short
 * string or `null`, and `columns` is a bounded list of short strings — so a malformed or unbounded
 * blob never reaches the JSON column.
 */
function parseSavedViewBody(body: SavedViewBody): SavedViewInput {
  const details: { field: string; message: string }[] = [];

  const name = typeof body?.name === 'string' ? body.name.trim() : undefined;
  if (!name) details.push({ field: 'name', message: 'must be a non-empty string' });
  else if (name.length > MAX_NAME_LENGTH) {
    details.push({ field: 'name', message: `must be ${MAX_NAME_LENGTH} characters or fewer` });
  }

  let projectId: string | null = null;
  if (body?.projectId !== undefined && body?.projectId !== null) {
    if (typeof body.projectId === 'string' && body.projectId !== '') projectId = body.projectId;
    else details.push({ field: 'projectId', message: 'must be a non-empty string or null' });
  }

  const shared = body?.shared === undefined ? false : body.shared;
  if (typeof shared !== 'boolean') {
    details.push({ field: 'shared', message: 'must be a boolean' });
  }

  const config = parseConfig(body?.config, details);

  if (details.length > 0 || !name || config === undefined || typeof shared !== 'boolean') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  return { projectId, name, config, shared };
}

function parseConfig(
  raw: unknown,
  details: { field: string; message: string }[],
): SavedViewConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    details.push({ field: 'config', message: 'must be an object' });
    return undefined;
  }
  const record = raw as Record<string, unknown>;

  const filters: { field: string; value: string }[] = [];
  const rawFilters = record['filters'];
  if (!Array.isArray(rawFilters)) {
    details.push({ field: 'config.filters', message: 'must be an array' });
  } else if (rawFilters.length > MAX_CONFIG_ENTRIES) {
    details.push({ field: 'config.filters', message: `must have ${MAX_CONFIG_ENTRIES} or fewer` });
  } else {
    for (const [index, entry] of rawFilters.entries()) {
      const item = entry as Record<string, unknown> | null;
      const field =
        item && typeof item['field'] === 'string' ? (item['field'] as string) : undefined;
      const value =
        item && typeof item['value'] === 'string' ? (item['value'] as string) : undefined;
      if (
        field === undefined ||
        value === undefined ||
        field.length > MAX_CONFIG_STRING_LENGTH ||
        value.length > MAX_CONFIG_STRING_LENGTH
      ) {
        details.push({
          field: `config.filters[${index}]`,
          message: 'must be { field, value } of strings',
        });
      } else {
        filters.push({ field, value });
      }
    }
  }

  let grouping: string | null = null;
  const rawGrouping = record['grouping'];
  if (rawGrouping !== undefined && rawGrouping !== null) {
    if (typeof rawGrouping === 'string' && rawGrouping.length <= MAX_CONFIG_STRING_LENGTH) {
      grouping = rawGrouping;
    } else {
      details.push({ field: 'config.grouping', message: 'must be a string or null' });
    }
  }

  const columns: string[] = [];
  const rawColumns = record['columns'];
  if (!Array.isArray(rawColumns)) {
    details.push({ field: 'config.columns', message: 'must be an array' });
  } else if (rawColumns.length > MAX_CONFIG_ENTRIES) {
    details.push({ field: 'config.columns', message: `must have ${MAX_CONFIG_ENTRIES} or fewer` });
  } else {
    for (const [index, column] of rawColumns.entries()) {
      if (typeof column === 'string' && column.length <= MAX_CONFIG_STRING_LENGTH) {
        columns.push(column);
      } else {
        details.push({ field: `config.columns[${index}]`, message: 'must be a string' });
      }
    }
  }

  if (details.some((detail) => detail.field.startsWith('config'))) return undefined;
  return { filters, grouping, columns };
}
