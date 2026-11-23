import { HOME_WIDGET_IDS } from '../../lib/api/home-widget-prefs';
import type { HomeWidgetId, HomeWidgetPrefsView } from '../../lib/api/home-widget-prefs';

/**
 * **My Day v4 widget layout** (spec MYDAY-V4-MERGE-SPEC §3.2, §8.3). The old page with its parts
 * placed by priority: a fixed top (the day bar, the three numbers and "Do this next", in that
 * place always, so nothing ever stands between the header and the next action), then two columns.
 * Main: Due & at risk, the two Waiting lists, the business briefing, personal work by project.
 * Side, under the context lens: Timer, Saved, Pinned, Recently viewed, Getting started and the
 * pricing question. A widget moves inside its own column only, so the saved order is one flat
 * list read column by column (Edit widgets, `HomeWidgetPrefsScreen`).
 *
 * The ids are the server's allowlist (`home_widget_prefs`, migration 0115); no id is added. The
 * one `waiting` id holds both Waiting lists, on you and on others, so they always read as a pair.
 */
export const LAYOUT_GROUPS = ['top', 'main', 'side'] as const;
export type LayoutGroup = (typeof LAYOUT_GROUPS)[number];

export const DEFAULT_LAYOUT: Readonly<Record<LayoutGroup, readonly HomeWidgetId[]>> = {
  top: ['pulse', 'summary', 'next'],
  main: ['myDay', 'waiting', 'businessBriefing', 'byProject'],
  side: ['timer', 'savedContext', 'pins', 'recent', 'gettingStarted', 'quickQuestion'],
};

/** "Do this next" is the page's anchor: it is never hidden (spec §3.2 rank 1). */
export const ALWAYS_SHOWN: ReadonlySet<HomeWidgetId> = new Set<HomeWidgetId>(['next', 'pulse']);

/** The top parts keep their places (spec §4.2 rule 1); only the two columns can be re-ordered. */
export function movable(group: LayoutGroup): boolean {
  return group !== 'top';
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
  if (!group || !movable(group)) return layout;
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
