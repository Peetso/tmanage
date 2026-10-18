import type { ChannelDirectoryEntry } from '../../lib/api/conversations';

/** CH-01's four filter chips. */
export type ChannelFilter = 'all' | 'mine' | 'client' | 'archived';

export const CHANNEL_FILTERS: readonly { readonly id: ChannelFilter; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'My channels' },
  { id: 'client', label: 'Client shared' },
  { id: 'archived', label: 'Archived' },
];

/**
 * Whether a row belongs under a chip. "Archived" is the only view that shows archived channels;
 * the other three are views of the live ones, so the counts never double-count an archived room.
 */
export function matchesFilter(entry: ChannelDirectoryEntry, filter: ChannelFilter): boolean {
  const archived = entry.archivedAt !== null;
  if (filter === 'archived') return archived;
  if (archived) return false;
  if (filter === 'mine') return entry.joined;
  if (filter === 'client') return entry.clientMemberCount > 0;
  return true;
}

export function countByFilter(
  entries: readonly ChannelDirectoryEntry[],
): Record<ChannelFilter, number> {
  const counts: Record<ChannelFilter, number> = { all: 0, mine: 0, client: 0, archived: 0 };
  for (const entry of entries) {
    for (const { id } of CHANNEL_FILTERS) if (matchesFilter(entry, id)) counts[id] += 1;
  }
  return counts;
}

/** Two initials for an avatar: first and last word, or the first two letters of a single word. */
export function initialsOf(displayName: string): string {
  const words = displayName.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...(words[0] ?? '')];
  if (words.length === 1) return first.slice(0, 2).join('').toUpperCase();
  const last = [...(words[words.length - 1] ?? '')];
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

const UNITS: readonly { readonly ms: number; readonly one: string; readonly many: string }[] = [
  { ms: 365 * 24 * 3_600_000, one: 'year', many: 'years' },
  { ms: 30 * 24 * 3_600_000, one: 'month', many: 'months' },
  { ms: 7 * 24 * 3_600_000, one: 'week', many: 'weeks' },
  { ms: 24 * 3_600_000, one: 'day', many: 'days' },
  { ms: 3_600_000, one: 'hour', many: 'hours' },
  { ms: 60_000, one: 'min', many: 'min' },
];

/** "2 min ago", "1 hour ago", "4 months ago" — the CH-01 last-activity column. */
export function formatLastActivity(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const elapsed = Math.max(0, now - at);
  for (const unit of UNITS) {
    const count = Math.floor(elapsed / unit.ms);
    if (count >= 1) return `${count} ${count === 1 ? unit.one : unit.many} ago`;
  }
  return 'just now';
}
