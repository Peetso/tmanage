/**
 * The organization-settings allowlist (Administration module 18, x153) — the substance of the slice.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION` §4 fixes that organization policy "may narrow, never
 * silently widen". The control that makes that safe here is that **there is no arbitrary key**: this
 * module is the single source of which settings exist, what they default to, and what a valid value
 * for each looks like. A PUT names a key; a key not in {@link ORG_SETTING_KEYS} is a 400 with no
 * write, and a value the key's validator rejects is a 400 with no write. Nothing outside this list
 * can ever reach the table.
 *
 * The role/capability editor (ADM-03) is deliberately not here — it is blocked pending the
 * permission-matrix work — and neither are security-policy escalations (NEXT-SCOPES-13). This is the
 * flat, validated key/value surface only.
 *
 * Values are stored as strings (`org_settings.setting_value` is `VARCHAR`). A validator's job is to
 * accept a string and return the *canonical* string form to store (e.g. a trimmed timezone, a
 * base-10 integer with no leading zeros, `'true'`/`'false'`), so what is read back is exactly what a
 * later reader will parse.
 */

import {
  AUTO_TRACKING_POLICIES,
  ASSIGNABLE_INTERNAL_ROLES,
  DEFAULT_AUTO_TRACKING_POLICY,
  CLIENT_ROLES,
  DEFAULT_TIME_TRUST_POLICY,
  HAND_TIME_COUNT_MODES,
  IDLE_CAP_DEFAULT_HOURS,
  IDLE_CAP_MAX_HOURS,
  IDLE_CAP_MIN_HOURS,
  IDLE_THRESHOLD_DEFAULT_MINUTES,
  IDLE_THRESHOLD_MAX_MINUTES,
  IDLE_THRESHOLD_MIN_MINUTES,
  MATRIX_KINDS,
  NOTIFICATION_PROFILES,
  isIdleCapHours,
  parseForcedEmailKinds,
} from '@tmanage/domain';
import { DISPLAY_LOCALES } from '../../common/database/schema.js';
import { DEFAULT_PRESETS, isFileTypePreset, presetsToCsv } from '../files/file-safety.js';
import {
  emptyWizardState,
  serializeWizardState,
  validateWizardStateValue,
} from '../onboarding/onboarding-wizard.state.js';

/** The fixed set of settings this slice ships. A key outside this set is never writable. */
export const ORG_SETTING_KEYS = [
  'default_timezone',
  'require_reauth_minutes',
  'client_visible_project_default',
  'working_week',
  'operating_template',
  // A11 — "What members can do" on the Organization settings card. Each one narrows; none widens.
  'members_can_create_projects',
  'members_can_invite_clients',
  'clients_can_upload_files',
  // Wave 9 S8 (F09/F12b): an owner-only key. Written only through the owner-only, audited
  // `PUT …/admin/security` (`enforce2fa`), never through the generic PUT.
  'require_two_step',
  // B3 — downloads before a virus scan. The company OWNER's choice alone (`OWNER_ONLY_SETTING_KEYS`):
  // written through `PATCH …/file-download-policy`, never through the generic PUT.
  'downloads_before_scan',
  // 55-18 (R18-d): the org notification profile a member with no saved settings starts from.
  'notification_profile',
  // 56-06 (R19-e): file safety. Written only through `PUT …/security/file-safety`
  // (`org.security.manage`, audited, scanner-checked), never through the generic PUT.
  'file_safety_presets',
  'require_scan_for_clients',
  // 55-04 (R20-c): Simple/Power mode. The org default a member with no own `uiMode` inherits, and
  // the internal roles that may not leave it. Both are `org.manage` keys on the generic PUT.
  'default_ui_mode',
  'ui_mode_locked_roles',
  // 53-15: the kinds whose e-mail a member cannot turn off (csv of notification kinds, '' = none).
  'notification_forced_email_kinds',
  // 55-01 (R48 L1): the onboarding wizard's progress for the company (`onboarding/` module). Its
  // own `org.manage` routes write it; the validator accepts only a canonical wizard state.
  'onboarding_wizard',
  // FIX-2026-11-10: automatic time tracking, off / optional / required. The company OWNER's choice
  // alone (`OWNER_ONLY_SETTING_KEYS`): written through `PATCH …/time/auto/policy`, audited.
  'auto_time_tracking',
  // FIX-2026-11-10 review L1: the largest idle threshold anyone in the company may choose
  // (minutes, 1 to 15, default 5). Owner only, through the same audited policy route.
  'auto_time_tracking_max_idle',
  // Time you can trust (2026-11-23), Admin > Time. The company OWNER's choice alone
  // (`OWNER_ONLY_SETTING_KEYS`): written through `PATCH …/time/trust-policy`, audited.
  'time_hand_entry',
  'time_hand_count',
  'time_idle_cap_hours',
] as const;

