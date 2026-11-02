import type { WorkingCalendar } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { roundHalf, spreadItemHours } from '../people/workload-hours.js';
import type { LoadItem, PersonLoad, PersonLoadWeek, WeekBucket } from '../people/workload-hours.js';

/**
 * 53-08 part 2a (R21-a) — the org-wide workload grid, the pure part: scope and cursor parsing, the
 * page cut, and the fold of per-person loads plus the owner-less row into the wire shape. No I/O.
 *
 * Leak rule: the only trace of work the reader may not read is each person's `otherProjectsHours`
 * (already rounded to 0.5 h by `buildPersonLoad`); the Unassigned row only ever receives readable
 * items, and no field anywhere carries a title. Hours only — no score, no ranking.
 */

/** People rows per page (53-08 DoS bound); the repository reads one more to prove `nextCursor`. */
export const PEOPLE_PAGE_SIZE = 50;

export type WorkloadScope =
  { readonly kind: 'org' } | { readonly kind: 'project'; readonly projectId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[0-9A-Za-z-]{1,64}$/;

function badRequest(field: string, message: string, auditCode: string): ApiError {
  return new ApiError(
    400,
    'validation_failed',
    `${field} is invalid`,
    [{ field, message }],
    auditCode,
  );
}

/** `org` (the default when absent) or `project:<uuid>`; anything else is `'invalid'`. */
export function parseScope(raw: unknown): WorkloadScope | 'invalid' {
  if (raw === undefined || raw === null || raw === '' || raw === 'org') return { kind: 'org' };
  if (typeof raw !== 'string' || !raw.startsWith('project:')) return 'invalid';
  const projectId = raw.slice('project:'.length);
  return UUID.test(projectId) ? { kind: 'project', projectId: projectId.toLowerCase() } : 'invalid';
}

/** {@link parseScope}, throwing the 400 (`invalid_scope`) the route answers. */
export function requireScope(raw: unknown): WorkloadScope {
  const scope = parseScope(raw);
  if (scope === 'invalid') {
    throw badRequest('scope', 'must be "org" or "project:<uuid>"', 'invalid_scope');
  }
  return scope;
}

/** The keyset cursor: the last membership id of the previous page, or null for the first page. */
export function parsePage(cursor: unknown): { readonly afterMembershipId: string | null } {
  if (cursor === undefined || cursor === null || cursor === '') return { afterMembershipId: null };
  if (typeof cursor !== 'string' || !CURSOR.test(cursor)) {
    throw badRequest('cursor', 'is not a cursor this route issued', 'invalid_cursor');
  }
  return { afterMembershipId: cursor };
}

/** Cut a `limit + 1` read to one page; the extra row only proves there is a next page. */
export function cutPage<T extends { readonly membershipId: string }>(
  rows: readonly T[],
): { readonly page: readonly T[]; readonly nextCursor: string | null } {
  if (rows.length <= PEOPLE_PAGE_SIZE) return { page: rows, nextCursor: null };
  const page = rows.slice(0, PEOPLE_PAGE_SIZE);
  return { page, nextCursor: page[page.length - 1]?.membershipId ?? null };
}

export interface OrgWorkloadPersonInput {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly load: PersonLoad;
}

export interface BuildOrgWorkloadInput {
  readonly weeks: readonly WeekBucket[];
  readonly people: readonly OrgWorkloadPersonInput[];
  /** Owner-less open items; unreadable ones are dropped here as a second line of defence. */
  readonly unassigned: readonly LoadItem[];
  readonly calendar: WorkingCalendar;
  readonly nextCursor: string | null;
}

export interface OrgWorkloadView {
  readonly weeks: readonly { readonly weekStart: string }[];
  readonly people: readonly {
    readonly membershipId: string;
    readonly displayName: string;
    readonly weeks: readonly PersonLoadWeek[];
  }[];
  readonly unassigned: {
    readonly weeks: readonly { readonly weekStart: string; readonly hours: number }[];
  };
  readonly nextCursor: string | null;
}

/** Fold the page's person loads and the owner-less items into the grid. */
export function buildOrgWorkload(input: BuildOrgWorkloadInput): OrgWorkloadView {
  const readable = input.unassigned.filter((item) => item.readable);
  return {
    weeks: input.weeks.map((week) => ({ weekStart: week.weekStart })),
    people: input.people.map((person) => ({
      membershipId: person.membershipId,
      displayName: person.displayName,
      weeks: person.load.weeks,
    })),
    unassigned: {
      weeks: input.weeks.map((week) => ({
        weekStart: week.weekStart,
        hours: roundHalf(
          readable.reduce((sum, item) => sum + spreadItemHours(item, week, input.calendar), 0),
        ),
      })),
    },
    nextCursor: input.nextCursor,
  };
}
