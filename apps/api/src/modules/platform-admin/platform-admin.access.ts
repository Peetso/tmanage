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

/** A fresh password (and MFA code, when one is set up) confirmation lasts this long. */
export const PLATFORM_STEP_UP_MINUTES = 15;

/** Reason bounds: long enough to say something, short enough to stay a reason. */
export const MIN_REASON_LENGTH = 5;
export const MAX_REASON_LENGTH = 500;

/** Parse `PLATFORM_ADMIN_EMAILS` into a de-duplicated, lower-cased list. Junk entries drop out. */
export function parsePlatformAdminEmails(raw: string | null | undefined): readonly string[] {
  if (typeof raw !== 'string') return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const email = part.trim().toLowerCase();
    if (email.length > 3 && email.length <= 254 && email.includes('@')) seen.add(email);
  }
  return [...seen];
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
