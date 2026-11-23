import type { AiActionOp } from './registry/index.js';
import { isPlatformOp, sensitivityOf } from './registry/index.js';

/**
 * Fix 6 of the live AI test (2026-11-23): how long an AI approval waits for the member.
 *
 * Before, every pending AI action and every in-app card lived ten minutes (plan §4.3). An owner who
 * was not at the screen came back to expired links. The rule now:
 *
 * - **30 minutes** ({@link APPROVAL_TTL_SHORT_MS}) for anything that changes company settings or
 *   rights (`manage`), billing, money, people's HR records, or removes something (`DELETE`,
 *   `destructive`), every platform op, and every op that needs a fresh re-authentication. A stale
 *   approval of those is the risk that matters, so it stays short.
 * - **24 hours** ({@link APPROVAL_TTL_LONG_MS}) for an ordinary write (a task, a comment, a file on
 *   a work item, a rename).
 *
 * Only the lifetime moves. An approval is still single-use (one guarded `UPDATE … WHERE status =
 * 'pending' AND expires_at > now`), bound to the member, the workspace and the frozen arguments'
 * hash, and re-checked against the member's live rights when it runs (`pending-actions.service.ts`).
 *
 * The answer to the AI says the expiry in words ({@link expiryInWords}), so the model can tell the
 * person how long the link works instead of guessing.
 */
/** The facts of an op the lifetime rule reads. */
export type LifetimeOp = Pick<
  AiActionOp,
  'id' | 'method' | 'risk' | 'scope' | 'freshReauth' | 'platformPermission'
>;

export const APPROVAL_TTL_SHORT_MS = 30 * 60 * 1000;
export const APPROVAL_TTL_LONG_MS = 24 * 60 * 60 * 1000;

/** True when an approval of this op must stay short-lived (see the module note). */
export function needsShortApproval(op: LifetimeOp): boolean {
  if (op.scope === 'manage' || op.scope === 'billing') return true;
  if (op.method === 'DELETE' || op.freshReauth === true || isPlatformOp(op)) return true;
  const sensitivity = sensitivityOf(op);
  return sensitivity === 'money' || sensitivity === 'hr' || sensitivity === 'destructive';
}

/** How long an approval of this op stays open. */
export function approvalLifetimeMs(op: LifetimeOp): number {
  return needsShortApproval(op) ? APPROVAL_TTL_SHORT_MS : APPROVAL_TTL_LONG_MS;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return days === 1 ? '24 hours' : `${String(days)} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour' : `${String(hours)} hours`;
  }
  return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
}

/**
 * "This approval link works for 24 hours, until 24 November 2026 at 14:05 UTC." — the expiry in
 * plain words, in UTC (the server does not know the reader's zone; the ISO `expires_at` beside it
 * lets a client show local time).
 */
export function expiryInWords(expiresAt: Date, now: Date): string {
  const hh = String(expiresAt.getUTCHours()).padStart(2, '0');
  const mm = String(expiresAt.getUTCMinutes()).padStart(2, '0');
  const day = `${String(expiresAt.getUTCDate())} ${MONTHS[expiresAt.getUTCMonth()] ?? ''} ${String(expiresAt.getUTCFullYear())}`;
  const left = expiresAt.getTime() - now.getTime();
  return `This approval link works for ${span(left)}, until ${day} at ${hh}:${mm} UTC.`;
}
