import { Inject, Injectable } from '@nestjs/common';
import { isDictationLanguageTag } from '@tmanage/domain';
import type { DictationLanguageTag } from '@tmanage/domain';
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
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type {
  AccountDisplayDefaults,
  DisplayPreferencesRepository,
} from './display-prefs.repository.js';
import { isIanaTimeZone } from '../../common/time-zone.js';
import { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import { UI_MODES, defaultFor, parseLockedRoles } from '../tenancy/org-settings.allowlist.js';
import type { UiMode } from '../tenancy/org-settings.allowlist.js';

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
 *
 * ## 55-04 (R20-c): Simple / Power mode
 *
 * `uiMode` is one optional key inside the same `display_json` (no migration): absent = inherit the
 * org's `default_ui_mode` setting (deviation from the plan's ENUM column, stated here). The GET
 * returns the **effective** mode, where it came from (`self` / `org_default`) and whether the
 * caller's role is in `ui_mode_locked_roles`. A locked role always reads the org default, and a PUT
 * whose `uiMode` differs from it is a 409 `conflict` (detail `ui_mode_locked`) before anything is written (the PUT is one
 * document, so the other fields are not saved either); omitting `uiMode` or sending the org default
 * is accepted. The mode changes no capability — it is never an authorization input.
 */

/** What the GET/PUT route exchanges: the display settings (55-07 adds numerals and calendarDisplay), without row identity. */
export interface DisplayPreferencesView {
  readonly theme: DisplayTheme;
  readonly density: DisplayDensity;
  readonly locale: DisplayLocale;
  readonly timezone: DisplayTimezone;
  readonly dateFormat: DisplayDateFormat;
  readonly numerals: DisplayNumerals;
  readonly calendarDisplay: DisplayCalendar;
  /** C24. The first day of the week calendars and week pickers start on. */
  readonly weekStart: DisplayWeekStart;
  /**
   * AI panel (2026-11-23). The voice-dictation language (BCP-47, one of the domain's 17), or
   * `null` = the app language. A PUT without the key keeps the stored choice; `null` clears it.
   */
  readonly dictationLanguage: DictationLanguageTag | null;
  /** 55-04. The effective shell mode: the member's own, else (or when locked) the org default. */
  readonly uiMode: UiMode;
  readonly uiModeSource: 'self' | 'org_default';
  /** 55-04. The caller's role is in `ui_mode_locked_roles`: the screen hides the switch. */
  readonly uiModeLocked: boolean;
}

/** The stored display settings without the computed 55-04 fields — what the shipped defaults are. */
export type StoredDisplayPreferencesView = Omit<
  DisplayPreferencesView,
  'uiMode' | 'uiModeSource' | 'uiModeLocked'
>;

/** 55-04. The org side of the mode, read with the member's row. */
interface OrgUiMode {
  readonly defaultMode: UiMode;
  readonly locked: boolean;
}

/**
 * 55-07 (R18-d) — digit shapes and the calendar shown beside dates. Both are optional in a PUT body
 * and in a stored row: a row saved before 55-07 has neither and reads as `latin` / `gregorian`.
 *
 * Hijri is **display-only**: it changes how a date is rendered on the person's own screen, is never
 * stored on a record, and is never emitted to `product_events` (PDPL data minimisation — a calendar
 * choice can hint at religion, so no analytics stream receives it). This service writes no event.
 */
export const DISPLAY_NUMERALS = ['latin', 'arabic_indic'] as const;
export type DisplayNumerals = (typeof DISPLAY_NUMERALS)[number];
export const DISPLAY_CALENDARS = ['gregorian', 'gregorian_hijri'] as const;
export type DisplayCalendar = (typeof DISPLAY_CALENDARS)[number];
/** C24 — the first day of the member's week (Saturday is common across the region). Optional like 55-07's keys. */
export const DISPLAY_WEEK_STARTS = ['monday', 'sunday', 'saturday'] as const;
export type DisplayWeekStart = (typeof DISPLAY_WEEK_STARTS)[number];