export type OrgSettingKey = (typeof ORG_SETTING_KEYS)[number];

/**
 * The working weeks ON-02 offers, first day to last day. A closed list rather than a free day mask:
 * every week the product schedules against has to be one the capacity and calendar code can read.
 */
export const WORKING_WEEKS = ['mon-fri', 'sun-thu', 'sat-wed', 'mon-sat'] as const;

/** The operating templates ON-03 offers. `empty` is "Start from empty": nothing enforced yet. */
export const OPERATING_TEMPLATES = [
  'delivery-client-review',
  'intake-commitment',
  'internal-delivery',
  'empty',
] as const;

/**
 * B3. What a download does while a file has no clean scan result: `allow_labeled` serves it with
 * `scanStatus: not_scanned` so the screen can label it; `block` refuses it with a 409.
 */
export const DOWNLOADS_BEFORE_SCAN_VALUES = ['allow_labeled', 'block'] as const;
export type DownloadsBeforeScan = (typeof DOWNLOADS_BEFORE_SCAN_VALUES)[number];

/**
 * B3. Keys only the company owner may change. The generic `PUT …/settings/:key` refuses them for
 * every caller; each has its own owner-only, audited route: `downloads_before_scan` through
 * `PATCH …/file-download-policy`, and (wave 9 S8, F09/F12b) `require_two_step` through
 * `PUT …/admin/security`. The owner decides workspace security policy.
 */
export const OWNER_ONLY_SETTING_KEYS: readonly OrgSettingKey[] = [
  'downloads_before_scan',
  'require_two_step',
  // 56-06 (R19-e): refused by the generic PUT for everyone, like the two above. Their own route is
  // `PUT …/security/file-safety` (`org.security.manage`), which refuses `require_scan_for_clients`
  // = 'true' when no scanner is configured — a check the generic PUT could not make.
  'file_safety_presets',
  'require_scan_for_clients',
  // FIX-2026-11-10: its own route is `PATCH …/time/auto/policy` (owner only, audited).
  'auto_time_tracking',
  'auto_time_tracking_max_idle',
  // 2026-11-23: its own route is `PATCH …/time/trust-policy` (owner only, audited).
  'time_hand_entry',
  'time_hand_count',
  'time_idle_cap_hours',
];

/** Whether `key` may only be changed by the owner, through its own route. */
export function isOwnerOnlySettingKey(key: OrgSettingKey): boolean {
  return OWNER_ONLY_SETTING_KEYS.includes(key);
}

/**
 * 55-04 (R20-c). The two shell modes. The mode changes **no** capability — it only decides how much
 * of the navigation the web shows — so it is a display setting, never an authorization input.
 */
export const UI_MODES = ['simple', 'power'] as const;
export type UiMode = (typeof UI_MODES)[number];

/**
 * 55-04. The roles `ui_mode_locked_roles` may name: the assignable internal roles, in catalogue
 * order. Client roles are absent on purpose — the portal is always simple by design, so locking one
 * is meaningless and refused with its own message. The hidden Support-session role is not offered.
 */
const LOCKABLE_ROLES: readonly string[] = ASSIGNABLE_INTERNAL_ROLES;
const CLIENT_ROLE_SET: readonly string[] = CLIENT_ROLES;

