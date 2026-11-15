import type { Capability } from '@tmanage/domain';
import type { SearchResult } from '../../lib/api/search';
import { INTERNAL_NAVIGATION } from './navigation';

/**
 * Rows 55-06 / 55-05 — the command palette v2 and the global "+ New" menu, as data.
 *
 * Pure on purpose: the ranking, the permission filter and the grouping are what the palette and
 * the "+ New" menu decide, so they live here, out of React, where a unit test can read them
 * directly (Figma "R48 L2 · 55-06 Command palette v2 + 55-05 global + New", 589:33479).
 *
 * Nothing here runs anything: an item only names an org-relative `href` or a closed
 * {@link PaletteAction} id, and the caller dispatches through its own `switch`. The typed query
 * is only ever a filter, never an href or an action.
 */

/** The sections the palette draws, in order. */
export type PaletteGroupId = 'search' | 'recent' | 'create' | 'actions' | 'navigate' | 'results';

export const GROUP_ORDER: readonly PaletteGroupId[] = [
  'search',
  'recent',
  'create',
  'actions',
  'navigate',
  'results',
];

/** The only things a palette row may do besides follow a link. A closed set: unknown ids never run. */
export type PaletteAction =
  'create-doc' | 'start-timer' | 'toggle-theme' | 'toggle-language' | 'search-workspace';

export type PaletteRun =
  | { readonly type: 'href'; readonly href: string }
  | { readonly type: 'action'; readonly action: PaletteAction }
  /** A server registry action id, dispatched by the palette's own closed switch. */
  | { readonly type: 'command'; readonly action: string };

/** A row before translation: a message key with its English fallback. */
export interface PaletteItemSpec {
  readonly id: string;
  readonly group: PaletteGroupId;
  readonly messageKey: string;
  readonly fallback: string;
  /** Extra words the ranking matches ("task" finds "New task" and "Log time" finds "hours"). */
  readonly keywords?: readonly string[];
  /** The capability the person's role must hold; the row is hidden otherwise. */
  readonly capability?: Capability;
  /** The shortcut hint drawn at the row's end, e.g. `G P`. */
  readonly hint?: string;
  readonly run: PaletteRun;
}

/** A row after translation, ready to rank. */
export interface PaletteItem {
  readonly id: string;
  readonly group: PaletteGroupId;
  readonly label: string;
  readonly keywords?: readonly string[];
  readonly capability?: Capability;
  readonly hint?: string;
  /** A short tag at the row's end (a result's kind); drawn in place of the hint. */
  readonly tag?: string;
  /** Rows the server already matched against the query keep a floor score instead of being re-filtered. */
  readonly preMatched?: boolean;
  readonly run: PaletteRun;
}

/**
 * The create actions — shared by the palette's CREATE group and the shell's "+ New" menu so the
 * two can never offer different things. Each names the capability the API would ask for.
 */
export const CREATE_ACTIONS: readonly PaletteItemSpec[] = [
  {
    id: 'new-task',
    group: 'create',
    messageKey: 'CommandPaletteV2.newTask',
    fallback: 'New task',
    keywords: ['work', 'item', 'todo', 'capture'],
    capability: 'work.create',
    hint: 'C',
    run: { type: 'href', href: '/capture' },
  },
  {
    id: 'new-project',
    group: 'create',
    messageKey: 'CommandPaletteV2.newProject',
    fallback: 'New project',
    capability: 'project.create',
    run: { type: 'href', href: '/projects/new' },
  },
  {
    id: 'new-doc',
    group: 'create',
    messageKey: 'CommandPaletteV2.newDoc',
    fallback: 'New doc',
    keywords: ['document', 'page', 'note'],
    capability: 'doc.write',
    run: { type: 'action', action: 'create-doc' },
  },
  {
    id: 'new-meeting',
    group: 'create',
    messageKey: 'CommandPaletteV2.newMeeting',
    fallback: 'New meeting',
    keywords: ['calendar', 'event', 'call'],
    capability: 'meeting.write',
    run: { type: 'href', href: '/calendar/new' },
  },
];

