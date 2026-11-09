'use client';

import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from './api/client';
import { readOrganizationMe } from './api/permission-matrix';

/**
 * FIX3 item C — "make the tasks draggable": the pieces every work view shares.
 *
 * - **Who may drag.** Only an internal person whose role holds the capability the drop needs
 *   (`work.update` to reorder, re-date or reassign; `work.transition` to change status). A client,
 *   a viewer, or anyone while `…/me` is still loading sees no drag handle. The API decides in the
 *   end: a refusal rolls the drop back with a message.
 * - **The hand-made order.** `rank` (0340) is a sort key on the millisecond scale of `createdAt`,
 *   so an item that was never dragged sorts by when it was made, and a dropped item gets the
 *   midpoint of its new neighbours' keys: one drag writes one row.
 * - **Moving dates.** A drag to another day moves the start and the due date by the same number
 *   of days, so the item keeps its length and its time of day.
 */

export interface WorkDragPermissions {
  /** Reorder, re-date and reassign (`work.update`). */
  readonly canUpdate: boolean;
  /** Change status from the Board (`work.transition`). */
  readonly canTransition: boolean;
}

const NONE: WorkDragPermissions = { canUpdate: false, canTransition: false };

export function workDragPermissions(
  me: { readonly kind: string; readonly capabilities: readonly string[] } | undefined,
): WorkDragPermissions {
  if (!me || me.kind !== 'internal') return NONE;
  return {
    canUpdate: me.capabilities.includes('work.update'),
    canTransition: me.capabilities.includes('work.transition'),
  };
}

/** The caller's drag rights; none until `…/me` answers, and none when it fails. */
export function useWorkDragPermissions(
  api: ApiClient | undefined,
  organizationSlug: string,
): WorkDragPermissions {
  const me = useQuery({
    queryKey: ['organization-me', organizationSlug],
    queryFn: () => readOrganizationMe(api as ApiClient, organizationSlug),
    enabled: api !== undefined,
    retry: false,
    staleTime: 5 * 60_000,
  });
  return workDragPermissions(me.data);
}

export interface RankedItem {
  readonly id: string;
  readonly createdAt: string;
  readonly rank?: number | null;
}

/** The key an item sorts by: its rank, else its creation time. */
export function sortKeyOf(item: RankedItem): number {
  if (typeof item.rank === 'number' && Number.isFinite(item.rank)) return item.rank;
  const created = Date.parse(item.createdAt);
  return Number.isNaN(created) ? 0 : created;
}

/** Items in their hand-made order (stable for equal keys). */
export function byRank<T extends RankedItem>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => sortKeyOf(left.item) - sortKeyOf(right.item) || left.index - right.index)
    .map(({ item }) => item);
}

/** One minute on the key scale: the gap left before the first or after the last item. */
const EDGE_GAP = 60_000;

/**
 * The rank that puts `movingId` just before `beforeId` in `ordered` (or at the end when
 * `beforeId` is `null`), or `null` when the drop would not change the order.
 */
export function rankForDrop<T extends RankedItem>(
  ordered: readonly T[],
  movingId: string,
  beforeId: string | null,
): number | null {
  const rest = ordered.filter((item) => item.id !== movingId);
  const from = ordered.findIndex((item) => item.id === movingId);
  const at = beforeId === null ? rest.length : rest.findIndex((item) => item.id === beforeId);
  if (at === -1) return null;
  if (from !== -1 && at === from) return null;
  const previous = at > 0 ? rest[at - 1] : undefined;
  const next = at < rest.length ? rest[at] : undefined;
  if (previous && next) {
    const low = sortKeyOf(previous);
    const high = sortKeyOf(next);
    return high > low ? low + (high - low) / 2 : low;
  }
  if (next) return sortKeyOf(next) - EDGE_GAP;
  if (previous) return sortKeyOf(previous) + EDGE_GAP;
  return Date.now();
}

/** `ordered` with `movingId` placed before `beforeId` (or last): the optimistic order. */
export function moveBefore<T extends { readonly id: string }>(
  ordered: readonly T[],
  movingId: string,
  beforeId: string | null,
): T[] {
  const moving = ordered.find((item) => item.id === movingId);
  if (!moving) return [...ordered];
  const rest = ordered.filter((item) => item.id !== movingId);
  const at = beforeId === null ? rest.length : rest.findIndex((item) => item.id === beforeId);
  rest.splice(at === -1 ? rest.length : at, 0, moving);
  return rest;
}

const DAY_MS = 86_400_000;

/** Whole days from one `YYYY-MM-DD` to another (negative when earlier). */
export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round(
    (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS,
  );
}

/** An instant moved by whole days; `null` stays `null`. */
export function shiftInstant(instant: string | null, days: number): string | null {
  if (instant === null) return null;
  const parsed = Date.parse(instant);
  if (Number.isNaN(parsed)) return instant;
  return new Date(parsed + days * DAY_MS).toISOString();
}

/**
 * The dates after dropping an item that sat on `fromDay` onto `toDay`: start and due move
 * together. An item with no dates at all gets a due date at 17:00 UTC on the target day.
 */
export function datesForDayDrop(
  item: { readonly startAt: string | null; readonly dueAt: string | null },
  fromDay: string,
  toDay: string,
): { startAt: string | null; dueAt: string | null } | null {
  const days = daysBetween(fromDay, toDay);
  if (days === 0) return null;
  if (item.startAt === null && item.dueAt === null) {
    return { startAt: null, dueAt: `${toDay}T17:00:00.000Z` };
  }
  return { startAt: shiftInstant(item.startAt, days), dueAt: shiftInstant(item.dueAt, days) };
}
