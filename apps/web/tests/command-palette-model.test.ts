import { describe, expect, it } from 'vitest';
import { hasCapability } from '@tmanage/domain';
import {
  CREATE_ACTIONS,
  PALETTE_SPECS,
  filterByPermission,
  flattenSections,
  moveActive,
  parseRecentItems,
  pushRecentItem,
  rankPalette,
  resultHref,
  scoreMatch,
  type PaletteItem,
} from '../src/components/shell/command-palette-model';
import { nextLocale, nextTheme } from '../src/components/shell/palette-actions';

/** Rows 55-06 / 55-05 — the palette's ranking, permission filter, grouping and keyboard order. */

const item = (id: string, group: PaletteItem['group'], label: string, extra = {}): PaletteItem => ({
  id,
  group,
  label,
  run: { type: 'href', href: `/${id}` },
  ...extra,
});

describe('scoreMatch', () => {
  it('ranks whole label > prefix > word prefix > substring > keyword > letters in order', () => {
    const scores = [
      scoreMatch('work', 'Work'),
      scoreMatch('work', 'Workload'),
      scoreMatch('work', 'My work'),
      scoreMatch('ork', 'Network'),
      scoreMatch('hours', 'Log time', ['hours']),
      scoreMatch('lgtm', 'Log time'),
    ];
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(new Set(scores).size).toBe(scores.length);
    expect(scoreMatch('zzz', 'Log time')).toBe(0);
    expect(scoreMatch('', 'Anything')).toBe(1);
  });

  it('ignores case and Arabic diacritics', () => {
    expect(scoreMatch('مَشروع', 'مشروع جديد')).toBe(80);
    expect(scoreMatch('NEW', 'new task')).toBe(80);
  });
});

describe('rankPalette', () => {
  it('orders sections, sorts by score inside each, drops non-matches and keeps server rows', () => {
    const sections = rankPalette(
      [
        item('nav-work', 'navigate', 'Work'),
        item('hit', 'results', 'Totally unrelated title', { preMatched: true }),
        item('new-project', 'create', 'New project'),
        item('nav-projects', 'navigate', 'Projects'),
        item('new-task', 'create', 'New task'),
      ],
      'pro',
    );
    // ACCOUNT item 5: the prefix match (Projects, 80) leads the word-prefix one (New project, 60).
    expect(sections.map((s) => s.group)).toEqual(['navigate', 'create', 'results']);
    expect(sections[0]?.items.map((i) => i.id)).toEqual(['nav-projects']);
    expect(sections[1]?.items.map((i) => i.id)).toEqual(['new-project']);
  });

  it('ACCOUNT item 5: exact and prefix matches rank above fuzzy ones; recent breaks ties', () => {
    const flat = flattenSections(
      rankPalette(
        [
          item('search-workspace', 'search', 'Search for “time”', { preMatched: true }),
          item('fuzzy', 'create', 'Tip: mention everyone'),
          item('nav-time', 'navigate', 'Time'),
          item('recent-time', 'recent', 'Time'),
          item('nav-timeline', 'navigate', 'Timeline'),
        ],
        'time',
      ),
    ).map((row) => row.id);
    // Exact first, the recent copy ahead of the equal navigate one; prefix next; the letters-in-
    // order match after; the search action last.
    expect(flat).toEqual(['recent-time', 'nav-time', 'nav-timeline', 'fuzzy', 'search-workspace']);
  });

  it('caps each section so every section stays on screen', () => {
    const many = Array.from({ length: 10 }, (_, n) => item(`n${n}`, 'navigate', `Page ${n}`));
    expect(rankPalette(many, '')[0]?.items).toHaveLength(6);
  });
});

describe('filterByPermission', () => {
  it('hides create rows a guest may not use and keeps ungated rows', () => {
    const guest = filterByPermission(PALETTE_SPECS, (c) => hasCapability('guest', c));
    const ids = guest.map((s) => s.id);
    expect(ids).not.toContain('new-project');
    expect(ids).not.toContain('new-task');
    expect(ids).toContain('switch-workspace');
    const owner = filterByPermission(CREATE_ACTIONS, (c) => hasCapability('owner', c));
    expect(owner).toHaveLength(CREATE_ACTIONS.length);
  });

  it('offers Team time only to people who may see it (TIMER item 5)', () => {
    const ids = (role: 'owner' | 'member') =>
      filterByPermission(PALETTE_SPECS, (c) => hasCapability(role, c)).map((s) => s.id);
    expect(ids('owner')).toContain('nav-team-time');
    expect(ids('member')).not.toContain('nav-team-time');
  });

  it('fails closed while the role is unknown', () => {
    expect(filterByPermission(CREATE_ACTIONS, () => false)).toEqual([]);
  });
});

describe('keyboard order and recents', () => {
  it('wraps arrow movement at both ends', () => {
    expect(moveActive(2, 3, 'ArrowDown')).toBe(0);
    expect(moveActive(0, 3, 'ArrowUp')).toBe(2);
    expect(moveActive(1, 3, 'End')).toBe(2);
    expect(moveActive(0, 0, 'ArrowDown')).toBe(0);
  });

  it('keeps only org-relative recents, newest first, without duplicates', () => {
    const raw = JSON.stringify([
      { id: 'a', label: 'A', href: '/work' },
      { id: 'evil', label: 'X', href: '//evil.example' },
      { id: 'evil2', label: 'Y', href: 'https://evil.example' },
    ]);
    const list = parseRecentItems(raw);
    expect(list.map((r) => r.id)).toEqual(['a']);
    expect(parseRecentItems('not json')).toEqual([]);
    const next = pushRecentItem(
      pushRecentItem(list, { id: 'b', label: 'B', href: '/b' }),
      list[0]!,
    );
    expect(next.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('opens a hit at its page and refuses a kind without one', () => {
    expect(resultHref({ kind: 'project', id: 'p 1' })).toBe('/projects/p%201');
    expect(resultHref({ kind: 'message', id: 'm' })).toBeNull();
  });

  it('toggles between English and the reader’s RTL language, and light and dark', () => {
    expect(nextLocale('ar-EG')).toBe('en-US');
    expect(nextLocale('ur-PK')).toBe('en-US');
    expect(nextLocale('en-GB')).toBe('ar-EG');
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme(undefined)).toBe('dark');
  });
});
