import { Body, Controller, Get, HttpCode, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { INSIGHT_DASHBOARD_LAYOUT_SERVICE } from '../../common/http/tokens.js';
import { INSIGHT_METRIC_KEYS } from '../../common/database/schema.js';
import type { InsightDashboardTile, InsightMetricKey } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { InsightDashboardLayoutService } from './dashboard-layout.service.js';

/**
 * Insight dashboard layout — the caller's own arrangement of the insights-dashboard metric tiles,
 * read and replaced (module 16 Insights, x302). Mirrors home widget preferences (x243) for the
 * insights surface.
 *
 * ## Own layout only, and the capability reused rather than invented
 *
 * There is no membership in the path: the subject is the authenticated `principal`'s membership, so
 * no caller can read or write another member's layout — the request has no way to name one. The
 * capability is **`work.read`**, the choice x243's Home widget prefs and the other per-member
 * preference surfaces made: `12-PERMISSION-MATRIX` names no preferences capability, `work.read` is
 * the one every internal role holds and no client role does, and adding a layout capability would
 * put a word in the ceiling table the matrix does not have (pass-25 forbids editing
 * `capabilities.ts`). The control that matters is here, not in the coarse guard: a member reads and
 * writes their own row and nothing else.
 *
 * ## PUT is a full replacement over a fixed metric-key allowlist
 *
 * The body carries the whole layout and the upsert stores exactly it — a partial PUT would make
 * "unset" and "set to the default" indistinguishable, and the customise panel sends the whole
 * layout. Validation is here rather than in the store because a malformed body is the client's error
 * to be told about (400), not a state the store should ever hold: a non-array `tiles`, an entry that
 * is not an object, a `key` outside the fixed {@link INSIGHT_METRIC_KEYS} allowlist, a duplicate
 * `key`, a `position` that is not a non-negative integer, a non-boolean `visible`, or a list longer
 * than the number of known metrics is a single 400 and nothing is written.
 */

/** What the GET/PUT route exchanges: the member's insight-dashboard tiles, without row identity. */
export interface InsightDashboardLayoutView {
  readonly tiles: readonly InsightDashboardTile[];
}

/** The set of known metric keys, for O(1) membership checks against the fixed allowlist. */
const KNOWN_METRICS: ReadonlySet<string> = new Set(INSIGHT_METRIC_KEYS);

@Controller('v1/organizations/:orgSlug/insights/dashboard-layout')
export class InsightDashboardLayoutController {
  constructor(
    @Inject(INSIGHT_DASHBOARD_LAYOUT_SERVICE)
    private readonly layouts: InsightDashboardLayoutService,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<InsightDashboardLayoutView> {
    const tiles = await this.layouts.getForMembership(context, principal.membershipId);
    return { tiles };
  }

  @Put()
  @RequireCapability('work.read')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<InsightDashboardLayoutView> {
    const tiles = parseInput(body);
    const saved = await this.layouts.saveForMembership(context, principal.membershipId, tiles);
    return { tiles: saved };
  }
}

/**
 * Validate a PUT body into a stored tile list: `tiles` must be an array, no longer than the number
 * of known metrics, of objects whose `key` is in the fixed allowlist (no duplicates), whose
 * `position` is a non-negative integer, and whose `visible` is a boolean. Any failure is a single
 * 400 and nothing is written.
 */
function parseInput(body: unknown): InsightDashboardTile[] {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const raw = value['tiles'];

  const tiles: InsightDashboardTile[] = [];
  if (!Array.isArray(raw)) {
    details.push({ field: 'tiles', message: 'must be an array of tiles' });
  } else {
    if (raw.length > INSIGHT_METRIC_KEYS.length) {
      details.push({
        field: 'tiles',
        message: `must not name more than ${INSIGHT_METRIC_KEYS.length} tiles`,
      });
    }
    const seen = new Set<string>();
    raw.forEach((entry, index) => {
      const tile = validateTile(entry, index, details);
      if (!tile) return;
      if (seen.has(tile.key)) {
        details.push({ field: `tiles[${index}].key`, message: `duplicate tile key: ${tile.key}` });
        return;
      }
      seen.add(tile.key);
      tiles.push(tile);
    });
  }

  if (details.length > 0) {
    throw new ApiError(
      400,
      'validation_failed',
      'The insight dashboard layout is invalid',
      details,
    );
  }
  return tiles;
}

/** A single tile: `{ key, position, visible }`, each field validated; any failure pushes a detail. */
function validateTile(
  entry: unknown,
  index: number,
  details: { field: string; message: string }[],
): InsightDashboardTile | null {
  if (typeof entry !== 'object' || entry === null) {
    details.push({ field: `tiles[${index}]`, message: 'must be an object' });
    return null;
  }
  const record = entry as Record<string, unknown>;
  const key = record['key'];
  const position = record['position'];
  const visible = record['visible'];
  let ok = true;

  if (typeof key !== 'string' || !KNOWN_METRICS.has(key)) {
    details.push({ field: `tiles[${index}].key`, message: `unknown metric key: ${String(key)}` });
    ok = false;
  }
  if (typeof position !== 'number' || !Number.isInteger(position) || position < 0) {
    details.push({ field: `tiles[${index}].position`, message: 'must be a non-negative integer' });
    ok = false;
  }
  if (typeof visible !== 'boolean') {
    details.push({ field: `tiles[${index}].visible`, message: 'must be a boolean' });
    ok = false;
  }
  if (!ok) return null;
  return {
    key: key as InsightMetricKey,
    position: position as number,
    visible: visible as boolean,
  };
}
