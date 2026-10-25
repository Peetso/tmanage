'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/insights.css';
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
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

export interface InsightDashboardLayoutScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** Message keys for the fixed insight metric tiles, keyed by the id the API validates against. */
const METRIC_LABELS: Record<InsightMetricKey, MessageKey> = {
  portfolio: 'InsightDashboardLayoutScreen.metricPortfolio',
  deliveryFlow: 'InsightDashboardLayoutScreen.metricDeliveryFlow',
  approvalCycle: 'InsightDashboardLayoutScreen.metricApprovalCycle',
  workload: 'InsightDashboardLayoutScreen.metricWorkload',
  workloadForecast: 'InsightDashboardLayoutScreen.metricWorkloadForecast',
  adoption: 'InsightDashboardLayoutScreen.metricAdoption',
  snapshots: 'InsightDashboardLayoutScreen.metricSnapshots',
  savedViews: 'InsightDashboardLayoutScreen.metricSavedViews',
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
  const errorMessage = useDescribeApiError(OFFLINE_LINES);
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();

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
      eyebrow={t('InsightDashboardLayoutScreen.eyebrow')}
      title={t('InsightDashboardLayoutScreen.title')}
      description={t('InsightDashboardLayoutScreen.description')}
    >
      <div className="tm-ins tm-ins-tool">
        {layout.isPending ? (
          <LoadingRegion label={t('InsightDashboardLayoutScreen.loading')}>
            <Skeleton />
          </LoadingRegion>
        ) : layout.isError ? (
          <InlineAlert tone="danger" title={t('InsightDashboardLayoutScreen.loadErrorTitle')}>
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
              {t('InsightDashboardLayoutScreen.metricTiles')}
            </h2>

            <ul className="tm-stack" aria-label={t('InsightDashboardLayoutScreen.tilesListLabel')}>
              {tiles.map((tile, index) => (
                <li className="tm-field tm-field--inline" key={tile.key}>
                  <span className="tm-field__label">{t(METRIC_LABELS[tile.key])}</span>
                  <Button
                    type="button"
                    tone="outline"
                    disabled={index === 0}
                    aria-label={`${t('InsightDashboardLayoutScreen.move')} ${t(METRIC_LABELS[tile.key])} ${t('InsightDashboardLayoutScreen.directionUp')}`}
                    onClick={() => move(index, -1)}
                  >
                    {t('InsightDashboardLayoutScreen.up')}
                  </Button>
                  <Button
                    type="button"
                    tone="outline"
                    disabled={index === tiles.length - 1}
                    aria-label={`${t('InsightDashboardLayoutScreen.move')} ${t(METRIC_LABELS[tile.key])} ${t('InsightDashboardLayoutScreen.directionDown')}`}
                    onClick={() => move(index, 1)}
                  >
                    {t('InsightDashboardLayoutScreen.down')}
                  </Button>
                  <input
                    id={`tm-insight-tile-visible-${tile.key}`}
                    className="tm-field__control"
                    type="checkbox"
                    checked={tile.visible}
                    onChange={(event) => toggleVisible(index, event.target.checked)}
                  />
                  <label
                    className="tm-field__label"
                    htmlFor={`tm-insight-tile-visible-${tile.key}`}
                  >
                    {t('InsightDashboardLayoutScreen.show')}
                  </label>
                </li>
              ))}
            </ul>

            {save.isError ? (
              <InlineAlert tone="danger" title={t('InsightDashboardLayoutScreen.saveErrorTitle')}>
                {errorMessage(save.error)}
              </InlineAlert>
            ) : null}

            {saved && !save.isPending && !save.isError ? (
              <InlineAlert tone="success" title={t('InsightDashboardLayoutScreen.savedTitle')}>
                {t('InsightDashboardLayoutScreen.savedBody')}
              </InlineAlert>
            ) : null}

            <div>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending
                  ? t('InsightDashboardLayoutScreen.saving')
                  : t('InsightDashboardLayoutScreen.saveLayout')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </AppShell>
  );
}
