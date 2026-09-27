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
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface HomeWidgetPrefsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** Human labels for the fixed Home widgets, keyed by the id the API validates against. */
const WIDGET_LABELS: Record<HomeWidgetId, string> = {
  myDay: 'My Day',
  waiting: 'Waiting on others',
  pulse: 'Pulse',
  summary: 'Summary',
  pins: 'Pinned items',
  savedContext: 'Saved context',
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
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const prefs = useQuery({
    queryKey: ['home-widget-prefs', organizationSlug],
    queryFn: () => getHomeWidgetPrefs(api, organizationSlug),
  });

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
      title="Customise Home"
      description="Reorder or hide the widgets on your Home — saved to your account."
    >
      {prefs.isPending ? (
        <LoadingRegion label="Loading your Home layout">
          <Skeleton />
        </LoadingRegion>
      ) : prefs.isError ? (
        <InlineAlert tone="danger" title="We could not load your Home layout">
          {errorMessage(prefs.error)}
        </InlineAlert>
      ) : (
        <form
          className="tm-panel tm-stack"
          aria-labelledby="tm-widget-prefs-heading"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            save.mutate();
          }}
        >
          <h2 id="tm-widget-prefs-heading" className="tm-eyebrow">
            Home widgets
          </h2>

          <ul className="tm-stack" aria-label="Home widgets">
            {order.map((id, index) => (
              <li className="tm-field tm-field--inline" key={id}>
                <span className="tm-field__label">{WIDGET_LABELS[id]}</span>
                <Button
                  type="button"
                  tone="outline"
                  disabled={index === 0}
                  aria-label={`Move ${WIDGET_LABELS[id]} up`}
                  onClick={() => move(index, -1)}
                >
                  Up
                </Button>
                <Button
                  type="button"
                  tone="outline"
                  disabled={index === order.length - 1}
                  aria-label={`Move ${WIDGET_LABELS[id]} down`}
                  onClick={() => move(index, 1)}
                >
                  Down
                </Button>
                <input
                  id={`tm-widget-visible-${id}`}
                  className="tm-field__control"
                  type="checkbox"
                  checked={!hidden.has(id)}
                  onChange={(event) => toggleHidden(id, !event.target.checked)}
                />
                <label className="tm-field__label" htmlFor={`tm-widget-visible-${id}`}>
                  Show
                </label>
              </li>
            ))}
          </ul>

          {save.isError ? (
            <InlineAlert tone="danger" title="We could not save your Home layout">
              {errorMessage(save.error)}
            </InlineAlert>
          ) : null}

          {saved && !save.isPending && !save.isError ? (
            <InlineAlert tone="success" title="Saved">
              Your Home layout has been saved.
            </InlineAlert>
          ) : null}

          <div>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save layout'}
            </Button>
          </div>
        </form>
      )}
    </AppShell>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
