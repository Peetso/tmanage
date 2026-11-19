/**
 * Which work-item states the signal rules count (`23-ERD` §5 machine).
 *
 * - **Open** — not finished: everything but `done` and `archived`. A backlog item with a due date
 *   is still a deadline and still load.
 * - **Active** — open and picked up: a backlog item is parked by design, so it is never stale.
 */
const OPEN = new Set(['backlog', 'ready', 'in_progress', 'blocked', 'internal_review']);
const ACTIVE = new Set(['ready', 'in_progress', 'blocked', 'internal_review']);

export function isOpenWorkState(state: string): boolean {
  return OPEN.has(state);
}

export function isActiveWorkState(state: string): boolean {
  return ACTIVE.has(state);
}
