import type { ChannelDirectoryEntry } from '../../lib/api/conversations';
import {
  activeIsEnglish,
  relativeAgo,
  translateOr,
  type CompactUnit,
} from '../../lib/i18n/compact-time';
import { activeLocale } from '../../lib/i18n/locale-store';

/** CH-01's four filter chips. */
export type ChannelFilter = 'all' | 'mine' | 'client' | 'archived';

export const CHANNEL_FILTERS: readonly {
  readonly id: ChannelFilter;
  readonly label: string;
  /** The catalog key the chip reads in the active locale; `label` is its English text. */
  readonly labelKey: string;
}[] = [
  { id: 'all', label: 'All', labelKey: 'ChannelBrowser.filterAll' },
  { id: 'mine', label: 'My channels', labelKey: 'ChannelBrowser.filterMine' },
  { id: 'client', label: 'Client shared', labelKey: 'ChannelBrowser.filterClient' },
  { id: 'archived', label: 'Archived', labelKey: 'ChannelBrowser.filterArchived' },
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

const UNITS: readonly {
  readonly ms: number;
  readonly unit: CompactUnit;
  readonly one: string;
  readonly many: string;
}[] = [
  { ms: 365 * 24 * 3_600_000, unit: 'year', one: 'year', many: 'years' },
  { ms: 30 * 24 * 3_600_000, unit: 'month', one: 'month', many: 'months' },
  { ms: 7 * 24 * 3_600_000, unit: 'week', one: 'week', many: 'weeks' },
  { ms: 24 * 3_600_000, unit: 'day', one: 'day', many: 'days' },
  { ms: 3_600_000, unit: 'hour', one: 'hour', many: 'hours' },
  { ms: 60_000, unit: 'minute', one: 'min', many: 'min' },
];

/** "2 min ago", "1 hour ago", "4 months ago" — the CH-01 last-activity column. */
export function formatLastActivity(
  iso: string,
  now: number = Date.now(),
  locale: string = activeLocale.get(),
): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const elapsed = Math.max(0, now - at);
  const english = activeIsEnglish(locale);
  for (const unit of UNITS) {
    const count = Math.floor(elapsed / unit.ms);
    if (count >= 1) {
      // Arabic (2026-10-31 live test read "18 min ago"): the platform's own phrase and plurals.
      return english
        ? `${count} ${count === 1 ? unit.one : unit.many} ago`
        : relativeAgo(count, unit.unit, locale);
    }
  }
  return translateOr('ChannelBrowser.justNow', 'just now', locale);
}
