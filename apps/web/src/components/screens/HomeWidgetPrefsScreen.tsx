'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  HOME_WIDGET_IDS,
  getHomeWidgetPrefs,
  updateHomeWidgetPrefs,
} from '../../lib/api/home-widget-prefs';
import type { HomeWidgetId, HomeWidgetPrefsView } from '../../lib/api/home-widget-prefs';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { getHomeBriefing, hasBriefing, homeBriefingQueryKey } from '../../lib/api/home-briefing';

export interface HomeWidgetPrefsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * The name of each fixed Home widget, keyed by the id the API validates against: its message key,
 * and the English `tOr` shows until a newer key reaches the catalogs (the briefing, B11 WIRING).
 */
const WIDGET_LABELS: Readonly<
  Record<HomeWidgetId, { readonly key: string; readonly english: string }>
> = {
  myDay: { key: 'HomeWidgetPrefsScreen.widgetMyDay', english: 'My Day' },
  waiting: { key: 'HomeWidgetPrefsScreen.widgetWaiting', english: 'Waiting on others' },
  pulse: { key: 'HomeWidgetPrefsScreen.widgetPulse', english: 'Pulse' },
  summary: { key: 'HomeWidgetPrefsScreen.widgetSummary', english: 'Summary' },
  pins: { key: 'HomeWidgetPrefsScreen.widgetPins', english: 'Pinned items' },
  savedContext: { key: 'HomeWidgetPrefsScreen.widgetSavedContext', english: 'Saved context' },
  businessBriefing: {
    key: 'HomeWidgetPrefsScreen.widgetBusinessBriefing',
    english: 'Business briefing',
  },
  next: { key: 'MyDay.w.next', english: 'Next' },
  byProject: { key: 'MyDay.w.byProject', english: 'By project' },
  timer: { key: 'MyDay.w.timer', english: 'Timer' },
  gettingStarted: { key: 'MyDay.w.gettingStarted', english: 'Getting started' },
  quickQuestion: { key: 'MyDay.w.quickQuestion', english: 'Quick question' },
  recent: { key: 'MyDay.w.recent', english: 'Recent' },
};

/**
 * Fold the saved layout into a full, ordered list of every known widget: the saved order first (only
 * ids still known), then any known widget the saved order omits, in the declared order. This keeps a
 * newly added widget visible and appended rather than silently dropped, and never shows an id the
 * server would reject.
 */
function foldOrder(saved: readonly HomeWidgetId[]): HomeWidgetId[] {
  const known = new Set<HomeWidgetId>(HOME_WIDGET_IDS);
  const ordered = saved.filter((id) => known.has(id));
  const seen = new Set<HomeWidgetId>(ordered);
  for (const id of HOME_WIDGET_IDS) {
    if (!seen.has(id)) ordered.push(id);
  }
  return ordered;
}

/**
 * **Home widget preferences (module 4 Home / My Day, x243).**
 *
 * `38-MODULE-MAP` §Home / My Day. The Home surfaces (pulse, My Day, waiting, pins) exist but there
 * was no per-user way to arrange or hide them; this is the customise panel that adds it. A member
 * reads their own layout (every widget shown, declared order, when never saved), reorders the widgets
 * and hides the ones they do not want, and saves — the layout persists behind `work.read`, scoped to
 * the caller's own membership by the server. Every id is validated against a fixed allowlist on both
 * sides, and the order is de-duplicated by the server.
 */
