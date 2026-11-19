import { Body, Controller, Get, HttpCode, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { DIGEST_PREF_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import { DIGEST_CADENCE } from '../../common/database/schema.js';
import type { DigestCadence, DigestPreference } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DigestPreferenceRepository } from './digest.repository.js';

/**
 * PREF-DIGEST notification digest cadence — the caller's own digest-frequency preference, read and
 * replaced (module 20 Preferences & accessibility, x245).
 *
 * ## Own settings only, and the capability reused rather than invented
 *
 * There is no membership in the path: the subject is the authenticated `principal`'s membership, so
 * no caller can read or write another member's cadence — the request has no way to name one. The
 * capability is **`work.read`**, the same choice and reason the sibling preferences slices
 * (x182/x183/x215) made: `12-PERMISSION-MATRIX` names no preferences capability, `work.read` is the
 * one every internal role holds and no client role does, and the pass forbids editing
 * `capabilities.ts`. The control that matters is here: a member reads and writes their own row and
 * nothing else.
 *
 * ## PUT is a full replacement over a fixed-key allowlist
 *
 * The body carries every setting and the upsert stores exactly it — a partial PUT would make "unset"
 * and "set to the default" indistinguishable, and the screen sends the whole form. Validation is here
 * rather than in the store because a malformed body is the client's error to be told about (400), not
 * a state the store should ever hold: an unknown key, a cadence off the closed vocabulary, a send
 * hour outside 0–23, or a weekday outside 0–6 is a 400 and nothing is written.
 *
 * ## No dispatch here
 *
 * This is preference storage only. The worker's digest sweep (53-15, `notification-digest.ts`)
 * reads this row; the cadence and the briefing switch a member saves are read back exactly.
 */

/** What the GET/PUT route exchanges: the whole digest cadence, without row identity. */
export interface DigestPrefView {
  readonly cadence: DigestCadence;
  readonly sendHour: number;
  readonly dayOfWeek: number;
  /**
   * 62-A1c (B12): the business briefing as one section of this mail. Off by default; one switch
   * per person. The worker adds the section only while the company's `business_briefing` flag is
   * on and the person has a briefing (the Home card's scope rules), and never sends an empty mail.
   */
  readonly businessBriefing: boolean;
}

/** The shipped default an unsaved member reads by: a daily digest at 08:00, weekday Monday. */
export const DEFAULT_DIGEST_PREFERENCE: DigestPrefView = {
  cadence: 'daily',
  sendHour: 8,
  dayOfWeek: 1,
  businessBriefing: false,
};

/** The only keys a PUT body may carry — anything else is a 400 (fixed-key allowlist). */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'cadence',
  'sendHour',
  'dayOfWeek',
  'businessBriefing',
]);

const CADENCES: ReadonlySet<string> = new Set(DIGEST_CADENCE);

@Controller('v1/organizations/:orgSlug/preferences/digest')
export class DigestPreferenceController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(DIGEST_PREF_REPOSITORY) private readonly repository: DigestPreferenceRepository,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DigestPrefView> {
    const row = await this.database.read(context, (runner) =>
      this.repository.findForMembership(runner, context, principal.membershipId),
    );
    return row ? viewOf(row.digestJson) : DEFAULT_DIGEST_PREFERENCE;
  }

  @Put()
  @RequireCapability('work.read')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<DigestPrefView> {
    const settings = parseInput(body);
    return this.database.transaction(context, async (tx) => {
      await this.repository.upsert(tx, context, principal.membershipId, settings);
      const row = await this.repository.findForMembership(tx, context, principal.membershipId);
      return row ? viewOf(row.digestJson) : viewOf(settings);
    });
  }
}

function viewOf(settings: DigestPreference): DigestPrefView {
  return {
    cadence: settings.cadence,
    sendHour: settings.sendHour,
    dayOfWeek: settings.dayOfWeek,
    businessBriefing: 'businessBriefing' in settings && settings.businessBriefing === true,
  };
}

function parseInput(body: unknown): DigestPreference {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  // Fixed-key allowlist: a key the store has no column for is the client's error, not a silent drop.
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      details.push({ field: key, message: 'is not a known preference' });
    }
  }

  const cadenceRaw = value['cadence'];
  if (typeof cadenceRaw !== 'string' || !CADENCES.has(cadenceRaw)) {
    details.push({ field: 'cadence', message: 'must be one of immediate, daily, or weekly' });
  }

  const integerInRange = (field: string, min: number, max: number): number => {
    const raw = value[field];
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
      details.push({ field, message: `must be an integer ${min}–${max}` });
      return min;
    }
    return raw;
  };
  const sendHour = integerInRange('sendHour', 0, 23);
  const dayOfWeek = integerInRange('dayOfWeek', 0, 6);

  // Optional so a body from before the switch still saves; a full replacement, so absent = off.
  const briefingRaw = value['businessBriefing'];
  if (briefingRaw !== undefined && typeof briefingRaw !== 'boolean') {
    details.push({ field: 'businessBriefing', message: 'must be true or false' });
  }

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The digest preferences are invalid', details);
  }

  return {
    cadence: cadenceRaw as DigestCadence,
    sendHour,
    dayOfWeek,
    businessBriefing: briefingRaw === true,
  };
}