/** 55-04. Validate a csv of lockable roles: de-duplicated and stored in catalogue order; `''` = no lock. */
function lockedRolesValue(raw: string): OrgSettingValidation {
  const names = raw
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
  if (names.some((name) => CLIENT_ROLE_SET.includes(name))) {
    return { ok: false, message: 'Client roles are always simple.' };
  }
  if (!names.every((name) => LOCKABLE_ROLES.includes(name))) {
    return { ok: false, message: 'Choose from the offered roles.' };
  }
  return { ok: true, value: LOCKABLE_ROLES.filter((role) => names.includes(role)).join(',') };
}

/** 55-04. The roles a stored `ui_mode_locked_roles` value locks (`undefined`/`''` = none). */
export function parseLockedRoles(stored: string | undefined): readonly string[] {
  const names = (stored ?? '').split(',').map((name) => name.trim());
  return LOCKABLE_ROLES.filter((role) => names.includes(role));
}

/** 53-15. Validate a csv of notification kinds, stored de-duplicated in matrix order; `''` = none. */
function forcedEmailKindsValue(raw: string): OrgSettingValidation {
  const names = raw
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
  const kinds: readonly string[] = MATRIX_KINDS;
  if (!names.every((name) => kinds.includes(name))) {
    return { ok: false, message: 'Choose from the offered notification kinds.' };
  }
  return { ok: true, value: parseForcedEmailKinds(names.join(',')).join(',') };
}

/** A validator for a key whose value must be one of a closed list. */
function oneOf(values: readonly string[], message: string): OrgSettingSpec['validate'] {
  return (raw) => {
    const value = raw.trim().toLowerCase();
    return values.includes(value) ? { ok: true, value } : { ok: false, message };
  };
}

/** A validator for an on/off key, stored as `'true'`/`'false'`. */
function booleanValue(raw: string): OrgSettingValidation {
  const value = raw.trim().toLowerCase();
  if (value !== 'true' && value !== 'false') return { ok: false, message: 'Enter true or false.' };
  return { ok: true, value };
}

/** A validator's verdict: the canonical string to store, or a message naming what was wrong. */
export type OrgSettingValidation =
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string };

interface OrgSettingSpec {
  /** The value returned for this key when no row has been written yet. */
  readonly default: string;
  /** Accepts a candidate string, returning the canonical form to store or a rejection message. */
  readonly validate: (raw: string) => OrgSettingValidation;
}

/**
 * Whether the runtime recognises this timezone — asked of `Intl` rather than a bundled list, the
 * reason `organizations.controller.ts` gives: the value must be one *this* process can resolve, since
 * every deadline is rendered through it, and a bundled list goes stale.
 */
