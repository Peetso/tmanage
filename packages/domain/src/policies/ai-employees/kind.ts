/**
 * 60-01 (plan 60 v2 §4.1). The kind of a membership: a person, or an AI employee.
 *
 * An AI employee is a `memberships` row with `kind = 'ai'`, a credential-less `users` row and an
 * `ai_employees` companion row. `memberships.kind` is a `VARCHAR(8)` (migration 0398), so the
 * stored value is an arbitrary string until {@link parseMembershipKind} has read it (IP-2).
 *
 * Pure: no I/O, no clock.
 */

export const MEMBERSHIP_KINDS = ['human', 'ai'] as const;

export type MembershipKind = (typeof MEMBERSHIP_KINDS)[number];

/**
 * Read a stored `memberships.kind`. Anything that is not exactly `human` or `ai` is `null`, and
 * the caller treats `null` as a refusal (deny by default): a corrupted row must never pass for a
 * person at a sign-in door, nor for an AI employee at the agent door.
 */
export function parseMembershipKind(value: unknown): MembershipKind | null {
  return value === 'human' || value === 'ai' ? value : null;
}

/** Is this membership an AI employee? Only an exact `ai` answers yes. */
export function isAiMembershipKind(value: unknown): boolean {
  return parseMembershipKind(value) === 'ai';
}

/**
 * The reserved e-mail domain of an AI employee's `users` row (`ai-<uuid>@ai-employee.invalid`).
 * `.invalid` is reserved by RFC 2606 §2 and RFC 6761 §6.4: it never resolves, so no message can be
 * delivered there, and the mail drainer drops it before any transport is asked.
 */
export const AI_EMPLOYEE_EMAIL_DOMAIN = 'ai-employee.invalid';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The placeholder address of an AI employee's user row. `userId` must be a lowercase UUID. */
export function aiEmployeeEmail(userId: string): string {
  if (!UUID.test(userId)) throw new Error('AI employee user id is not a lowercase UUID');
  return `ai-${userId}@${AI_EMPLOYEE_EMAIL_DOMAIN}`;
}

/**
 * Does this address belong to an AI employee (the reserved domain, any case)? The mail drainer and
 * every sign-in door ask this as a second guard beside `memberships.kind`.
 */
export function isAiEmployeeEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  return (
    email
      .slice(at + 1)
      .trim()
      .toLowerCase() === AI_EMPLOYEE_EMAIL_DOMAIN
  );
}
