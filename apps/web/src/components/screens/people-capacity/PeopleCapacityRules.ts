import type { CapsuleState } from '@tmanage/ui';
import type { CapacityRosterEntry } from './PeopleOverviewApi';

/** How a member's week reads on the capacity screen. */
export type WeekLoad = 'unset' | 'away' | 'over' | 'busy' | 'room';

/** Above this share of a week, a member is busy rather than having room. */
export const BUSY_FROM_PERCENT = 80;

/** Away wins (time off this week), then no capacity set, then over/busy/room by confirmed percent. */
export function weekLoad(member: CapacityRosterEntry): WeekLoad {
  if (member.awayThisWeek) return 'away';
  if (member.weeklyHours === null || member.weeklyHours === 0) return 'unset';
  if (member.allocatedPercent > 100) return 'over';
  if (member.allocatedPercent >= BUSY_FROM_PERCENT) return 'busy';
  return 'room';
}

export const LOAD_CAPSULE: Record<WeekLoad, CapsuleState> = {
  unset: 'neutral',
  away: 'waiting',
  over: 'blocked',
  busy: 'current',
  room: 'done',
};

/** The team's numbers for the three metric cards. Hours are confirmed allocations only. */
export function teamTotals(members: readonly CapacityRosterEntry[]): {
  readonly hours: number;
  readonly allocatedPercent: number | null;
  readonly away: number;
} {
  let hours = 0;
  let allocatedHours = 0;
  let away = 0;
  for (const member of members) {
    if (member.awayThisWeek) away += 1;
    const weekly = member.weeklyHours ?? 0;
    hours += weekly;
    allocatedHours += (weekly * member.allocatedPercent) / 100;
  }
  return {
    hours,
    allocatedPercent: hours === 0 ? null : Math.round((allocatedHours / hours) * 100),
    away,
  };
}

/** `YYYY-MM-DD` for today in UTC. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
