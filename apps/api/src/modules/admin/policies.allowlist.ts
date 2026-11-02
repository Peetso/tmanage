/**
 * The organization access-policy allowlist (Administration module 18, x174) — the substance of the slice.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION` §4 fixes that organization policy "may narrow, never
 * silently widen". The control that makes that safe here is that **there is no arbitrary key**: this
 * module is the single source of which access policies exist, what they default to, and what a valid
 * value for each looks like. A PUT names one or more keys; a key not in {@link ORG_POLICY_KEYS} is a
 * 400 with no write, and a value the key's validator rejects (wrong type, or out of range) is a 400
 * with no write. Nothing outside this list can ever reach the table.
 *
 * This is deliberately distinct from x153 `org_settings` (general preferences — timezone, re-auth
 * window, default project visibility): those are a flat string key/value surface. This is the
 * **access-policy** surface — session lifetime, invite-domain allowlist, guest access — whose values
 * are *typed and bounded* (a number of hours, a list of domains, a boolean), stored as one JSON
 * document per organization rather than one row per key.
 *
 * The role/capability editor (ADM-03) is deliberately not here — it is blocked pending the
 * permission-matrix work — and neither are broader security-policy escalations (NEXT-SCOPES-13). This
 * is the fixed, validated access-policy document only.
 */
import type { OrgPolicyValue } from '../../common/database/schema.js';
import { KNOWN_SCOPES } from '../oauth/scopes.js';

// Re-export the stored document type (defined beside its column in schema.ts, the convention every
// JSON column follows) so the controller, repository and web pair import it from one place.
export type { OrgPolicyValue };

/** The fixed set of access policies this slice ships. A key outside this set is never writable. */
export const ORG_POLICY_KEYS = [
  'session_max_hours',
  'invite_domain_allowlist',
  'guest_access_enabled',
  'idle_signout_minutes',
  // R13 s3 (56-09): personal access token policy.
  'pat.max_expiry_days',
  'pat.allow_no_expiry',
  'pat.allowed_scopes',
] as const;

export type OrgPolicyKey = (typeof ORG_POLICY_KEYS)[number];

/** The privacy-preserving defaults — what a GET returns before any policy has been written. */
export const DEFAULT_POLICY: OrgPolicyValue = Object.freeze({
  session_max_hours: 24,
  invite_domain_allowlist: Object.freeze([]) as readonly string[],
  guest_access_enabled: false,
  idle_signout_minutes: 480,
});

/**
 * R3. "Sign out after inactivity": the choices the owner picks from, in minutes. `0` is Off. Enforced
 * from the session's last refresh (`tenant-context.guard.ts`, `SessionService.refresh`).
 */
export const IDLE_SIGNOUT_CHOICES: readonly number[] = Object.freeze([0, 30, 60, 240, 480]);

/** R13 s3. The longest expiry a token may be given, by default (days). */
export const DEFAULT_PAT_MAX_EXPIRY_DAYS = 365;
/** R13 s3. The hard ceiling an owner may raise `pat.max_expiry_days` to: two years. */
export const PAT_MAX_EXPIRY_CEILING_DAYS = 730;

/** R13 s3. The token policy in force, with every absent key resolved to its default. */
export interface PatPolicy {
  readonly maxExpiryDays: number;
  readonly allowNoExpiry: boolean;
  readonly allowedScopes: readonly string[];
}

/**
 * R13 s3. The personal access token policy for an organization's (normalised) document. Absent keys
 * take the defaults: 365 days, no never-expiring tokens, all four scopes allowed.
 */
export function resolvePatPolicy(policy: OrgPolicyValue): PatPolicy {
  return {
    maxExpiryDays: policy['pat.max_expiry_days'] ?? DEFAULT_PAT_MAX_EXPIRY_DAYS,
    allowNoExpiry: policy['pat.allow_no_expiry'] ?? false,
    allowedScopes: policy['pat.allowed_scopes'] ?? KNOWN_SCOPES,
  };
}

