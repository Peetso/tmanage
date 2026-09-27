import { Body, Controller, Get, HttpCode, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { QUIET_HOURS_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { QuietHours } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { isWithinQuietHours } from './quiet-hours.service.js';
import type { QuietHoursRepository } from './quiet-hours.repository.js';

/**
 * PREF-QUIET notification quiet hours — the caller's own do-not-disturb window, read, replaced, and
 * evaluated (module 20 Preferences & accessibility, x215).
 *
 * ## Own settings only, and the capability reused rather than invented
 *
 * There is no membership in the path: the subject is the authenticated `principal`'s membership, so
 * no caller can read or write another member's window — the request has no way to name one. The
 * capability is **`work.read`**, the same choice and reason the sibling preferences slices (x182/x183)
 * made: `12-PERMISSION-MATRIX` names no preferences capability, `work.read` is the one every internal
 * role holds and no client role does, and pass-22 forbids editing `capabilities.ts`. The control that
 * matters is here: a member reads and writes their own row and nothing else.
 *
 * ## PUT is a full replacement over a fixed-key allowlist
 *
 * The body carries every setting and the upsert stores exactly it — a partial PUT would make "unset"
 * and "set to the default" indistinguishable, and the screen sends the whole form. Validation is here
 * rather than in the store because a malformed body is the client's error to be told about (400), not
 * a state the store should ever hold: an unknown key, a malformed time, an unknown timezone, or a
 * weekday outside 0–6 is a 400 and nothing is written.
 *
 * ## The active check uses the stored timezone and a bound clock
 *
 * `GET .../active` computes whether *now* is inside the window in the member's stored timezone via a
 * bound `new Date()` — never the database clock (the admin-pool-clock trap). Absence of a row reads
 * the shipped default (disabled), so the active answer is `false`.
 */

/** What the GET/PUT route exchanges: the whole quiet-hours window, without row identity. */
export interface QuietHoursView {
  readonly enabled: boolean;
  readonly startTime: string;
  readonly endTime: string;
  readonly timezone: string;
  readonly days: readonly number[];
}

/** What `GET .../active` returns: whether the caller is currently inside their quiet-hours window. */
export interface QuietHoursActiveView {
  readonly active: boolean;
}

/** The shipped default an unsaved member reads by: disabled, a night window, every weekday, UTC. */
export const DEFAULT_QUIET_HOURS: QuietHoursView = {
  enabled: false,
  startTime: '22:00',
  endTime: '07:00',
  timezone: 'UTC',
  days: [0, 1, 2, 3, 4, 5, 6],
};

/** The only keys a PUT body may carry — anything else is a 400 (fixed-key allowlist). */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'startTime',
  'endTime',
  'timezone',
  'days',
]);

/** `HH:MM`, 24-hour: 00:00 through 23:59. */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

@Controller('v1/organizations/:orgSlug/preferences/quiet-hours')
export class QuietHoursController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(QUIET_HOURS_REPOSITORY) private readonly repository: QuietHoursRepository,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<QuietHoursView> {
    const row = await this.database.read(context, (runner) =>
      this.repository.findForMembership(runner, context, principal.membershipId),
    );
    return row ? viewOf(row.quietJson) : DEFAULT_QUIET_HOURS;
  }

  @Get('active')
  @RequireCapability('work.read')
  async active(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<QuietHoursActiveView> {
    const row = await this.database.read(context, (runner) =>
      this.repository.findForMembership(runner, context, principal.membershipId),
    );
    const settings = row ? row.quietJson : DEFAULT_QUIET_HOURS;
    // A bound clock, not the DB clock: the compute is a pure function of the settings and this instant.
    return { active: isWithinQuietHours(settings, new Date()) };
  }

  @Put()
  @RequireCapability('work.read')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<QuietHoursView> {
    const settings = parseInput(body);
    return this.database.transaction(context, async (tx) => {
      await this.repository.upsert(tx, context, principal.membershipId, settings);
      const row = await this.repository.findForMembership(tx, context, principal.membershipId);
      return row ? viewOf(row.quietJson) : viewOf(settings);
    });
  }
}

function viewOf(settings: QuietHours): QuietHoursView {
  return {
    enabled: settings.enabled,
    startTime: settings.startTime,
    endTime: settings.endTime,
    timezone: settings.timezone,
    days: [...settings.days],
  };
}

/** Whether the runtime accepts `timezone` as an IANA zone — `Intl` throws `RangeError` if it does not. */
function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function parseInput(body: unknown): QuietHours {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  // Fixed-key allowlist: a key the store has no column for is the client's error, not a silent drop.
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      details.push({ field: key, message: 'is not a known preference' });
    }
  }

  const enabled = value['enabled'];
  if (typeof enabled !== 'boolean') {
    details.push({ field: 'enabled', message: 'must be a boolean' });
  }

  const time = (field: string): string => {
    const raw = value[field];
    if (typeof raw !== 'string' || !TIME_PATTERN.test(raw)) {
      details.push({ field, message: 'must be a time in HH:MM 24-hour format' });
      return '00:00';
    }
    return raw;
  };
  const startTime = time('startTime');
  const endTime = time('endTime');

  const timezoneRaw = value['timezone'];
  let timezone = 'UTC';
  if (
    typeof timezoneRaw !== 'string' ||
    timezoneRaw.length === 0 ||
    !isKnownTimezone(timezoneRaw)
  ) {
    details.push({ field: 'timezone', message: 'must be a valid IANA timezone' });
  } else {
    timezone = timezoneRaw;
  }

  const daysRaw = value['days'];
  const days: number[] = [];
  if (!Array.isArray(daysRaw)) {
    details.push({ field: 'days', message: 'must be an array of weekdays (0–6)' });
  } else {
    const seen = new Set<number>();
    for (const day of daysRaw) {
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) {
        details.push({
          field: 'days',
          message: 'each day must be an integer 0–6 (Sunday–Saturday)',
        });
        break;
      }
      if (seen.has(day)) {
        details.push({ field: 'days', message: 'days must not repeat' });
        break;
      }
      seen.add(day);
      days.push(day);
    }
  }

  if (details.length > 0) {
    throw new ApiError(
      400,
      'validation_failed',
      'The quiet-hours preferences are invalid',
      details,
    );
  }

  return { enabled: enabled as boolean, startTime, endTime, timezone, days };
}
