import type { HomeSummary, MyDay, Waiting } from '../../lib/api/home';

/**
 * **My Day v3 — the one ranked read.** Pure functions that turn the API's reads into what every
 * widget shows, so Next, At a glance, Due & at risk, Waiting, By project and the summary line can
 * never disagree (spec §7 engineering note; check C4). Nothing here renders and nothing fetches.
 */

export type MyDayEntry = MyDay['items'][number];
export type WaitingEntry = Waiting['items'][number];

/** Which group of Due & at risk an item belongs to. */
export type DueGroup = 'overdue' | 'today' | 'soon' | 'later';
/** The selected chip of Due & at risk; `null` shows every group, most urgent first. */
export type DueFilter = Exclude<DueGroup, 'later'> | null;

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(value: number): number {
  const day = new Date(value);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** The local calendar-day difference `due − today` (negative when late). */
export function dayOffset(dueAt: string, now: number): number | null {
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return null;
  return Math.round((startOfDay(due) - startOfDay(now)) / DAY_MS);
}

/** Overdue first (the API's own reason), then what is due today, then the rest of "due soon". */
export function dueGroup(entry: MyDayEntry, now: number): DueGroup {
  if (entry.reason === 'overdue') return 'overdue';
  const offset = entry.workItem.dueAt ? dayOffset(entry.workItem.dueAt, now) : null;
  if (offset !== null && offset <= 0) return 'today';
  if (entry.reason === 'due_soon') return 'soon';
  return 'later';
}

/** Whole days late, at least 1 for anything the API calls overdue. */
export function daysLate(entry: MyDayEntry, now: number): number {
  const offset = entry.workItem.dueAt ? dayOffset(entry.workItem.dueAt, now) : null;
  return Math.max(1, offset === null ? 1 : -offset);
}

/** "On others": a client request where the person has acted and now waits on the client. */
export function isOnOthers(entry: WaitingEntry): boolean {
  return entry.reason === 'stale_follow_up';
}

export function waitingSince(entry: WaitingEntry): string {
  return entry.kind === 'approval' ? entry.requestedAt : entry.waitingSince;
}

export function waitingId(entry: WaitingEntry): string {
  return entry.kind === 'approval' ? entry.approvalId : entry.clientRequestId;
}

/** The two Waiting tabs, oldest first in each (spec W5). */
export function splitWaiting(items: readonly WaitingEntry[]): {
  readonly onYou: readonly WaitingEntry[];
  readonly onOthers: readonly WaitingEntry[];
} {
  const oldestFirst = [...items].sort(
    (a, b) => Date.parse(waitingSince(a)) - Date.parse(waitingSince(b)),
  );
  return {
    onYou: oldestFirst.filter((entry) => !isOnOthers(entry)),
    onOthers: oldestFirst.filter(isOnOthers),
  };
}

/** The one item Next shows: late work first, then the oldest thing waiting on you, then the list. */
export type NextPick =
  | { readonly kind: 'work'; readonly entry: MyDayEntry }
  | { readonly kind: 'waiting'; readonly entry: WaitingEntry }
  | null;

export function pickNext(items: readonly MyDayEntry[], onYou: readonly WaitingEntry[]): NextPick {
  const late = items.find((entry) => entry.reason === 'overdue');
  if (late) return { kind: 'work', entry: late };
  const waiting = onYou[0];
  if (waiting) return { kind: 'waiting', entry: waiting };
  const first = items[0];
  return first ? { kind: 'work', entry: first } : null;
}

/** The id Next holds, so no list shows it a second time (spec rule 6, check C3). */
export function nextKey(next: NextPick): string | null {
  if (next === null) return null;
  return next.kind === 'work'
    ? `work:${next.entry.workItem.id}`
    : `waiting:${waitingId(next.entry)}`;
}

/** Every number on the page, from one place (check C4). */
export interface MyDayCounts {
  /** Open work assigned to the person: At a glance "Open", Due & at risk "All (n)". */
  readonly open: number;
  readonly overdue: number;
  readonly today: number;
  readonly soon: number;
  /** At a glance "Waiting", the summary line, the "On you" tab. */
  readonly waitingOnYou: number;
  readonly waitingOnOthers: number;
  /** At a glance "Meetings": the meetings in the Today strip. */
  readonly meetings: number;
}

export function deriveCounts(input: {
  readonly summary: HomeSummary | undefined;
  readonly items: readonly MyDayEntry[];
  readonly waiting: { readonly onYou: readonly unknown[]; readonly onOthers: readonly unknown[] };
  readonly waitingLoaded: boolean;
  readonly meetings: number;
  readonly now: number;
}): MyDayCounts {
  const { summary, items, waiting, now } = input;
  const groups = items.map((entry) => dueGroup(entry, now));
  const count = (group: DueGroup) => groups.filter((value) => value === group).length;
  const listOverdue = count('overdue');
  return {
    // The list is bounded on the API (MY_DAY_LIMIT); the summary counts every open item.
    open: summary?.personalWork.total ?? items.length,
    overdue: Math.max(summary?.personalWork.overdue ?? listOverdue, listOverdue),
    today: count('today'),
    soon: count('soon'),
    waitingOnYou: input.waitingLoaded
      ? waiting.onYou.length
      : summary
        ? summary.waiting.total - summary.waiting.staleFollowUps
        : 0,
    waitingOnOthers: input.waitingLoaded
      ? waiting.onOthers.length
      : (summary?.waiting.staleFollowUps ?? 0),
    meetings: input.meetings,
  };
}

/** The rows Due & at risk lists: the chosen group (or all, most urgent first), Next left out. */
export function dueRows(
  items: readonly MyDayEntry[],
  filter: DueFilter,
  excludeWorkId: string | null,
  now: number,
  limit = 5,
): MyDayEntry[] {
  const rank: Record<DueGroup, number> = { overdue: 0, today: 1, soon: 2, later: 3 };
  return items
    .filter((entry) => entry.workItem.id !== excludeWorkId)
    .map((entry, index) => ({ entry, index, group: dueGroup(entry, now) }))
    .filter(({ group }) => (filter === null ? true : group === filter))
    .sort((a, b) => rank[a.group] - rank[b.group] || a.index - b.index)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

/** One By project row: counts until it is opened (spec W6). */
export interface ProjectRow {
  readonly projectId: string;
  readonly open: number;
  readonly late: number;
  readonly waitingOnYou: number;
  readonly waitingOnOthers: number;
  /** The earliest due date still ahead (today included), as an ISO string. */
  readonly nextDue: string | null;
  readonly entries: readonly MyDayEntry[];
}

export function projectRows(
  items: readonly MyDayEntry[],
  waiting: { readonly onYou: readonly WaitingEntry[]; readonly onOthers: readonly WaitingEntry[] },
  now: number,
): ProjectRow[] {
  const order: string[] = [];
  const rows = new Map<
    string,
    {
      entries: MyDayEntry[];
      late: number;
      waitingOnYou: number;
      waitingOnOthers: number;
      nextDue: string | null;
    }
  >();
  const row = (projectId: string) => {
    let found = rows.get(projectId);
    if (!found) {
      found = { entries: [], late: 0, waitingOnYou: 0, waitingOnOthers: 0, nextDue: null };
      rows.set(projectId, found);
      order.push(projectId);
    }
    return found;
  };
  for (const entry of items) {
    const target = row(entry.workItem.projectId);
    target.entries.push(entry);
    if (entry.reason === 'overdue') target.late += 1;
    const due = entry.workItem.dueAt;
    const offset = due ? dayOffset(due, now) : null;
    if (due && offset !== null && offset >= 0) {
      if (target.nextDue === null || Date.parse(due) < Date.parse(target.nextDue)) {
        target.nextDue = due;
      }
    }
  }
  for (const entry of waiting.onYou) row(entry.projectId).waitingOnYou += 1;
  for (const entry of waiting.onOthers) row(entry.projectId).waitingOnOthers += 1;
  return order.map((projectId) => {
    const value = rows.get(projectId) as NonNullable<ReturnType<typeof rows.get>>;
    return {
      projectId,
      open: value.entries.length,
      late: value.late,
      waitingOnYou: value.waitingOnYou,
      waitingOnOthers: value.waitingOnOthers,
      nextDue: value.nextDue,
      entries: value.entries,
    };
  });
}

/** A list widget shows at most this many rows; "All (n)" opens the rest (spec rule 4). */
export const LIST_ROWS = { wide: 5, narrow: 4, shortcuts: 3, projects: 4 } as const;

/** "All (n)" is drawn only when there is something to open (Fable F4 (a)). */
export function showAll(total: number): boolean {
  return total > 0;
}