/** R13 s3. A scope list: known scopes only, de-duplicated, in canonical order; null if invalid. */
function canonicalScopes(raw: unknown): readonly string[] | null {
  const list =
    typeof raw === 'string'
      ? raw.split(/\s+/).filter((s) => s !== '')
      : Array.isArray(raw)
        ? raw
        : null;
  if (list === null || list.some((s) => typeof s !== 'string' || !KNOWN_SCOPES.includes(s))) {
    return null;
  }
  return Object.freeze(KNOWN_SCOPES.filter((scope) => (list as string[]).includes(scope)));
}

/** A validator's verdict: the canonical typed value to store, or a message naming what was wrong. */
export type OrgPolicyFieldValidation =
  | { readonly ok: true; readonly value: OrgPolicyValue[OrgPolicyKey] }
  | { readonly ok: false; readonly message: string };

/** The most a session may live before re-auth: a month, so a typo cannot set an effectively-infinite window. */
const MAX_SESSION_HOURS = 720;
/** A conservative ceiling on the domain allowlist, so the JSON document cannot grow unbounded. */
const MAX_DOMAINS = 50;
/** A pragmatic domain shape: labels of letters/digits/hyphens separated by dots, with a TLD. */
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

interface OrgPolicySpec {
  /** Accepts a candidate value, returning the canonical typed form to store or a rejection message. */
  readonly validate: (raw: unknown) => OrgPolicyFieldValidation;
}

const SPECS: Readonly<Record<OrgPolicyKey, OrgPolicySpec>> = Object.freeze({
  // A whole number of hours in 1..720. Accepts a JSON number or a numeric string; canonicalises to a
  // number so what is read back is exactly what a later reader parses.
  session_max_hours: {
    validate: (raw) => {
      const value =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && /^\d+$/.test(raw.trim())
            ? Number(raw.trim())
            : NaN;
      if (!Number.isInteger(value)) {
        return { ok: false, message: 'Enter a whole number of hours.' };
      }
      if (value < 1 || value > MAX_SESSION_HOURS) {
        return {
          ok: false,
          message: `Keep session lifetime between 1 and ${MAX_SESSION_HOURS} hours.`,
        };
      }
      return { ok: true, value };
    },
  },
  // A list of email domains. Each must be a plausible domain; the list is lower-cased, de-duplicated
  // and bounded. An empty list is valid and means "no domain restriction".
  invite_domain_allowlist: {
    validate: (raw) => {
      if (!Array.isArray(raw)) {
        return { ok: false, message: 'Provide a list of domains.' };
      }
      if (raw.length > MAX_DOMAINS) {
        return { ok: false, message: `Keep the allowlist to ${MAX_DOMAINS} domains or fewer.` };
      }
      const seen = new Set<string>();
      for (const entry of raw) {
        if (typeof entry !== 'string') {
          return { ok: false, message: 'Every domain must be text.' };
        }
        const domain = entry.trim().toLowerCase();
        if (!DOMAIN_RE.test(domain)) {
          return { ok: false, message: `"${entry}" is not a valid domain.` };
        }
        seen.add(domain);
      }
      return { ok: true, value: Object.freeze([...seen]) as readonly string[] };
    },
  },
  // R3. One of the fixed choices (minutes, 0 = Off); a number or a numeric string.
  idle_signout_minutes: {
    validate: (raw) => {
      const value =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && raw.trim() !== ''
            ? Number(raw)
            : NaN;
      if (!IDLE_SIGNOUT_CHOICES.includes(value)) {
        return { ok: false, message: 'Choose Off, 30 minutes, 1 hour, 4 hours or 8 hours.' };
      }
      return { ok: true, value };
    },
  },
  // A boolean. Accepts a JSON boolean or the strings 'true'/'false'; canonicalises to a boolean.
  guest_access_enabled: {
    validate: (raw) => {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false, message: 'Enter true or false.' };
    },
  },
  // R13 s3. Whole days in 1..730; a number or a numeric string.
  'pat.max_expiry_days': {
    validate: (raw) => {
      const value =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && /^\d+$/.test(raw.trim())
            ? Number(raw.trim())
            : NaN;
      if (!Number.isInteger(value) || value < 1 || value > PAT_MAX_EXPIRY_CEILING_DAYS) {
        return {
          ok: false,
          message: `Choose a number of days from 1 to ${PAT_MAX_EXPIRY_CEILING_DAYS}.`,
        };
      }
      return { ok: true, value };
    },
  },
  // R13 s3. A boolean, as guest_access_enabled.
  'pat.allow_no_expiry': {
    validate: (raw) => {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false, message: 'Enter true or false.' };
    },
  },
  // R13 s3. A non-empty list of known scopes (or a space-separated string of them).
  'pat.allowed_scopes': {
    validate: (raw) => {
      const scopes = canonicalScopes(raw);
      if (scopes === null || scopes.length === 0) {
        return { ok: false, message: `Choose one or more of: ${KNOWN_SCOPES.join(', ')}.` };
      }
      return { ok: true, value: scopes };
    },
  },
});