function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const SPECS: Readonly<Record<OrgSettingKey, OrgSettingSpec>> = Object.freeze({
  // The organization's default timezone — the fallback a new project or deadline is shown in. Must be
  // an IANA name Node can resolve (see above). Defaults to UTC, `organizations`' own default.
  default_timezone: {
    default: 'UTC',
    validate: (raw) => {
      const value = raw.trim();
      if (value.length === 0) return { ok: false, message: 'A timezone is required.' };
      if (value.length > 64) return { ok: false, message: 'That timezone name is too long.' };
      if (!isKnownTimezone(value))
        return { ok: false, message: 'That is not a timezone we recognise.' };
      return { ok: true, value };
    },
  },
  // How many minutes before a sensitive action requires re-authentication. 0 disables it. An integer
  // of minutes, clamped to a day so a typo cannot set an effectively-infinite window. Defaults to 0.
  require_reauth_minutes: {
    default: '0',
    validate: (raw) => {
      const value = raw.trim();
      if (!/^\d+$/.test(value)) {
        return { ok: false, message: 'Enter a whole number of minutes (0 disables it).' };
      }
      const minutes = Number(value);
      if (minutes > 1440)
        return { ok: false, message: 'Keep it to 1440 minutes (a day) or fewer.' };
      // Canonicalise: strip leading zeros so what is stored is what a reader parses.
      return { ok: true, value: String(minutes) };
    },
  },
  // Whether a new project is client-visible by default. A boolean, stored as `'true'`/`'false'`.
  // Defaults to `false` — the privacy-preserving default, matching §4's "never silently widen".
  client_visible_project_default: {
    default: 'false',
    validate: (raw) => {
      const value = raw.trim().toLowerCase();
      if (value !== 'true' && value !== 'false') {
        return { ok: false, message: 'Enter true or false.' };
      }
      return { ok: true, value };
    },
  },
  // The days the organization works (ON-02 "Working week"). Defaults to Monday–Friday.
  working_week: {
    default: 'mon-fri',
    validate: oneOf(WORKING_WEEKS, 'Choose one of the offered working weeks.'),
  },
  // The workflow template chosen in onboarding (ON-03). Defaults to delivery with client review,
  // the machine every project runs today.
  operating_template: {
    default: 'delivery-client-review',
    validate: oneOf(OPERATING_TEMPLATES, 'Choose one of the offered templates.'),
  },
  // A11. The three permission switches default to `true`: before they existed every role the
  // capability ceiling allowed could do each of these, and a new setting must not take anything
  // away until an admin turns it off. Two-step sign-in defaults to off for the same reason.
  members_can_create_projects: { default: 'true', validate: booleanValue },
  members_can_invite_clients: { default: 'true', validate: booleanValue },
  clients_can_upload_files: { default: 'true', validate: booleanValue },
  require_two_step: { default: 'false', validate: booleanValue },
  // B3. Defaults to `allow_labeled`: before the setting existed an unscanned file was simply
  // unreachable, and the owner decides whether that becomes "allowed, labelled" or stays blocked.
  // FIX-2026-11-10. `optional`: each person decides with "Track my time automatically".
  auto_time_tracking: {
    default: DEFAULT_AUTO_TRACKING_POLICY,
    validate: oneOf(AUTO_TRACKING_POLICIES, 'Choose off, optional or required.'),
  },
  auto_time_tracking_max_idle: {
    default: String(IDLE_THRESHOLD_DEFAULT_MINUTES),
    validate: (raw) => {
      const value = raw.trim();
      const minutes = /^\d{1,2}$/.test(value) ? Number(value) : Number.NaN;
      if (
        !Number.isInteger(minutes) ||
        minutes < IDLE_THRESHOLD_MIN_MINUTES ||
        minutes > IDLE_THRESHOLD_MAX_MINUTES
      ) {
        return {
          ok: false,
          message: `Choose ${IDLE_THRESHOLD_MIN_MINUTES} to ${IDLE_THRESHOLD_MAX_MINUTES} minutes.`,
        };
      }
      return { ok: true, value: String(minutes) };
    },
  },
  // 2026-11-23. Adding time by hand is OFF until the owner turns it on; typed time then counts
  // only after a manager approves it; a forgotten timer stops after 10 hours.
  time_hand_entry: { default: 'false', validate: booleanValue },
  time_hand_count: {
    default: DEFAULT_TIME_TRUST_POLICY.handTimeCountMode,
    validate: oneOf(HAND_TIME_COUNT_MODES, 'Choose after_approval or at_once_flagged.'),
  },
  time_idle_cap_hours: {
    default: String(IDLE_CAP_DEFAULT_HOURS),
    validate: (raw) => {
      const value = raw.trim();
      const hours = /^\d{1,2}$/.test(value) ? Number(value) : Number.NaN;
      if (!isIdleCapHours(hours)) {
        return {
          ok: false,
          message: `Choose ${IDLE_CAP_MIN_HOURS} to ${IDLE_CAP_MAX_HOURS} hours.`,
        };
      }
      return { ok: true, value: String(hours) };
    },
  },
  downloads_before_scan: {
    default: 'allow_labeled',
    validate: oneOf(DOWNLOADS_BEFORE_SCAN_VALUES, 'Choose allow_labeled or block.'),
  },
  // 55-18. `calm` (daily digest, quiet evenings, required-action kinds immediate) is the default
  // for every company; `standard` is the pre-55-18 everything-immediate behaviour. Read only when
  // a member has no saved notification settings — a saved row is never rewritten.
  notification_profile: {
    default: 'calm',
    validate: oneOf(NOTIFICATION_PROFILES, 'Choose calm or standard.'),
  },
  // 56-06. A csv of the enabled type presets (`files/file-safety.ts` FILE_TYPE_PRESETS), stored in
  // catalog order. Defaults to every preset but archives. At least one preset must stay on.
  file_safety_presets: {
    default: presetsToCsv(DEFAULT_PRESETS),
    validate: (raw) => {
      const names = raw
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name !== '');
      if (names.length === 0) return { ok: false, message: 'Keep at least one file type on.' };
      if (!names.every(isFileTypePreset)) {
        return { ok: false, message: 'Choose from the offered file types.' };
      }
      return { ok: true, value: presetsToCsv(names.filter(isFileTypePreset)) };
    },
  },
  // 56-06. Clients download only scanned-clean files. The default `true` takes effect only while a
  // scanner is configured (`file-safety-settings.ts` reads the effective value): without one no
  // verdict would ever arrive and every client file would be unreachable.
  require_scan_for_clients: { default: 'true', validate: booleanValue },
  // 55-04. Every org starts `simple` (the "<= 15 people" size rule is not built); an admin flips it.
  default_ui_mode: { default: 'simple', validate: oneOf(UI_MODES, 'Choose simple or power.') },
  // 55-04. No role is locked until an admin names one.
  ui_mode_locked_roles: { default: '', validate: lockedRolesValue },
  // 53-15. No kind is forced until an admin names one; the matrix then locks its e-mail on.
  notification_forced_email_kinds: { default: '', validate: forcedEmailKindsValue },
  // 55-01. A company starts with a fresh wizard; only a canonical wizard state is storable.
  onboarding_wizard: {
    default: serializeWizardState(emptyWizardState()),
    validate: validateWizardStateValue,
  },
});