/**
 * The shipped defaults an unsaved member is reached by: follow the OS theme, comfortable, en-US, UTC,
 * ISO. 55-04 adds no default here — the effective mode is computed from the org, never stored.
 */
export const DEFAULT_DISPLAY_PREFERENCES: StoredDisplayPreferencesView = {
  theme: 'system',
  density: 'comfortable',
  locale: 'en-US',
  timezone: 'UTC',
  dateFormat: 'iso',
  numerals: 'latin',
  calendarDisplay: 'gregorian',
  weekStart: 'monday',
  dictationLanguage: null,
};

/** The only keys a PUT body may carry — anything else is a 400 (fixed-key allowlist). */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'theme',
  'density',
  'locale',
  'timezone',
  'dateFormat',
  'numerals',
  'calendarDisplay',
  'weekStart',
  'uiMode',
  'dictationLanguage',
]);

@Injectable()
export class DisplayPreferencesService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(DISPLAY_PREFERENCES_REPOSITORY)
    private readonly preferences: DisplayPreferencesRepository,
    /** 55-04. The org default mode and the locked roles — tenancy's repository, used not edited. */
    @Inject(OrgSettingsRepository)
    private readonly orgSettings: OrgSettingsRepository = new OrgSettingsRepository(),
  ) {}

  /**
   * The caller's own settings, or the shipped defaults when the member has never saved, with the
   * effective 55-04 mode computed against the org default and the caller's `role`.
   */
  async read(
    context: TenantContext,
    membershipId: string,
    role: string,
  ): Promise<DisplayPreferencesView> {
    return this.database.read(context, async (runner) => {
      const row = await this.preferences.findForMembership(runner, context, membershipId);
      const org = await this.orgUiMode(runner, context, role);
      if (row) return viewOf(row.displayJson, org);
      const account = await this.preferences.findAccountDefaults(runner, context);
      return viewOf(accountDefaultsOf(account), org);
    });
  }

  /**
   * Validate the body against the closed vocabularies, upsert the caller's own row, and read it back.
   * A value off any allowlist throws a 400 before the transaction opens, and a locked role leaving
   * the org default throws a 409 before the upsert, so nothing is written in either case.
   */
  async replace(
    context: TenantContext,
    membershipId: string,
    role: string,
    body: unknown,
  ): Promise<DisplayPreferencesView> {
    const settings = parseInput(body);
    return this.database.transaction(context, async (tx) => {
      const org = await this.orgUiMode(tx, context, role);
      if (org.locked && settings.uiMode !== undefined && settings.uiMode !== org.defaultMode) {
        throw new ApiError(
          409,
          'conflict',
          'Your role uses the organization’s default mode; an admin has locked it.',
          // The reason token rides in details (errors.ts' code union is shared, not edited here).
          [{ field: 'uiMode', message: 'ui_mode_locked' }],
          'ui_mode_locked',
        );
      }
      const stored = await this.preferences.findForMembership(tx, context, membershipId);
      const kept =
        settings.dictationLanguage === undefined &&
        stored?.displayJson.dictationLanguage !== undefined
          ? { ...settings, dictationLanguage: stored.displayJson.dictationLanguage }
          : settings;
      await this.preferences.upsert(tx, context, membershipId, kept);
      const row = await this.preferences.findForMembership(tx, context, membershipId);
      return viewOf(row ? row.displayJson : kept, org);
    });
  }

  /** 55-04. The org default mode (stored, else `simple`) and whether `role` is locked to it. */
  private async orgUiMode(
    runner: TenantQueryRunner,
    context: TenantContext,
    role: string,
  ): Promise<OrgUiMode> {
    const defaultRow = await this.orgSettings.findByKey(runner, context, 'default_ui_mode');
    const lockedRow = await this.orgSettings.findByKey(runner, context, 'ui_mode_locked_roles');
    const stored = defaultRow?.settingValue ?? defaultFor('default_ui_mode');
    const defaultMode = UI_MODES.find((mode) => mode === stored) ?? UI_MODES[0];
    return { defaultMode, locked: parseLockedRoles(lockedRow?.settingValue).includes(role) };
  }
}