/** The time actions — in the palette's ACTIONS group and at the foot of the "+ New" menu. */
export const TIME_ACTIONS: readonly PaletteItemSpec[] = [
  {
    id: 'log-time',
    group: 'actions',
    messageKey: 'CommandPaletteV2.logTime',
    fallback: 'Log time',
    keywords: ['timesheet', 'hours'],
    capability: 'work.read',
    run: { type: 'href', href: '/finance/timesheets' },
  },
  {
    id: 'start-timer',
    group: 'actions',
    messageKey: 'CommandPaletteV2.startTimer',
    fallback: 'Start timer',
    keywords: ['time', 'clock', 'track'],
    capability: 'work.read',
    run: { type: 'action', action: 'start-timer' },
  },
];

/** The rest of ACTIONS: workspace, language and theme. No capability: every member may use them. */
export const SHELL_ACTIONS: readonly PaletteItemSpec[] = [
  {
    id: 'switch-workspace',
    group: 'actions',
    messageKey: 'CommandPaletteV2.switchWorkspace',
    fallback: 'Switch workspace',
    keywords: ['organization', 'company', 'studio'],
    run: { type: 'href', href: '/organizations' },
  },
  {
    id: 'toggle-language',
    group: 'actions',
    messageKey: 'CommandPaletteV2.switchToArabic',
    fallback: 'Switch to العربية',
    keywords: ['language', 'arabic', 'english', 'locale'],
    run: { type: 'action', action: 'toggle-language' },
  },
  {
    id: 'toggle-theme',
    group: 'actions',
    messageKey: 'CommandPaletteV2.darkTheme',
    fallback: 'Dark theme',
    keywords: ['dark', 'light', 'mode', 'appearance'],
    run: { type: 'action', action: 'toggle-theme' },
  },
];

const NAVIGATION_HINTS: Readonly<Record<string, string>> = { home: 'G H', work: 'G W' };

/** GO TO: the rail's destinations, with the `g` shortcuts the shortcut layer already binds. */
export const NAVIGATE_ITEMS: readonly PaletteItemSpec[] = [
  ...INTERNAL_NAVIGATION.map((item): PaletteItemSpec => ({
    id: `nav-${item.id}`,
    group: 'navigate',
    messageKey: item.messageKey,
    fallback: item.label,
    keywords: [item.label],
    ...(NAVIGATION_HINTS[item.id] ? { hint: NAVIGATION_HINTS[item.id] } : {}),
    run: { type: 'href', href: item.href },
  })),
  {
    id: 'nav-projects',
    group: 'navigate',
    messageKey: 'CommandPaletteV2.projects',
    fallback: 'Projects',
    keywords: ['portfolio'],
    hint: 'G P',
    run: { type: 'href', href: '/projects/portfolio' },
  },
  {
    // TIMER item 5: Team time, for the people allowed to see it (the API checks it again).
    id: 'nav-team-time',
    group: 'navigate',
    messageKey: 'FinanceCore.tabTeamTime',
    fallback: 'Team time',
    keywords: ['timer', 'tracking', 'who is working', 'time'],
    capability: 'time.view_team',
    run: { type: 'href', href: '/finance/team-time' },
  },
];

/** Every static row the palette offers, before permissions. */
export const PALETTE_SPECS: readonly PaletteItemSpec[] = [
  ...CREATE_ACTIONS,
  ...TIME_ACTIONS,
  ...SHELL_ACTIONS,
  ...NAVIGATE_ITEMS,
];

