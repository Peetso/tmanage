'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  INSIGHT_METRIC_KEYS,
  getInsightDashboardLayout,
  updateInsightDashboardLayout,
} from '../../lib/api/insight-dashboard-layout';
import type {
  InsightDashboardLayoutView,
  InsightDashboardTileEntry,
  InsightMetricKey,
} from '../../lib/api/insight-dashboard-layout';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface InsightDashboardLayoutScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** Human labels for the fixed insight metric tiles, keyed by the id the API validates against. */
const METRIC_LABELS: Record<InsightMetricKey, string> = {
  portfolio: 'Portfolio roll-up',
  deliveryFlow: 'Delivery flow',
  approvalCycle: 'Approval cycle',
  workload: 'Workload',
  workloadForecast: 'Workload forecast',
  adoption: 'Adoption',
  snapshots: 'Snapshots',
  savedViews: 'Saved views',
};

/**
 * Fold the saved tiles into a full, ordered list of every known metric: the saved tiles by ascending
 * position first (only keys still known, carrying their visibility), then any known metric the saved
 * layout omits, appended visible in the declared order. This keeps a newly added metric visible and
 * appended rather than silently dropped, and never shows a key the server would reject.
 */
function foldTiles(saved: readonly InsightDashboardTileEntry[]): InsightDashboardTileEntry[] {
  const known = new Set<InsightMetricKey>(INSIGHT_METRIC_KEYS);
  const ordered = [...saved]
    .filter((tile) => known.has(tile.key))
    .sort((a, b) => a.position - b.position);
  const seen = new Set<InsightMetricKey>(ordered.map((tile) => tile.key));
  for (const key of INSIGHT_METRIC_KEYS) {
    if (!seen.has(key)) ordered.push({ key, position: ordered.length, visible: true });
  }
  return ordered.map((tile, index) => ({ ...tile, position: index }));
}

/**
 * **Insight dashboard layout (module 16 Insights, x302).**
 *
 * `22-SCREEN` INS insights dashboard; `38-MODULE-MAP` §Insights. The insights surfaces (portfolio,
 * delivery-flow, approval-cycle, workload, adoption, snapshots, saved views) exist but there was no
 * per-user way to arrange or hide them on the dashboard; this is the customise panel that adds it. A
 * member reads their own layout (every metric tile shown, declared order, when never saved), reorders
 * the tiles and hides the ones they do not want, and saves — the layout persists behind `work.read`,
 * scoped to the caller's own membership by the server. Every key is validated against a fixed
 * allowlist on both sides.
 */
export function InsightDashboardLayoutScreen({
  organizationSlug,
  organizationName,
  client,
}: InsightDashboardLayoutScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const layout = useQuery({
    queryKey: ['insight-dashboard-layout', organizationSlug],
    queryFn: () => getInsightDashboardLayout(api, organizationSlug),
  });

  const [tiles, setTiles] = useState<InsightDashboardTileEntry[]>(() => foldTiles([]));
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!layout.data) return;
    setTiles(foldTiles(layout.data.tiles));
  }, [layout.data]);

  const move = (index: number, delta: number): void => {
    const next = [...tiles];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    setTiles(next.map((tile, position) => ({ ...tile, position })));
    setSaved(false);
  };

  const toggleVisible = (index: number, visible: boolean): void => {
    setTiles(tiles.map((tile, i) => (i === index ? { ...tile, visible } : tile)));
    setSaved(false);
  };

  const save = useMutation({
    mutationFn: (): Promise<InsightDashboardLayoutView> =>
      updateInsightDashboardLayout(api, organizationSlug, {
        tiles: tiles.map((tile, position) => ({ ...tile, position })),
      }),
    onSuccess: (result) => {
      queries.setQueryData(['insight-dashboard-layout', organizationSlug], result);
      setSaved(true);
    },
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Customise insights dashboard"
      description="Reorder or hide the metric tiles on your insights dashboard — saved to your account."
    >
      {layout.isPending ? (
        <LoadingRegion label="Loading your dashboard layout">
          <Skeleton />
        </LoadingRegion>
      ) : layout.isError ? (
        <InlineAlert tone="danger" title="We could not load your dashboard layout">
          {errorMessage(layout.error)}
        </InlineAlert>
      ) : (
        <form
          className="tm-panel tm-stack"
          aria-labelledby="tm-insight-layout-heading"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            save.mutate();
          }}
        >
          <h2 id="tm-insight-layout-heading" className="tm-eyebrow">
            Metric tiles
          </h2>

          <ul className="tm-stack" aria-label="Insight metric tiles">
            {tiles.map((tile, index) => (
              <li className="tm-field tm-field--inline" key={tile.key}>
                <span className="tm-field__label">{METRIC_LABELS[tile.key]}</span>
                <Button
                  type="button"
                  tone="outline"
                  disabled={index === 0}
                  aria-label={`Move ${METRIC_LABELS[tile.key]} up`}
                  onClick={() => move(index, -1)}
                >
                  Up
                </Button>
                <Button
                  type="button"
                  tone="outline"
                  disabled={index === tiles.length - 1}
                  aria-label={`Move ${METRIC_LABELS[tile.key]} down`}
                  onClick={() => move(index, 1)}
                >
                  Down
                </Button>
                <input
                  id={`tm-insight-tile-visible-${tile.key}`}
                  className="tm-field__control"
                  type="checkbox"
                  checked={tile.visible}
                  onChange={(event) => toggleVisible(index, event.target.checked)}
                />
                <label className="tm-field__label" htmlFor={`tm-insight-tile-visible-${tile.key}`}>
                  Show
                </label>
              </li>
            ))}
          </ul>

          {save.isError ? (
            <InlineAlert tone="danger" title="We could not save your dashboard layout">
              {errorMessage(save.error)}
            </InlineAlert>
          ) : null}

          {saved && !save.isPending && !save.isError ? (
            <InlineAlert tone="success" title="Saved">
              Your insights dashboard layout has been saved.
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
