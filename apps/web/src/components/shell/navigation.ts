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
 */

export interface NavigationItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly glyph: string;
}

/** The internal orbital rail. Order is the export's, top to bottom. */
export const INTERNAL_NAVIGATION: readonly NavigationItem[] = [
  { id: 'home', label: 'Home', href: '/home', glyph: '◉' },
  { id: 'inbox', label: 'Inbox', href: '/inbox', glyph: '▤' },
  { id: 'chat', label: 'Chat', href: '/chat', glyph: '◍' },
  { id: 'work', label: 'Work', href: '/work', glyph: '▦' },
  { id: 'calendar', label: 'Calendar', href: '/calendar', glyph: '▥' },
  { id: 'docs', label: 'Docs', href: '/docs', glyph: '▧' },
  { id: 'people', label: 'People', href: '/people', glyph: '◎' },
  { id: 'insights', label: 'Insights', href: '/insights', glyph: '◈' },
];

/** The client portal. A separate space, not a filtered view of the one above. */
export const CLIENT_NAVIGATION: readonly NavigationItem[] = [
  { id: 'overview', label: 'Overview', href: '/portal', glyph: '◉' },
  { id: 'actions', label: 'My Actions', href: '/portal/actions', glyph: '◍' },
  { id: 'deliverables', label: 'Deliverables', href: '/portal/deliverables', glyph: '▦' },
  { id: 'timeline', label: 'Timeline', href: '/portal/timeline', glyph: '▥' },
  { id: 'updates', label: 'Updates', href: '/portal/updates', glyph: '▤' },
  { id: 'files', label: 'Files', href: '/portal/files', glyph: '▧' },
  { id: 'people', label: 'People', href: '/portal/people', glyph: '◎' },
];