/** The on/off keys the A11 routes read through {@link isSettingOn}. */
export type OrgBooleanSettingKey =
  | 'members_can_create_projects'
  | 'members_can_invite_clients'
  | 'clients_can_upload_files'
  | 'require_two_step';

/**
 * Whether an on/off setting is on, given the stored value (or `undefined` when no row was written).
 * Anything other than the canonical `'false'` falls back to the key's default, so a missing row
 * never changes behaviour.
 */
export function isSettingOn(key: OrgBooleanSettingKey, stored: string | undefined): boolean {
  const value = stored ?? SPECS[key].default;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return SPECS[key].default === 'true';
}

/** Whether `key` is an allowlisted setting. Narrows to {@link OrgSettingKey} for the callers. */
export function isOrgSettingKey(key: string): key is OrgSettingKey {
  return (ORG_SETTING_KEYS as readonly string[]).includes(key);
}

/** The default value for an allowlisted key — what a GET returns before any write. */
export function defaultFor(key: OrgSettingKey): string {
  return SPECS[key].default;
}

/** Validate a candidate value for an allowlisted key, returning the canonical form to store. */
export function validateValue(key: OrgSettingKey, raw: string): OrgSettingValidation {
  return SPECS[key].validate(raw);
}

/**
 * R12 R2 — the workspace's default language, for invitations and emails to people without a
 * language of their own. Not an `org_settings` row: it is the existing `organizations.default_locale`
 * column (no migration), read and written through the same routes so the settings card saves it
 * beside the others. Only the display allowlist is accepted (plus the legacy `en`/`ar` the column
 * was created with), so nothing else can reach an email's language.
 */
export const DEFAULT_LOCALE_SETTING_KEY = 'default_locale';

const ORGANIZATION_LOCALES: readonly string[] = [...DISPLAY_LOCALES, 'en', 'ar'];

export function validateDefaultLocale(raw: string): OrgSettingValidation {
  const value = raw.trim();
  return ORGANIZATION_LOCALES.includes(value)
    ? { ok: true, value }
    : { ok: false, message: 'Choose one of the offered languages.' };
}