/** Whether `key` is an allowlisted access policy. Narrows to {@link OrgPolicyKey} for the callers. */
export function isOrgPolicyKey(key: string): key is OrgPolicyKey {
  return (ORG_POLICY_KEYS as readonly string[]).includes(key);
}

/** Validate one candidate value for an allowlisted key, returning the canonical typed form to store. */
export function validatePolicyField(key: OrgPolicyKey, raw: unknown): OrgPolicyFieldValidation {
  return SPECS[key].validate(raw);
}

/**
 * The result of validating a whole PUT body against the allowlist: either the fields to merge (each
 * canonicalised), or the first problem found (off-list key, or a rejected value), so a bad request is
 * a 400 with no write.
 */
export type OrgPolicyPatchResult =
  | { readonly ok: true; readonly patch: Partial<OrgPolicyValue> }
  | { readonly ok: false; readonly field: string; readonly message: string };

/**
 * Validate a PUT body — a partial map of access-policy keys to values. Every key present must be
 * allowlisted (off-list → refusal) and every value must pass its key's validator (bad value →
 * refusal); the returned patch carries only allowlisted, canonicalised fields. The body must be a
 * plain object; anything else (null, an array, a scalar) is a refusal with no write.
 */
export function validatePolicyPatch(body: unknown): OrgPolicyPatchResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, field: 'body', message: 'The request body must be a policy object.' };
  }
  const patch: Record<string, OrgPolicyValue[OrgPolicyKey]> = {};
  for (const [key, raw] of Object.entries(body as Record<string, unknown>)) {
    if (!isOrgPolicyKey(key)) {
      return { ok: false, field: key, message: 'That is not an access policy we recognise.' };
    }
    const verdict = validatePolicyField(key, raw);
    if (!verdict.ok) {
      return { ok: false, field: key, message: verdict.message };
    }
    patch[key] = verdict.value;
  }
  return { ok: true, patch: patch as Partial<OrgPolicyValue> };
}

/**
 * Merge a validated patch onto a base policy (the stored document, or {@link DEFAULT_POLICY} when none
 * has been written). The result is a full, well-typed {@link OrgPolicyValue} — the document to store
 * and to return.
 */
