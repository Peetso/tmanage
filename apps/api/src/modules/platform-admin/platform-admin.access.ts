import { ApiError } from '../../common/http/errors.js';
import { requestOriginOf } from '../../common/http/request-origin.js';
import { requireRequestState } from '../../common/http/request-state.js';

/**
 * Platform admin — who may open `/platform`, and the rules every platform action shares.
 *
 * A platform admin is the operator of the whole TManage service, not a company admin: no
 * organization role reaches this surface (owner included). Platform admin v2 (SPEC P5): an
 * operator is either on the `PLATFORM_ADMIN_EMAILS` list — a comma list compared
 * case-insensitively against the signed-in person's **verified** email, always a super admin and
 * never editable from the screen (the bootstrap) — or has an active `platform_admins` row with a
 * preset or a custom permission list. With the list empty AND no active row, every route answers
 * the router's ordinary 404.
 *
 * The governing rule (SPEC P1, replacing `29-ENVIRONMENTS` §12): **the platform operator may read
 * and change any organization's data for support, safety and legal reasons. Every such access is
 * recorded with the operator's identity, the organization, the time, and the reason when given;
 * the organization's own audit log shows it; the operator acts through the same application rules
 * as a member, never through direct database access.** So a reason is optional on reads and edits
 * ({@link optionalReason}) and required on the destructive list ({@link requireReason}): suspend,
 * delete, transfer ownership, disable user, reset two-step, sign-out, moderation delete,
 * admin-team changes, billing mode, purge, end session.
 */

/**
 * How long a Platform admin step-up (password, plus the two-step code when one is set up) lasts,
 * in this session only — a new session or a sign-out ends it (PLATFORMFIX, the owner's decision
 * 2026-11-16: once a day instead of every 15 minutes). `PLATFORM_REAUTH_TTL_HOURS` overrides the
 * default of 24 with a whole number of hours from 1 to 24; anything else is the default. Only
 * this window: every other re-authentication (settings, two-step changes) keeps its own.
 */
export const PLATFORM_REAUTH_TTL_DEFAULT_HOURS = 24;
export const PLATFORM_REAUTH_TTL_MAX_HOURS = 24;

export function platformStepUpMinutes(env: Readonly<Record<string, string | undefined>>): number {
  const raw = (env['PLATFORM_REAUTH_TTL_HOURS'] ?? '').trim();
  const hours = /^\d{1,2}$/u.test(raw) ? Number(raw) : PLATFORM_REAUTH_TTL_DEFAULT_HOURS;
  const bounded =
    hours >= 1 && hours <= PLATFORM_REAUTH_TTL_MAX_HOURS
      ? hours
      : PLATFORM_REAUTH_TTL_DEFAULT_HOURS;
  return bounded * 60;
}

/** The step-up window of this process, read once at start (`PLATFORM_REAUTH_TTL_HOURS`). */
export const PLATFORM_STEP_UP_MINUTES = platformStepUpMinutes(process.env);

/** Reason bounds: long enough to say something, short enough to stay a reason. */
export const MIN_REASON_LENGTH = 5;
export const MAX_REASON_LENGTH = 500;

/**
 * Parse `PLATFORM_ADMIN_EMAILS` into a de-duplicated, lower-cased list. Junk entries drop out.
 * Forgiving of how a hosting panel is typed into (PLATFORMFIX): commas, semicolons, spaces or new
 * lines separate addresses, and quotes or angle brackets around the value or an address are
 * ignored — `"a@x.com, B@Y.com"` and `<a@x.com>;b@y.com` both name the same two people.
 */
export function parsePlatformAdminEmails(raw: string | null | undefined): readonly string[] {
  if (typeof raw !== 'string') return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,;]+/u)) {
    const email = part.replace(/^["'<]+|["'>]+$/gu, '').toLowerCase();
    if (email.length > 3 && email.length <= 254 && /^[^@\s]+@[^@\s]+$/u.test(email)) {
      seen.add(email);
    }
  }
  return [...seen];
}

/** What the server knows about one configured address at start (no address is ever logged). */
export interface PlatformBootstrapAccount {
  readonly emailVerified: boolean;
  readonly mfaEnabled: boolean;
}

/**
 * The one start-up line about the server list (PLATFORMFIX: an operator who set the variable and
 * restarted had no way to tell why /platform still answered 404). Counts only — never an address.
 * The list is read on every request, so nothing is granted or stored here: an address on the list
 * whose account is confirmed opens Platform admin as soon as it signs in.
 */
export function platformBootstrapLine(
  configured: number,
  accounts: readonly PlatformBootstrapAccount[],
  twoStepRequired: boolean,
): string {
  const prefix = `platform bootstrap: ${configured} address(es) configured`;
  if (configured === 0) return `${prefix}; Platform admin is off`;
  const verified = accounts.filter((account) => account.emailVerified);
  const ready = verified.filter((account) => !twoStepRequired || account.mfaEnabled);
  const parts = [
    `${accounts.length} with an account`,
    `${verified.length} confirmed`,
    `${ready.length} can open Platform admin`,
  ];
  let hint = '';
  if (accounts.length === 0) hint = ' — no account with that address yet (sign up first)';
  else if (verified.length === 0)
    hint = ' — e-mail not confirmed yet (click the confirmation link)';
  else if (ready.length === 0) hint = ' — turn on two-step sign-in first';
  return `${prefix}; ${parts.join(', ')}${hint}`;
}

/** Exact, case-insensitive membership. A prefix or a pattern would let `a@x.co` match `a@x.com`. */
export function isPlatformAdminEmail(
  allowlist: readonly string[],
  email: string | null | undefined,
): boolean {
  if (typeof email !== 'string' || email === '') return false;
  return allowlist.includes(email.trim().toLowerCase());
}

/** Every platform action needs a reason a person typed. 400 without one; nothing is done. */
export function requireReason(raw: unknown): string {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'Type the reason for this action.', [
      {
        field: 'reason',
        message: `required, ${MIN_REASON_LENGTH}–${MAX_REASON_LENGTH} characters`,
      },
    ]);
  }
  return reason;
}

/**
 * A reason the person may type. Trimmed; empty is `null`; longer than {@link MAX_REASON_LENGTH}
 * is a 400 (a reason that does not fit would be silently cut in the audit row otherwise).
 */
export function optionalReason(raw: unknown): string | null {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason === '') return null;
  if (reason.length > MAX_REASON_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'Keep the reason under 500 characters.', [
      { field: 'reason', message: `at most ${MAX_REASON_LENGTH} characters` },
    ]);
  }
  return reason;
}

/** The ids this surface accepts in a path. Anything else is a 404 before any read. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function requireId(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID_SHAPE.test(raw)) {
    throw new ApiError(404, 'not_found', 'The requested resource was not found');
  }
  return raw;
}

/** Escape a user-typed fragment for a `LIKE ? ESCAPE '\\'` pattern. */
export function likeContains(fragment: string): string {
  return `%${fragment.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
}

/** What every platform service needs from the HTTP request: correlation, IP and device. */
export interface PlatformRequestContext {
  readonly correlationId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** The request's correlation id, and its IP and device (trust-proxy aware, `request-origin.ts`). */
export function platformRequestContext(request: object): PlatformRequestContext {
  const state = requireRequestState(request);
  return { correlationId: state.correlationId, ...requestOriginOf(request) };
}
