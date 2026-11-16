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
 * The icons are decorative. Every item carries a real label, which is the accessible name;
 * the icon is `aria-hidden` wherever it is rendered.
 *
 * Every `href` is a suffix. Both shells prefix it with the organization's slug, because every
 * screen is tenant-scoped (`/{slug}/inbox`, `/{slug}/portal`); an item rendered bare would
 * point at a route that does not exist.
 */

import type { MessageKey } from '../../lib/i18n/t';
import type { PhoneIconName } from '../icons/phone';

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
  /**
   * The 24px line icon that means this page (R38 G3, Figma "R38 G3-icons"): drawn by the rail,
   * the dock, the More sheet and the portal, so every surface shows the same picture for a page.
   */
  readonly icon: PhoneIconName;
}

/**
 * The internal orbital rail. Order is the export's, top to bottom. Labels follow HOME-01: Home
 * is "My Day" there, drawn as a sun. R38 G3 replaced the old abstract symbols with icons that
 * mean the page.
 */
export const INTERNAL_NAVIGATION: readonly NavigationItem[] = [
  {
    id: 'home',
    label: 'My Day',
    messageKey: 'nav.home',
    href: '/home',
    icon: 'sun',
  },
  {
    id: 'inbox',
    label: 'Inbox',
    messageKey: 'nav.inbox',
    href: '/inbox',
    icon: 'inbox',
  },
  {
    id: 'chat',
    label: 'Chat',
    messageKey: 'nav.chat',
    href: '/chat',
    icon: 'messages',
  },
  {
    id: 'work',
    label: 'Work',
    messageKey: 'nav.work',
    href: '/work',
    icon: 'squareCheck',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    messageKey: 'nav.calendar',
    href: '/calendar',
    icon: 'calendar',
  },
  { id: 'docs', label: 'Docs', messageKey: 'nav.docs', href: '/docs', icon: 'file' },
  // FIX3 item 11: FIL-01 Files hub, as the design's rail has it (after Docs).
  { id: 'files', label: 'Files', messageKey: 'nav.files', href: '/files', icon: 'files' },
  {
    id: 'clients',
    label: 'Clients',
    messageKey: 'nav.clients',
    href: '/clients',
    icon: 'handshake',
  },
  { id: 'people', label: 'People', messageKey: 'nav.people', href: '/people', icon: 'users' },
  {
    id: 'insights',
    label: 'Insights',
    messageKey: 'nav.insights',
    href: '/insights',
    icon: 'barChart',
  },
  { id: 'finance', label: 'Finance', messageKey: 'nav.finance', href: '/finance', icon: 'receipt' },
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
  icon: 'sliders',
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
  icon: 'more',
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

const more = (id: string, label: string, href: string, icon: PhoneIconName, absolute = false) =>
  ({
    id,
    label,
    messageKey: `MoreSheet.${id}` as MessageKey,
    href,
    icon,
    ...(absolute ? { absolute } : {}),
  }) satisfies MoreSheetItem;

/** ph-more's WORKSPACE grid, in the frame's order. */
export const MORE_WORKSPACE_NAVIGATION: readonly MoreSheetItem[] = [
  more('projects', 'Projects', '/projects/portfolio', 'folderKanban'),
  more('clients', 'Clients', '/clients', 'handshake'),
  more('requests', 'Requests', '/work/requests', 'clipboardList'),
  more('calendar', 'Calendar', '/calendar', 'calendar'),
  more('docs', 'Docs & decisions', '/docs', 'file'),
  more('files', 'Files & approvals', '/inbox', 'files'),
  more('people', 'People', '/people', 'users'),
  more('insights', 'Insights', '/insights', 'barChart'),
];

/** ph-more's TOOLS & ACCOUNT row. Help is the public help centre, not an org route. */
export const MORE_TOOLS_NAVIGATION: readonly MoreSheetItem[] = [
  more('automations', 'Automations', '/automations', 'zap'),
  more('search', 'Search', '/search', 'search'),
  more('settings', 'Settings', '/settings', 'settings'),
  more('help', 'Help', '/faq', 'help', true),
];

/** The client portal. A separate space, not a filtered view of the one above. */
export const CLIENT_NAVIGATION: readonly NavigationItem[] = [
  {
    id: 'overview',
    label: 'Overview',
    messageKey: 'nav.overview',
    href: '/portal',
    icon: 'layoutDashboard',
  },
  {
    id: 'actions',
    label: 'My Actions',
    messageKey: 'nav.actions',
    href: '/portal/actions',
    icon: 'squareCheck',
  },
  {
    id: 'deliverables',
    label: 'Deliverables',
    messageKey: 'nav.deliverables',
    href: '/portal/deliverables',
    icon: 'package',
  },
  {
    id: 'timeline',
    label: 'Timeline',
    messageKey: 'nav.timeline',
    href: '/portal/timeline',
    icon: 'gantt',
  },
  {
    id: 'updates',
    label: 'Updates',
    messageKey: 'nav.updates',
    href: '/portal/updates',
    icon: 'megaphone',
  },
  { id: 'risks', label: 'Risks', messageKey: 'nav.risks', href: '/portal/risks', icon: 'alert' },
  { id: 'files', label: 'Files', messageKey: 'nav.files', href: '/portal/files', icon: 'files' },
  { id: 'money', label: 'Money', messageKey: 'nav.money', href: '/portal/money', icon: 'receipt' },
  {
    id: 'people',
    label: 'People',
    messageKey: 'nav.people',
    href: '/portal/people',
    icon: 'users',
  },
];