/** Lower-case, trimmed, Arabic diacritics and tatweel removed, so "مَشروع" finds "مشروع". */
export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ًͯ-ٰٟـ]/gu, '')
    .toLowerCase()
    .trim();
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of haystack) {
    if (char === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * How well a row matches the query: 0 hides it. An empty query matches everything equally, so
 * the static order stands. Whole label > label prefix > word prefix > substring > keyword >
 * letters in order (a typo-tolerant last resort, only for queries of 2+ letters).
 */
export function scoreMatch(query: string, label: string, keywords: readonly string[] = []): number {
  const q = normalize(query);
  if (q === '') return 1;
  const l = normalize(label);
  if (l === q) return 100;
  if (l.startsWith(q)) return 80;
  if (l.split(/[\s/·\-–]+/u).some((word) => word.startsWith(q))) return 60;
  if (l.includes(q)) return 40;
  const words = keywords.map(normalize);
  if (words.some((word) => word.startsWith(q))) return 30;
  if (words.some((word) => word.includes(q))) return 20;
  if (q.length >= 2 && isSubsequence(q, l.replace(/\s+/gu, ''))) return 10;
  return 0;
}

/**
 * Hide every row whose capability the person's role does not hold. `may` must fail closed: while
 * the role is unknown it answers no, so a gated row never flashes into view and then vanishes.
 * Never an authorization — the API decides every request; this only stops offering refusals.
 */
export function filterByPermission<T extends { readonly capability?: Capability }>(
  items: readonly T[],
  may: (capability: Capability) => boolean,
): T[] {
  return items.filter((item) => item.capability === undefined || may(item.capability));
}

export interface PaletteSection {
  readonly group: PaletteGroupId;
  readonly items: readonly PaletteItem[];
}

/** At most this many rows per section, so a broad query keeps every section on screen. */
export const SECTION_LIMIT = 6;

/**
 * Score, drop non-matches, order by score inside each section (stable: equal scores keep their
 * given order), cap each section and return the sections, empty ones omitted. A row the server
 * already matched keeps at least a floor score.
 *
 * ACCOUNT item 5 (live persona test 2026-11-15): the sections follow their best match, so an
 * exact or prefix match of the typed text is always above a fuzzy one, wherever it lives; equal
 * best matches keep {@link GROUP_ORDER}, where Recent comes first, so a recent item breaks the
 * tie. The "Search for …" row is an action on the query rather than a match of it: it ranks at
 * the floor. With no query every row scores alike and the static order stands.
 */
export function rankPalette(items: readonly PaletteItem[], query: string): PaletteSection[] {
  const scored = items
    .map((item, index) => {
      const score = item.group === 'search' ? 1 : scoreMatch(query, item.label, item.keywords);
      return { item, index, score: item.preMatched ? Math.max(score, 1) : score };
    })
    .filter((row) => row.score > 0);
  return GROUP_ORDER.map((group, order) => {
    const rows = scored
      .filter((row) => row.item.group === group)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, SECTION_LIMIT);
    return { group, order, best: rows[0]?.score ?? 0, items: rows.map((row) => row.item) };
  })
    .filter((section) => section.items.length > 0)
    .sort((a, b) => b.best - a.best || a.order - b.order)
    .map(({ group, items: sectionItems }) => ({ group, items: sectionItems }));
}

/** The flat keyboard order of the drawn sections — what ArrowUp / ArrowDown walk. */
export function flattenSections(sections: readonly PaletteSection[]): PaletteItem[] {
  return sections.flatMap((section) => [...section.items]);
}

/** ArrowDown / ArrowUp / Home / End over `count` rows, wrapping at both ends. */
export function moveActive(
  index: number,
  count: number,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
): number {
  if (count === 0) return 0;
  switch (key) {
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
  }
}

/** Where a live search hit opens (org-relative), or null for a kind with no page of its own. */
export function resultHref(hit: Pick<SearchResult, 'kind' | 'id'>): string | null {
  const id = encodeURIComponent(hit.id);
  switch (hit.kind) {
    case 'work_item':
      return `/work/${id}`;
    case 'project':
      return `/projects/${id}`;
    case 'document':
      return `/docs/${id}`;
    case 'meeting':
      return `/calendar/meetings/${id}`;
    case 'invoice':
      return `/finance/invoices/${id}`;
    case 'quote':
      return `/quotes/${id}`;
    case 'file':
      return `/files/${id}`;
    default:
      return null;
  }
}

/** One remembered row: what the person opened from the palette, newest first. */
export interface RecentItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
}

export const RECENT_LIMIT = 5;

/** Per organization, so one tenant's history never shows in another. */
export function recentItemsKey(slug: string): string {
  return `tmanage.palette-recent.${slug}`;
}

/** Only org-relative paths survive a read: a tampered store can never point the palette off-site. */
function isSafeHref(href: unknown): href is string {
  return typeof href === 'string' && href.startsWith('/') && !href.startsWith('//');
}

export function parseRecentItems(raw: string | null): RecentItem[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (row): row is RecentItem =>
          typeof row === 'object' &&
          row !== null &&
          typeof (row as RecentItem).id === 'string' &&
          typeof (row as RecentItem).label === 'string' &&
          isSafeHref((row as RecentItem).href),
      )
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** Put `item` first, drop its older copy, keep the newest {@link RECENT_LIMIT}. */
export function pushRecentItem(list: readonly RecentItem[], item: RecentItem): RecentItem[] {
  return [item, ...list.filter((row) => row.id !== item.id)].slice(0, RECENT_LIMIT);
}
