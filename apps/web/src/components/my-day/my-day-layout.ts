import { HOME_WIDGET_IDS } from '../../lib/api/home-widget-prefs';
import type { HomeWidgetId, HomeWidgetPrefsView } from '../../lib/api/home-widget-prefs';

/**
 * **My Day v3.1 widget layout** (Fable review F1, F6, ruling (c)). The page is a full-width Today
 * row, two independent stacks (Main: 8 columns, Side: 4 columns) and a full-width bottom row. A
 * widget moves inside its own group only, so the saved order is one flat list read group by group.
 *
 * The ids are the server's allowlist (`home_widget_prefs`, migration 0115). The pre-v3 ids are
 * kept for the widget that took their place, so a person who hid something before keeps it hidden:
 * `pulse` → Today, `myDay` → Due & at risk, `summary` → At a glance, `savedContext` → Saved,
 * `pins` → Pinned, `businessBriefing` → Briefing.
 */
export const LAYOUT_GROUPS = ['top', 'main', 'side', 'bottom'] as const;
export type LayoutGroup = (typeof LAYOUT_GROUPS)[number];

export const DEFAULT_LAYOUT: Readonly<Record<LayoutGroup, readonly HomeWidgetId[]>> = {
  top: ['pulse'],
  main: ['next', 'myDay', 'byProject', 'businessBriefing'],
  side: ['summary', 'waiting', 'timer', 'gettingStarted', 'quickQuestion'],
  bottom: ['savedContext', 'pins', 'recent'],
};

/** Next is the page's anchor: it can move inside Main but never be hidden (spec rule 10). */
export const ALWAYS_SHOWN: ReadonlySet<HomeWidgetId> = new Set<HomeWidgetId>(['next']);

/** Today is alone in its group: its arrows would never work, so they are not drawn (ruling c). */
export function movable(group: LayoutGroup): boolean {
  return DEFAULT_LAYOUT[group].length > 1;
}

export interface MyDayLayout {
  readonly groups: Readonly<Record<LayoutGroup, readonly HomeWidgetId[]>>;
  readonly hidden: ReadonlySet<HomeWidgetId>;
}

const GROUP_OF = new Map<HomeWidgetId, LayoutGroup>(
  LAYOUT_GROUPS.flatMap((group) => DEFAULT_LAYOUT[group].map((id) => [id, group] as const)),
);

/**
 * Fold a saved layout into every group: the saved order first (known ids only), then any widget
 * the saved order lacks, in the default order. A widget added later is shown, never dropped.
 */
export function foldLayout(saved: HomeWidgetPrefsView | undefined): MyDayLayout {
  const known = new Set<string>(HOME_WIDGET_IDS);
  const order = (saved?.order ?? []).filter((id) => known.has(id));
  const groups = {} as Record<LayoutGroup, HomeWidgetId[]>;
  for (const group of LAYOUT_GROUPS) {
    const own = order.filter((id) => GROUP_OF.get(id) === group);
    const seen = new Set(own);
    groups[group] = [...own, ...DEFAULT_LAYOUT[group].filter((id) => !seen.has(id))];
  }
  const hidden = new Set<HomeWidgetId>(
    (saved?.hidden ?? []).filter((id) => known.has(id) && !ALWAYS_SHOWN.has(id)),
  );
  return { groups, hidden };
}

/** The layout as the API stores it: one flat order, group by group, and the hidden ids. */
export function toPrefs(layout: MyDayLayout): HomeWidgetPrefsView {
  return {
    order: LAYOUT_GROUPS.flatMap((group) => layout.groups[group]),
    hidden: [...layout.hidden],
  };
}

/** Move a widget one place up (−1) or down (+1) inside its group; a no-op at either end. */
export function moveWidget(layout: MyDayLayout, id: HomeWidgetId, delta: -1 | 1): MyDayLayout {
  const group = GROUP_OF.get(id);
  if (!group) return layout;
  const list = [...layout.groups[group]];
  const from = list.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return layout;
  list.splice(from, 1);
  list.splice(to, 0, id);
  return { ...layout, groups: { ...layout.groups, [group]: list } };
}

export function setHidden(layout: MyDayLayout, id: HomeWidgetId, hide: boolean): MyDayLayout {
  if (ALWAYS_SHOWN.has(id)) return layout;
  const hidden = new Set(layout.hidden);
  if (hide) hidden.add(id);
  else hidden.delete(id);
  return { ...layout, hidden };
}

export const RESET_LAYOUT: MyDayLayout = foldLayout(undefined);