export function HomeWidgetPrefsScreen({
  organizationSlug,
  organizationName,
  client,
}: HomeWidgetPrefsScreenProps) {
  const errorMessage = useDescribeApiError(OFFLINE_LINES);
  const t = useT();
  const tOr = useTOr();
  const label = (id: HomeWidgetId): string => tOr(WIDGET_LABELS[id].key, WIDGET_LABELS[id].english);
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const prefs = useQuery({
    queryKey: ['home-widget-prefs', organizationSlug],
    queryFn: () => getHomeWidgetPrefs(api, organizationSlug),
  });
  // The briefing row is offered only to someone who has a briefing (fix 18: "Show business
  // briefing" brings it back); its saved state is kept either way.
  const briefing = useQuery({
    queryKey: homeBriefingQueryKey(organizationSlug),
    queryFn: () => getHomeBriefing(api, organizationSlug),
  });
  const offered = (id: HomeWidgetId): boolean =>
    id !== 'businessBriefing' || hasBriefing(briefing.data);

  const [order, setOrder] = useState<HomeWidgetId[]>(() => foldOrder([]));
  const [hidden, setHidden] = useState<ReadonlySet<HomeWidgetId>>(new Set());
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!prefs.data) return;
    setOrder(foldOrder(prefs.data.order));
    setHidden(new Set(prefs.data.hidden.filter((id) => HOME_WIDGET_IDS.includes(id))));
  }, [prefs.data]);

  const move = (index: number, delta: number): void => {
    const next = [...order];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    setOrder(next);
    setSaved(false);
  };

  const toggleHidden = (id: HomeWidgetId, hide: boolean): void => {
    const next = new Set(hidden);
    if (hide) next.add(id);
    else next.delete(id);
    setHidden(next);
    setSaved(false);
  };

  const save = useMutation({
    mutationFn: (): Promise<HomeWidgetPrefsView> =>
      updateHomeWidgetPrefs(api, organizationSlug, {
        order,
        hidden: order.filter((id) => hidden.has(id)),
      }),
    onSuccess: (result) => {
      queries.setQueryData(['home-widget-prefs', organizationSlug], result);
      setSaved(true);
    },
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={t('HomeWidgetPrefsScreen.title')}
      description={t('HomeWidgetPrefsScreen.description')}
    >
      {prefs.isPending ? (
        <LoadingRegion label={t('HomeWidgetPrefsScreen.loading')}>
          <Skeleton />
        </LoadingRegion>
      ) : prefs.isError ? (
        <InlineAlert tone="danger" title={t('HomeWidgetPrefsScreen.loadErrorTitle')}>
          {errorMessage(prefs.error)}
        </InlineAlert>
      ) : (
        <form
          noValidate
          className="tm-panel tm-stack"
          aria-labelledby="tm-widget-prefs-heading"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            save.mutate();
          }}
        >
          <h2 id="tm-widget-prefs-heading" className="tm-eyebrow">
            {t('HomeWidgetPrefsScreen.widgetsHeading')}
          </h2>

          <ul className="tm-stack" aria-label={t('HomeWidgetPrefsScreen.widgetsListLabel')}>
            {order.map((id, index) =>
              offered(id) ? (
                <li className="tm-field tm-field--inline" key={id}>
                  <span className="tm-field__label">{label(id)}</span>
                  <Button
                    type="button"
                    tone="outline"
                    disabled={index === 0}
                    aria-label={`${t('HomeWidgetPrefsScreen.moveLabel')} ${label(id)} ${t('HomeWidgetPrefsScreen.upSuffix')}`}
                    onClick={() => move(index, -1)}
                  >
                    {t('HomeWidgetPrefsScreen.up')}
                  </Button>
                  <Button
                    type="button"
                    tone="outline"
                    disabled={index === order.length - 1}
                    aria-label={`${t('HomeWidgetPrefsScreen.moveLabel')} ${label(id)} ${t('HomeWidgetPrefsScreen.downSuffix')}`}
                    onClick={() => move(index, 1)}
                  >
                    {t('HomeWidgetPrefsScreen.down')}
                  </Button>
                  <input
                    id={`tm-widget-visible-${id}`}
                    className="tm-field__control"
                    type="checkbox"
                    checked={!hidden.has(id)}
                    onChange={(event) => toggleHidden(id, !event.target.checked)}
                  />
                  <label className="tm-field__label" htmlFor={`tm-widget-visible-${id}`}>
                    {t('HomeWidgetPrefsScreen.show')}
                  </label>
                </li>
              ) : null,
            )}
          </ul>

          {save.isError ? (
            <InlineAlert tone="danger" title={t('HomeWidgetPrefsScreen.saveErrorTitle')}>
              {errorMessage(save.error)}
            </InlineAlert>
          ) : null}

          {saved && !save.isPending && !save.isError ? (
            <InlineAlert tone="success" title={t('HomeWidgetPrefsScreen.savedTitle')}>
              {t('HomeWidgetPrefsScreen.savedBody')}
            </InlineAlert>
          ) : null}

          <div>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending
                ? t('HomeWidgetPrefsScreen.saving')
                : t('HomeWidgetPrefsScreen.saveButton')}
            </Button>
          </div>
        </form>
      )}
    </AppShell>
  );
}
