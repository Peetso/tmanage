import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../common/http/errors.js';
import { DISPLAY_PREFERENCES_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import {
  DISPLAY_DATE_FORMATS,
  DISPLAY_DENSITIES,
  DISPLAY_LOCALES,
  DISPLAY_THEMES,
} from '../../common/database/schema.js';
import type {
  DisplayDateFormat,
  DisplayDensity,
  DisplayLocale,
  DisplayPreferences,
  DisplayTheme,
  DisplayTimezone,
} from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DisplayPreferencesRepository } from './display-prefs.repository.js';
import { isIanaTimeZone } from '../../common/time-zone.js';

/**
 * PREF-DISPLAY display preferences (x285, module 20 Preferences & accessibility) — the caller's own
 * theme / density / locale / timezone / date-format settings, read and replaced.
 *
 * ## Own settings only, and the capability reused rather than invented
 *
 * There is no membership in the path: the subject is the authenticated principal's membership, so no
 * caller can read or write another member's settings — the request has no way to name one. The
 * capability the controller enforces is **`work.read`**, the same choice A11Y-183's preferences made
 * (`12-PERMISSION-MATRIX` names no preferences capability, and pass-25 forbids editing
 * `capabilities.ts`). The service takes the acting `membershipId` as an argument and never a body
 * value, so the store is only ever reached for the caller's own row.
 *
 * ## PUT is a full replacement over closed vocabularies
 *
 * The body carries every setting and the upsert stores exactly it — a partial PUT would make "unset"
 * and "set to the default" indistinguishable, and the screen sends the whole form. {@link parseInput}
 * rejects an unknown key, and any value off its allowlist (theme, density, a BCP-47 locale, an IANA
 * timezone, a named date format): a malformed body is a 400 and nothing is written.
 */

/** What the GET/PUT route exchanges: the five display settings, without row identity. */
export interface DisplayPreferencesView {
  readonly theme: DisplayTheme;
  readonly density: DisplayDensity;
  readonly locale: DisplayLocale;
  readonly timezone: DisplayTimezone;
  readonly dateFormat: DisplayDateFormat;
}

/** The shipped defaults an unsaved member is reached by: follow the OS theme, comfortable, en-US, UTC, ISO. */
export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferencesView = {
  theme: 'system',
  density: 'comfortable',
  locale: 'en-US',
  timezone: 'UTC',
  dateFormat: 'iso',
};

/** The only keys a PUT body may carry — anything else is a 400 (fixed-key allowlist). */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'theme',
  'density',
  'locale',
  'timezone',
  'dateFormat',
]);

@Injectable()
export class DisplayPreferencesService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(DISPLAY_PREFERENCES_REPOSITORY)
    private readonly preferences: DisplayPreferencesRepository,
  ) {}

  /** The caller's own settings, or the shipped defaults when the member has never saved. */
  async read(context: TenantContext, membershipId: string): Promise<DisplayPreferencesView> {
    const row = await this.database.read(context, (runner) =>
      this.preferences.findForMembership(runner, context, membershipId),
    );
    return row ? viewOf(row.displayJson) : DEFAULT_DISPLAY_PREFERENCES;
  }

  /**
   * Validate the body against the closed vocabularies, upsert the caller's own row, and read it back.
   * A value off any allowlist throws a 400 before the transaction opens, so nothing is written.
   */
  async replace(
    context: TenantContext,
    membershipId: string,
    body: unknown,
  ): Promise<DisplayPreferencesView> {
    const settings = parseInput(body);
    return this.database.transaction(context, async (tx) => {
      await this.preferences.upsert(tx, context, membershipId, settings);
      const row = await this.preferences.findForMembership(tx, context, membershipId);
      return row ? viewOf(row.displayJson) : viewOf(settings);
    });
  }
}

function viewOf(settings: DisplayPreferences): DisplayPreferencesView {
  return {
    theme: settings.theme,
    density: settings.density,
    locale: settings.locale,
    timezone: settings.timezone,
    dateFormat: settings.dateFormat,
  };
}

function parseInput(body: unknown): DisplayPreferences {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  // Fixed-key allowlist: a key the store has no place for is the client's error, not a silent drop.
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      details.push({ field: key, message: 'is not a known preference' });
    }
  }

  const oneOf = <T extends string>(field: string, vocabulary: readonly T[]): T => {
    const raw = value[field];
    if (!(vocabulary as readonly unknown[]).includes(raw)) {
      details.push({ field, message: `must be one of ${vocabulary.join(', ')}` });
      return vocabulary[0]!;
    }
    return raw as T;
  };

  const theme = oneOf('theme', DISPLAY_THEMES);
  const density = oneOf('density', DISPLAY_DENSITIES);
  const locale = oneOf('locale', DISPLAY_LOCALES);
  const rawTimezone = value['timezone'];
  let timezone: DisplayTimezone = 'UTC';
  if (isIanaTimeZone(rawTimezone)) {
    timezone = rawTimezone;
  } else {
    details.push({ field: 'timezone', message: 'must be an IANA time zone' });
  }
  const dateFormat = oneOf('dateFormat', DISPLAY_DATE_FORMATS);

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The display preferences are invalid', details);
  }

  return { theme, density, locale, timezone, dateFormat };
}
