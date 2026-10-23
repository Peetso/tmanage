/**
 * The two navigation sets, from `22-SCREEN-BY-SCREEN` §1.
 *
 *   "Internal desktop: global rail (Home, Inbox, Chat, Work, Calendar, Docs, People,
 *    Insights) […] Client desktop: TManage/client brand, project selector if authorized,
 *    Overview, My Actions, Deliverables, Timeline, Updates, Files, People."
 *
 * They are data rather than markup so the same list drives the desktop rail, the mobile
 * dock (`22` §1: "bottom navigation with no hover dependency") and the tests that assert
 * the two audiences never share a destination. The client list is not a subset of the
 * internal one and must never be derived from it by filtering: "My Actions" and
 * "Deliverables" do not exist internally, and an internal destination that leaked into the
 * portal would be a tenancy failure rendered as a link.
 *
 * The glyphs are decorative. Every item carries a real label, which is the accessible name;
 * the glyph is `aria-hidden` wherever it is rendered.
 *
 * Every `href` is a suffix. Both shells prefix it with the organization's slug, because every
 * screen is tenant-scoped (`/{slug}/inbox`, `/{slug}/portal`); an item rendered bare would
 * point at a route that does not exist.
 */

import type { MessageKey } from '../../lib/i18n/t';

export interface NavigationItem {
  readonly id: string;
  /**
   * The English label — the source of truth for the destination's name, the fallback the
   * catalog resolves against, and the accessible name a test reads. The rail, dock and portal
   * render `messageKey` through `t()` so an Arabic member sees the Arabic word; English is
   * unchanged, so an English member and the audience tests still read this string.
   */
  readonly label: string;
  /** The message-catalog key for {@link label}, so every shell can render it in the member's locale. */
  readonly messageKey: MessageKey;
  readonly href: string;
  readonly glyph: string;
}

/**
 * The internal orbital rail. Order is the export's, top to bottom. Labels and glyphs follow
 * HOME-01: Home is "My Day" there, and the glyphs are the rail's own (◉ ✉ ◌ ▤ ◫ ◔).
 */
export const INTERNAL_NAVIGATION: readonly NavigationItem[] = [
  { id: 'home', label: 'My Day', messageKey: 'nav.home', href: '/home', glyph: '◉' },
  { id: 'inbox', label: 'Inbox', messageKey: 'nav.inbox', href: '/inbox', glyph: '✉' },
  { id: 'chat', label: 'Chat', messageKey: 'nav.chat', href: '/chat', glyph: '◌' },
  { id: 'work', label: 'Work', messageKey: 'nav.work', href: '/work', glyph: '▤' },
  { id: 'calendar', label: 'Calendar', messageKey: 'nav.calendar', href: '/calendar', glyph: '◷' },
  { id: 'docs', label: 'Docs', messageKey: 'nav.docs', href: '/docs', glyph: '◫' },
  { id: 'clients', label: 'Clients', messageKey: 'nav.clients', href: '/clients', glyph: '◇' },
  { id: 'people', label: 'People', messageKey: 'nav.people', href: '/people', glyph: '◎' },
  { id: 'insights', label: 'Insights', messageKey: 'nav.insights', href: '/insights', glyph: '◔' },
];

/**
 * The Control Center orb at the foot of the rail. `sitemap-and-role-navigation.md`: "Owner /
 * Admin — all 8 + Control Center … the Control Center orb is the only path to policy, roles,
 * audit, billing". It is not in `INTERNAL_NAVIGATION` because it is role-gated: `AppShell`
 * renders it only once the session's role for this organization is known to be owner or admin.
 */
export const CONTROL_CENTER_NAVIGATION: NavigationItem = {
  id: 'admin',
  label: 'Control',
  messageKey: 'nav.control',
  href: '/admin',
  glyph: '⚙',
};

/**
 * The phone tab bar (Figma ph-tabbar, 378:18173 / 379:3600): My Day, Inbox, Chat, Work, More,
 * in a white pill beside the lime quick-capture orb.
 *
 * The first four are `INTERNAL_NAVIGATION` items, listed by id so the dock invents no route the
 * rail does not own. The fifth is not a destination: "More" opens the bottom sheet
 * (`MoreSheet`, ph-more) that carries every other destination, so it has no `href`.
 */