/**
 * TESTUX P0 2 — the display locale an account language tag maps to: the exact allowlisted locale,
 * else the first allowlisted locale of the same language (`ar` → `ar-EG`, `fr` → `fr-FR`), else the
 * shipped default. Sign-up stores the page's language on the account, which may be a bare language.
 */
export function displayLocaleFor(tag: string | null | undefined): DisplayLocale {
  const wanted = (tag ?? '').trim().toLowerCase();
  const exact = DISPLAY_LOCALES.find((locale) => locale.toLowerCase() === wanted);
  if (exact !== undefined) return exact;
  const language = wanted.split('-')[0] ?? '';
  return (
    DISPLAY_LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === language) ??
    DEFAULT_DISPLAY_PREFERENCES.locale
  );
}

/**
 * What a member who has never saved is shown: the shipped defaults in the language and zone their
 * account was created with, so an owner who signed up on `/ar` opens an Arabic workspace.
 */
function accountDefaultsOf(account: AccountDisplayDefaults | null): StoredDisplayPreferencesView {
  if (account === null) return DEFAULT_DISPLAY_PREFERENCES;
  return {
    ...DEFAULT_DISPLAY_PREFERENCES,
    locale: displayLocaleFor(account.locale),
    timezone: isIanaTimeZone(account.timezone)
      ? account.timezone
      : DEFAULT_DISPLAY_PREFERENCES.timezone,
  };
}

function viewOf(settings: DisplayPreferences, org: OrgUiMode): DisplayPreferencesView {
  const own = settings.uiMode;
  const useOwn = own !== undefined && !org.locked;
  return {
    theme: settings.theme,
    density: settings.density,
    locale: settings.locale,
    timezone: settings.timezone,
    dateFormat: settings.dateFormat,
    numerals: settings.numerals ?? DEFAULT_DISPLAY_PREFERENCES.numerals,
    calendarDisplay: settings.calendarDisplay ?? DEFAULT_DISPLAY_PREFERENCES.calendarDisplay,
    weekStart: settings.weekStart ?? DEFAULT_DISPLAY_PREFERENCES.weekStart,
    dictationLanguage: isDictationLanguageTag(settings.dictationLanguage)
      ? settings.dictationLanguage
      : null,
    uiMode: useOwn ? own : org.defaultMode,
    uiModeSource: useOwn ? 'self' : 'org_default',
    uiModeLocked: org.locked,
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
  // 55-07: optional keys — absent means the default, present must be on the vocabulary.
  const numerals =
    value['numerals'] === undefined
      ? DEFAULT_DISPLAY_PREFERENCES.numerals
      : oneOf('numerals', DISPLAY_NUMERALS);
  const calendarDisplay =
    value['calendarDisplay'] === undefined
      ? DEFAULT_DISPLAY_PREFERENCES.calendarDisplay
      : oneOf('calendarDisplay', DISPLAY_CALENDARS);
  const weekStart =
    value['weekStart'] === undefined
      ? DEFAULT_DISPLAY_PREFERENCES.weekStart
      : oneOf('weekStart', DISPLAY_WEEK_STARTS);
  // 55-04: optional, and absent stays absent — it means "inherit the org default", not a value.
  const uiMode = value['uiMode'] === undefined ? undefined : oneOf('uiMode', UI_MODES);
  const rawDictation = value['dictationLanguage'];
  if (
    rawDictation !== undefined &&
    rawDictation !== null &&
    !isDictationLanguageTag(rawDictation)
  ) {
    details.push({ field: 'dictationLanguage', message: 'must be a dictation language or null' });
  }

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The display preferences are invalid', details);
  }

  return {
    theme,
    density,
    locale,
    timezone,
    dateFormat,
    numerals,
    calendarDisplay,
    weekStart,
    ...(uiMode === undefined ? {} : { uiMode }),
    ...(rawDictation === undefined
      ? {}
      : { dictationLanguage: isDictationLanguageTag(rawDictation) ? rawDictation : null }),
  };
}
