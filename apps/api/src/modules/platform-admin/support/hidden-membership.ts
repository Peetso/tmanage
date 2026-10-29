import { PLATFORM_SUPPORT_ROLE } from '@tmanage/domain';
import { ApiError } from '../../../common/http/errors.js';
import type { PlatformStepUp } from '../platform-admin.repository.js';

/**
 * Support mode's pure rules (platform-admin v2 · PA-05, SPEC P3 and §3.2): how long a visit
 * lasts, what a live step-up means here, and how the admin's membership row is entered and left.
 *
 * ## One row per (organization, user)
 *
 * `uq_memberships_org_user` allows one `memberships` row per person per organization, so entering
 * an organization takes one of three paths, decided by {@link planEntry} from the row that is
 * already there (if any):
 *
 * - **none** — insert the hidden row (`role = 'platform_support'`, `status = 'active'`,
 *   org-wide scope, pointing at the session);
 * - **an old hidden row** from an earlier visit (role `platform_support`, offboarded) — reactivate
 *   it for the new session; exit offboards it again;
 * - **a real membership** (the admin is also a member there) — upgrade that row for the visit and
 *   keep what it was in the session row (`previous_role`, `previous_has_org_wide_scope`); exit puts
 *   it back exactly ({@link planExit}).
 *
 * `previous_role` is VARCHAR(64) and there is no `previous_status` column (0240), so a real row
 * that was not `active` (offboarded, suspended, invited) is kept as `status:role` — a role is a
 * built-in name or a custom-role UUID, so the encoded value always fits and always parses back.
 */

/** SPEC §3.2: a visit is 2 h unless the admin picks otherwise, never more than 8 h in total. */
export const SUPPORT_DEFAULT_MINUTES = 120;
export const SUPPORT_MAX_MINUTES = 480;
/** The shortest visit the dialog offers (30 min) and the API accepts anything from here. */
export const SUPPORT_MIN_MINUTES = 5;
/** The banner's "Extend 30 min". */
export const SUPPORT_EXTEND_MINUTES = 30;
/** SPEC §8: entering and extending need a step-up with at least this much life left. */
export const SUPPORT_STEP_UP_MIN_SECONDS = 60;

/** Why a session ended — `platform_support_sessions.ended_reason` (VARCHAR(32)). */
export type SupportEndReason = 'exited' | 'expired' | 'ended_by_admin' | 'signed_out';

export interface ExistingMembership {
  readonly id: string;
  readonly role: string;
  readonly status: string;
  readonly hasOrgWideScope: boolean;
}

export type EntryPlan =
  | { readonly kind: 'insert' }
  | { readonly kind: 'reactivate_hidden'; readonly membershipId: string }
  | {
      readonly kind: 'upgrade';
      readonly membershipId: string;
      readonly previousRole: string;
      readonly previousHasOrgWideScope: boolean;
    };

export function planEntry(existing: ExistingMembership | null): EntryPlan {
  if (existing === null) return { kind: 'insert' };
  if (existing.role === PLATFORM_SUPPORT_ROLE) {
    return { kind: 'reactivate_hidden', membershipId: existing.id };
  }
  return {
    kind: 'upgrade',
    membershipId: existing.id,
    previousRole: encodePreviousRole(existing.role, existing.status),
    previousHasOrgWideScope: existing.hasOrgWideScope,
  };
}

export type ExitPlan =
  | { readonly kind: 'offboard'; readonly membershipId: string }
  | {
      readonly kind: 'restore';
      readonly membershipId: string;
      readonly role: string;
      readonly status: string;
      readonly hasOrgWideScope: boolean;
    }
  | { readonly kind: 'none' };

export interface SessionMembershipState {
  readonly membershipId: string | null;
  readonly previousRole: string | null;
  readonly previousHasOrgWideScope: boolean | null;
}

export function planExit(session: SessionMembershipState): ExitPlan {
  if (session.membershipId === null) return { kind: 'none' };
  if (session.previousRole === null) {
    return { kind: 'offboard', membershipId: session.membershipId };
  }
  const { role, status } = decodePreviousRole(session.previousRole);
  return {
    kind: 'restore',
    membershipId: session.membershipId,
    role,
    status,
    hasOrgWideScope: session.previousHasOrgWideScope ?? false,
  };
}

const KEPT_STATUSES = new Set(['invited', 'suspended', 'offboarded']);

export function encodePreviousRole(role: string, status: string): string {
  return status === 'active' || !KEPT_STATUSES.has(status) ? role : `${status}:${role}`;
}

export function decodePreviousRole(encoded: string): { role: string; status: string } {
  const colon = encoded.indexOf(':');
  if (colon > 0) {
    const status = encoded.slice(0, colon);
    if (KEPT_STATUSES.has(status)) return { role: encoded.slice(colon + 1), status };
  }
  return { role: encoded, status: 'active' };
}

/** `minutes` from a request body: a whole number from 5 to 480, or the default when absent. */
export function parseSupportMinutes(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < SUPPORT_MIN_MINUTES ||
    value > SUPPORT_MAX_MINUTES
  ) {
    throw new ApiError(400, 'validation_failed', 'Choose a session length up to 8 hours.', [
      {
        field: 'minutes',
        message: `whole minutes, ${SUPPORT_MIN_MINUTES}–${SUPPORT_MAX_MINUTES}`,
      },
    ]);
  }
  return value;
}

/**
 * SPEC §8: the guard already proved a step-up within the last 15 minutes; entering or extending
 * also needs it to be alive for at least another minute, so the confirmation is fresh at the
 * moment the admin crosses into a customer's workspace.
 */
export function requireLiveStepUp(stepUp: PlatformStepUp | null, now: Date): void {
  const left = stepUp ? (stepUp.expiresAt.getTime() - now.getTime()) / 1000 : 0;
  if (left < SUPPORT_STEP_UP_MIN_SECONDS) {
    throw new ApiError(
      403,
      'reauthentication_required',
      'Confirm your password again to enter Support mode.',
      undefined,
      'support_session_step_up_stale',
    );
  }
}

/**
 * The new expiry of an extension: `minutes` past the current expiry (or past now, if that is
 * later), never past 8 h after the start — SPEC §3.2 caps the whole visit, not each piece.
 */
export function extendedExpiry(startedAt: Date, expiresAt: Date, now: Date, minutes: number): Date {
  const cap = startedAt.getTime() + SUPPORT_MAX_MINUTES * 60_000;
  const from = Math.max(expiresAt.getTime(), now.getTime());
  return new Date(Math.min(from + minutes * 60_000, cap));
}

export function supportSessionLive(
  session: { readonly endedAt: Date | null; readonly expiresAt: Date },
  now: Date,
): boolean {
  return session.endedAt === null && session.expiresAt.getTime() > now.getTime();
}
