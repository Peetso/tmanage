import { ApiError } from '../../common/http/errors.js';

/**
 * Platform admin — who may open `/platform`, and the rules every platform action shares.
 *
 * A platform admin is the operator of the whole TManage service, not a company admin: no
 * organization role reaches this surface (owner included). The list of operators is the
 * `PLATFORM_ADMIN_EMAILS` environment variable — a comma list compared case-insensitively
 * against the signed-in person's **verified** email. An unset or empty list turns the whole
 * feature off: every route answers the router's ordinary 404.
 *
 * `29-ENVIRONMENTS-DEPLOYMENT-AND-RUNBOOKS` §12 ("Support access") is the governing rule: no
 * routine direct database access, safe diagnostics only, no impersonation. So this surface
 * reads metadata (names, counts, dates, roles) and never customer content, and every action
 * carries a typed reason into the platform audit log.
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
