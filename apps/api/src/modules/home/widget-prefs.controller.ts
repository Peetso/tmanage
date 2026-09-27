import { Body, Controller, Get, HttpCode, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { HOME_WIDGET_PREFS_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import { HOME_WIDGET_IDS } from '../../common/database/schema.js';
import type { HomeWidgetId, HomeWidgetPrefs } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { HomeWidgetPrefsRepository } from './widget-prefs.repository.js';

/**
 * Home widget preferences — the caller's own Home widget layout, read and replaced (module 4 Home /
 * My Day, x243).
 *
 * ## Own layout only, and the capability reused rather than invented
 *
 * There is no membership in the path: the subject is the authenticated `principal`'s membership, so
 * no caller can read or write another member's layout — the request has no way to name one. The
 * capability is **`work.read`**, the same choice A11Y-183's and NOTIF-001's preferences made:
 * `12-PERMISSION-MATRIX` names no preferences capability, `work.read` is the one every internal role
 * holds and no client role does, and adding a widget-prefs capability would put a word in the ceiling
 * table the matrix does not have (pass-23 forbids editing `capabilities.ts`). The control that
 * matters is here, not in the coarse guard: a member reads and writes their own row and nothing else.
 *
 * ## PUT is a full replacement over a fixed widget-id allowlist
 *
 * The body carries the whole layout and the upsert stores exactly it — a partial PUT would make
 * "unset" and "set to the default" indistinguishable, and the customise panel sends the whole
 * layout. Validation is here rather than in the store because a malformed body is the client's error
 * to be told about (400), not a state the store should ever hold: a non-array field, an id outside
 * the fixed {@link HOME_WIDGET_IDS} allowlist, or a list longer than the number of known widgets is a
 * 400 and nothing is written. The order is de-duplicated (first occurrence wins) so a repeated id
 * cannot bloat a member's saved layout.
 */

/** What the GET/PUT route exchanges: the member's Home widget order and hidden set, without row identity. */
export interface HomeWidgetPrefsView {
  readonly order: readonly HomeWidgetId[];
  readonly hidden: readonly HomeWidgetId[];
}

/** The shipped default an unsaved member is reached by: every widget shown, in the declared order. */
export const DEFAULT_HOME_WIDGET_PREFS: HomeWidgetPrefsView = {
  order: [],
  hidden: [],
};

/** The set of known widget ids, for O(1) membership checks against the fixed allowlist. */
const KNOWN_WIDGETS: ReadonlySet<string> = new Set(HOME_WIDGET_IDS);

@Controller('v1/organizations/:orgSlug/home/widget-prefs')
export class HomeWidgetPrefsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(HOME_WIDGET_PREFS_REPOSITORY)
    private readonly prefs: HomeWidgetPrefsRepository,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<HomeWidgetPrefsView> {
    const row = await this.database.read(context, (runner) =>
      this.prefs.findForMembership(runner, context, principal.membershipId),
    );
    return row
      ? { order: row.widgetOrderJson, hidden: row.hiddenWidgetsJson }
      : DEFAULT_HOME_WIDGET_PREFS;
  }

  @Put()
  @RequireCapability('work.read')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<HomeWidgetPrefsView> {
    const layout = parseInput(body);
    return this.database.transaction(context, async (tx) => {
      await this.prefs.upsert(tx, context, principal.membershipId, layout);
      const row = await this.prefs.findForMembership(tx, context, principal.membershipId);
      return row
        ? { order: row.widgetOrderJson, hidden: row.hiddenWidgetsJson }
        : { order: layout.order, hidden: layout.hidden };
    });
  }
}

/**
 * Validate a PUT body into a stored layout: `order` and `hidden` must be arrays of known widget ids,
 * each id validated against the fixed allowlist, the order de-duplicated (first occurrence wins), and
 * each list no longer than the number of known widgets. Any failure is a single 400 and nothing is
 * written.
 */
function parseInput(body: unknown): HomeWidgetPrefs {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const order = validateList(value['order'], 'order', details);
  const hidden = validateList(value['hidden'], 'hidden', details);

  if (details.length > 0) {
    throw new ApiError(
      400,
      'validation_failed',
      'The home widget preferences are invalid',
      details,
    );
  }

  // De-duplicate the order, first occurrence wins, so a repeated id cannot bloat the saved layout.
  return { order: dedupe(order), hidden: dedupe(hidden) };
}

/** A field must be an array of known widget ids, bounded by the number of known widgets. */
function validateList(
  raw: unknown,
  field: string,
  details: { field: string; message: string }[],
): HomeWidgetId[] {
  if (!Array.isArray(raw)) {
    details.push({ field, message: 'must be an array of widget ids' });
    return [];
  }
  if (raw.length > HOME_WIDGET_IDS.length) {
    details.push({ field, message: `must not name more than ${HOME_WIDGET_IDS.length} widgets` });
  }
  const ids: HomeWidgetId[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !KNOWN_WIDGETS.has(entry)) {
      details.push({ field, message: `contains an unknown widget id: ${String(entry)}` });
      continue;
    }
    ids.push(entry as HomeWidgetId);
  }
  return ids;
}

function dedupe(ids: readonly HomeWidgetId[]): HomeWidgetId[] {
  return [...new Set(ids)];
}