export const MOBILE_PRIMARY_NAVIGATION_IDS = ['home', 'inbox', 'chat', 'work'] as const;

export const MOBILE_DESTINATIONS: readonly NavigationItem[] = MOBILE_PRIMARY_NAVIGATION_IDS.map(
  (id) => {
    const item = INTERNAL_NAVIGATION.find((candidate) => candidate.id === id);
    if (!item) {
      // A build-time guarantee: the dock can only ever point where the rail already does.
      throw new Error(`MOBILE_PRIMARY_NAVIGATION references unknown internal destination "${id}"`);
    }
    return item;
  },
);

/** The "More" slot. The `shell.mobile.*` keys ship as the A3 fragment; the cast holds until merged. */
export const MOBILE_MORE_ITEM: NavigationItem = {
  id: 'more',
  label: 'More',
  messageKey: 'shell.mobile.more' as MessageKey,
  href: '',
  glyph: '⋯',
};

/** The five tab-bar slots, in order: four destinations and the More disclosure. */
export const MOBILE_PRIMARY_NAVIGATION: readonly NavigationItem[] = [
  ...MOBILE_DESTINATIONS,
  MOBILE_MORE_ITEM,
];

/** One tile of the More sheet. `href` is an org suffix unless `absolute` (the public help centre). */
export interface MoreSheetItem extends NavigationItem {
  readonly absolute?: boolean;
}

const more = (id: string, label: string, href: string, glyph: string, absolute = false) =>
  ({
    id,
    label,
    messageKey: `MoreSheet.${id}` as MessageKey,
    href,
    glyph,
    ...(absolute ? { absolute } : {}),
  }) satisfies MoreSheetItem;

/** ph-more's WORKSPACE grid, in the frame's order. */
export const MORE_WORKSPACE_NAVIGATION: readonly MoreSheetItem[] = [
  more('projects', 'Projects', '/projects', '▦'),
  more('clients', 'Clients', '/clients', '◎'),
  more('requests', 'Requests', '/work/requests', '◷'),
  more('calendar', 'Calendar', '/calendar', '▣'),
  more('docs', 'Docs & decisions', '/docs', '◫'),
  more('files', 'Files & approvals', '/inbox', '⇧'),
  more('people', 'People', '/people', '◍'),
  more('insights', 'Insights', '/insights', '◔'),
];

/** ph-more's TOOLS & ACCOUNT row. Help is the public help centre, not an org route. */
export const MORE_TOOLS_NAVIGATION: readonly MoreSheetItem[] = [
  more('automations', 'Automations', '/automations', '⟳'),
  more('search', 'Search', '/search', '⌕'),
  more('settings', 'Settings', '/settings', '⚙'),
  more('help', 'Help', '/faq', '?', true),
];

/** The client portal. A separate space, not a filtered view of the one above. */
export const CLIENT_NAVIGATION: readonly NavigationItem[] = [
  { id: 'overview', label: 'Overview', messageKey: 'nav.overview', href: '/portal', glyph: '◉' },
  {
    id: 'actions',
    label: 'My Actions',
    messageKey: 'nav.actions',
    href: '/portal/actions',
    glyph: '◍',
  },
  {
    id: 'deliverables',
    label: 'Deliverables',
    messageKey: 'nav.deliverables',
    href: '/portal/deliverables',
    glyph: '▦',
  },
  {
    id: 'timeline',
    label: 'Timeline',
    messageKey: 'nav.timeline',
    href: '/portal/timeline',
    glyph: '▥',
  },
  {
    id: 'updates',
    label: 'Updates',
    messageKey: 'nav.updates',
    href: '/portal/updates',
    glyph: '▤',
  },
  { id: 'risks', label: 'Risks', messageKey: 'nav.risks', href: '/portal/risks', glyph: '◭' },
  { id: 'files', label: 'Files', messageKey: 'nav.files', href: '/portal/files', glyph: '▧' },
  { id: 'people', label: 'People', messageKey: 'nav.people', href: '/portal/people', glyph: '◎' },
];
