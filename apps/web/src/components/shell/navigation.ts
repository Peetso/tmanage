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

export interface NavigationItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly glyph: string;
}

/**
 * The internal orbital rail. Order is the export's, top to bottom. Labels and glyphs follow
 * HOME-01: Home is "My Day" there, and the glyphs are the rail's own (◉ ✉ ◌ ▤ ◫ ◔).
 */
export const INTERNAL_NAVIGATION: readonly NavigationItem[] = [
  { id: 'home', label: 'My Day', href: '/home', glyph: '◉' },
  { id: 'inbox', label: 'Inbox', href: '/inbox', glyph: '✉' },
  { id: 'chat', label: 'Chat', href: '/chat', glyph: '◌' },
  { id: 'work', label: 'Work', href: '/work', glyph: '▤' },
  { id: 'calendar', label: 'Calendar', href: '/calendar', glyph: '◷' },
  { id: 'docs', label: 'Docs', href: '/docs', glyph: '◫' },
  { id: 'people', label: 'People', href: '/people', glyph: '◎' },
  { id: 'insights', label: 'Insights', href: '/insights', glyph: '◔' },
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
  href: '/admin',
  glyph: '⚙',
};

/**
 * The mobile primary navigation — Module 23's "five-item primary navigation", the bottom
 * dock shown below ~768px in place of the orbital rail.
 *
 * It is not a new navigation: every id here is an `INTERNAL_NAVIGATION` id, so the dock
 * invents no route the rail does not already own and the slug-prefixing is identical.
 * Exactly five, because `22-SCREEN-BY-SCREEN` §1 asks for a five-item bottom bar and the
 * eight-wide rail does not reduce to a phone without either shrinking every target below the
 * comfortable minimum or hiding destinations behind a "More" disclosure the existing dock
 * deliberately refused (see the reflow note in `globals.css`).
 *
 * The first four — Home, Inbox, Chat, Work — are the ones `02-mobile-primary-nav` names. The
 * fifth is the single swappable slot: it is `calendar` today (the next rail destination), and
 * is the slot a later slice would reassign (e.g. to a Quick Capture destination) the day such
 * a destination joins `INTERNAL_NAVIGATION`. It is listed by id rather than sliced so the
 * choice is explicit and the "each id is a real rail destination" test has something to read.
 */
export const MOBILE_PRIMARY_NAVIGATION_IDS = ['home', 'inbox', 'chat', 'work', 'calendar'] as const;

export const MOBILE_PRIMARY_NAVIGATION: readonly NavigationItem[] =
  MOBILE_PRIMARY_NAVIGATION_IDS.map((id) => {
    const item = INTERNAL_NAVIGATION.find((candidate) => candidate.id === id);
    if (!item) {
      // A build-time guarantee: the dock can only ever point where the rail already does.
      throw new Error(`MOBILE_PRIMARY_NAVIGATION references unknown internal destination "${id}"`);
    }
    return item;
  });

/** The client portal. A separate space, not a filtered view of the one above. */
export const CLIENT_NAVIGATION: readonly NavigationItem[] = [
  { id: 'overview', label: 'Overview', href: '/portal', glyph: '◉' },
  { id: 'actions', label: 'My Actions', href: '/portal/actions', glyph: '◍' },
  { id: 'deliverables', label: 'Deliverables', href: '/portal/deliverables', glyph: '▦' },
  { id: 'timeline', label: 'Timeline', href: '/portal/timeline', glyph: '▥' },
  { id: 'updates', label: 'Updates', href: '/portal/updates', glyph: '▤' },
  { id: 'risks', label: 'Risks', href: '/portal/risks', glyph: '◭' },
  { id: 'files', label: 'Files', href: '/portal/files', glyph: '▧' },
  { id: 'people', label: 'People', href: '/portal/people', glyph: '◎' },
];