export function mergePolicy(base: OrgPolicyValue, patch: Partial<OrgPolicyValue>): OrgPolicyValue {
  const maxExpiry = patch['pat.max_expiry_days'] ?? base['pat.max_expiry_days'];
  const allowNoExpiry = patch['pat.allow_no_expiry'] ?? base['pat.allow_no_expiry'];
  const allowedScopes = patch['pat.allowed_scopes'] ?? base['pat.allowed_scopes'];
  return {
    session_max_hours: patch.session_max_hours ?? base.session_max_hours,
    invite_domain_allowlist: patch.invite_domain_allowlist ?? base.invite_domain_allowlist,
    guest_access_enabled: patch.guest_access_enabled ?? base.guest_access_enabled,
    idle_signout_minutes: patch.idle_signout_minutes ?? base.idle_signout_minutes,
    // R13 s3: the token keys are written only once set, so an older document reads unchanged.
    ...(maxExpiry === undefined ? {} : { 'pat.max_expiry_days': maxExpiry }),
    ...(allowNoExpiry === undefined ? {} : { 'pat.allow_no_expiry': allowNoExpiry }),
    ...(allowedScopes === undefined ? {} : { 'pat.allowed_scopes': allowedScopes }),
    // R18-e (56-25): the sign-in keys are written by their own route; carried, never dropped here.
    ...signInKeysOf(base as unknown as Readonly<Record<string, unknown>>),
  };
}

/** R18-e (56-25). The sign-in policy keys of a document, carried through untouched. */
function signInKeysOf(doc: Readonly<Record<string, unknown>>): Partial<OrgPolicyValue> {
  const methods = doc['signin.allowed_methods'];
  const scope = doc['security.require_two_step_roles'];
  const grace = doc['security.two_step_grace_until'];
  return {
    ...(Array.isArray(methods) && methods.every((m) => typeof m === 'string')
      ? { 'signin.allowed_methods': methods as string[] }
      : {}),
    ...(typeof scope === 'string' ? { 'security.require_two_step_roles': scope } : {}),
    ...(typeof grace === 'string' ? { 'security.two_step_grace_until': grace } : {}),
  };
}

/**
 * Coerce a value read back from the JSON column to a well-typed {@link OrgPolicyValue}, filling any
 * missing or malformed field from {@link DEFAULT_POLICY}. A stored document is written only through
 * {@link mergePolicy} on validated input, but reading defensively means a future added key (absent
 * from an older row) resolves to its default rather than `undefined`.
 */
export function normalizePolicy(stored: unknown): OrgPolicyValue {
  const base =
    typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
  const hours = base['session_max_hours'];
  const domains = base['invite_domain_allowlist'];
  const guest = base['guest_access_enabled'];
  const idle = base['idle_signout_minutes'];
  // R13 s3: a token key is carried only when stored and valid; absent, `resolvePatPolicy` defaults it.
  const maxExpiry = SPECS['pat.max_expiry_days'].validate(base['pat.max_expiry_days']);
  const allowNoExpiry = base['pat.allow_no_expiry'];
  const allowedScopes = canonicalScopes(base['pat.allowed_scopes']);
  return {
    session_max_hours:
      typeof hours === 'number' && Number.isInteger(hours)
        ? hours
        : DEFAULT_POLICY.session_max_hours,
    invite_domain_allowlist:
      Array.isArray(domains) && domains.every((d) => typeof d === 'string')
        ? (domains as string[])
        : DEFAULT_POLICY.invite_domain_allowlist,
    guest_access_enabled: typeof guest === 'boolean' ? guest : DEFAULT_POLICY.guest_access_enabled,
    idle_signout_minutes:
      typeof idle === 'number' && IDLE_SIGNOUT_CHOICES.includes(idle)
        ? idle
        : DEFAULT_POLICY.idle_signout_minutes,
    ...(maxExpiry.ok && typeof base['pat.max_expiry_days'] === 'number'
      ? { 'pat.max_expiry_days': maxExpiry.value as number }
      : {}),
    ...(typeof allowNoExpiry === 'boolean' ? { 'pat.allow_no_expiry': allowNoExpiry } : {}),
    ...(allowedScopes !== null && allowedScopes.length > 0
      ? { 'pat.allowed_scopes': allowedScopes }
      : {}),
    ...signInKeysOf(base),
  };
}
