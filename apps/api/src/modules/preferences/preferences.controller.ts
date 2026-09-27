import { Body, Controller, Get, HttpCode, Inject, Optional, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import {
  DENSITY_PREFERENCES,
  PREFERENCE_LOCALES,
  THEME_PREFERENCES,
} from '../../common/database/schema.js';
import type {
  DensityPreference,
  PreferenceLocale,
  ThemePreference,
  UserPreferencesJson,
} from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PreferencesRepository } from './preferences.repository.js';

/**
 * PREF-001 appearance & accessibility preferences (x182) — the caller's own settings, read and
 * replaced. The audit named the appearance/locale surface absent (Preferences Partial 1.0); this is
 * it, distinct from the notification preferences (delivery channels) already built.
 *
 * ## Own settings only, and the capability reused rather than invented
 *
 * There is no membership in the path: the row is always the acting `context.membershipId`, so no
 * caller can read or write another member's settings — the request has no way to name one, and the
 * repository would ignore one if it did. The capability is **`work.read`**, the choice the sibling
 * self-scoped Home and notification-preferences routes made and for the same reason: it is the one
 * every internal role holds and no client role does, so a client principal is refused 403 by
 * `CapabilityGuard` before any handler runs, and this slice adds no word to `capabilities.ts`.
 *
 * ## PUT is a full replacement behind a fixed-key allowlist
 *
 * The body carries every setting and the upsert stores exactly it — a partial PUT would make "unset"
 * and "set to the default" indistinguishable, and the settings screen sends the whole form. Each key
 * is checked against its closed vocabulary here rather than in the store: an off-list key or value is
 * the client's error to be told about (400 with no write), never a `prefs_json` blob the appearance
 * surface cannot render.
 */
export interface UserPreferencesView {
  readonly theme: ThemePreference;
  readonly locale: PreferenceLocale;
  readonly density: DensityPreference;
}

/** Never-saved and saved-the-defaults answer identically: system theme, English, comfortable. */
export const DEFAULT_USER_PREFERENCES: UserPreferencesView = {
  theme: 'system',
  locale: 'en',
  density: 'comfortable',
};

@Controller('v1/organizations/:orgSlug/me/preferences')
export class PreferencesController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional() private readonly preferences: PreferencesRepository = new PreferencesRepository(),
  ) {}

  /** The acting member's settings, defaults if they have never saved (200). */
  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
  ): Promise<UserPreferencesView> {
    const row = await this.database.read(context, (runner) =>
      this.preferences.findForMembership(runner, context, context.membershipId),
    );
    return row ? viewOf(row.prefsJson) : DEFAULT_USER_PREFERENCES;
  }

  /**
   * Replace the acting member's settings and return what is now stored (200 — nothing new created).
   * One transaction: the upsert and the read that confirms it see the same row, so the response is
   * the persisted state. Own-membership: the write is scoped to `context.membershipId`, so no other
   * member's row is reachable or writable.
   */
  @Put()
  @RequireCapability('work.read')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Body() body: unknown,
  ): Promise<UserPreferencesView> {
    const prefs = parsePreferences(body);
    return this.database.transaction(context, async (tx) => {
      await this.preferences.upsert(tx, context, context.membershipId, prefs);
      const row = await this.preferences.findForMembership(tx, context, context.membershipId);
      return row ? viewOf(row.prefsJson) : prefs;
    });
  }
}

/** The stored blob, projected to the wire shape — a total copy, so an extra stored key never leaks. */
function viewOf(prefs: UserPreferencesJson): UserPreferencesView {
  return { theme: prefs.theme, locale: prefs.locale, density: prefs.density };
}

/**
 * Validate the body against the three closed vocabularies. Every key is required and must be in its
 * allowlist; an off-list key or value is a 400 with no write, so `prefs_json` never holds a value the
 * appearance surface cannot render.
 */
function parsePreferences(body: unknown): UserPreferencesJson {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const oneOf = <T extends string>(field: string, allow: readonly T[]): T => {
    const raw = value[field];
    if (typeof raw !== 'string' || !(allow as readonly string[]).includes(raw)) {
      details.push({ field, message: `must be one of ${allow.join(', ')}` });
      return allow[0]!;
    }
    return raw as T;
  };

  const theme = oneOf('theme', THEME_PREFERENCES);
  const locale = oneOf('locale', PREFERENCE_LOCALES);
  const density = oneOf('density', DENSITY_PREFERENCES);

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The preferences are invalid', details);
  }

  return { theme, locale, density };
}
