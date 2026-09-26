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

/** The fixed set of settings this slice ships. A key outside this set is never writable. */
export const ORG_SETTING_KEYS = [
  'default_timezone',
  'require_reauth_minutes',
  'client_visible_project_default',
] as const;

export type OrgSettingKey = (typeof ORG_SETTING_KEYS)[number];

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
});

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
