'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/insights.css';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  INSIGHT_METRIC_KEYS,
  addMetricFavorite,
  listMetricFavorites,
  removeMetricFavorite,
} from '../../lib/api/metric-favorites';
import type { InsightMetricKey } from '../../lib/api/metric-favorites';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface MetricFavoritesViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The message key for each known metric id — the closed vocabulary the API validates against. */
const METRIC_LABEL_KEYS: Readonly<Record<InsightMetricKey, MessageKey>> = {
  'portfolio.projectCount': 'MetricFavoritesView.metricPortfolioProjectCount',
  'portfolio.openItemCount': 'MetricFavoritesView.metricPortfolioOpenItemCount',
  'deliveryFlow.itemCount': 'MetricFavoritesView.metricDeliveryFlowItemCount',
  'approvalCycle.approvalCount': 'MetricFavoritesView.metricApprovalCycleApprovalCount',
  'workload.assigneeCount': 'MetricFavoritesView.metricWorkloadAssigneeCount',
  'workload.openItemCount': 'MetricFavoritesView.metricWorkloadOpenItemCount',
  'workload.scheduledItemCount': 'MetricFavoritesView.metricWorkloadScheduledItemCount',
  'adoption.activeMembers': 'MetricFavoritesView.metricAdoptionActiveMembers',
};

/**
 * **INS metric favorites (module 15, x303).**
 *
 * `22-WHOLE-APP-SCREEN` §Insights — the caller's own starred insight metrics. It reads the caller's
 * favorites (newest first) and shows a star toggle beside every known metric, so a member pins the
 * numbers they watch most to the top. Distinct from the dashboard layout (which orders every tile):
 * this is the small starred subset.
 *
 * ## What it does, and what it cannot
 *
 * - **Favorites are the caller's own.** The API scopes them to the acting membership; there is no view
 *   of another member's favorites.
 * - **Only known metrics can be starred.** The toggle set is the fixed {@link INSIGHT_METRIC_KEYS}
 *   allowlist; the API refuses any key off it (400).
 */
export function MetricFavoritesView({
  organizationSlug,
  organizationName,
  client,
}: MetricFavoritesViewProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const queryClient = useQueryClient();

  const favorites = useQuery({
    queryKey: ['insight-metric-favorites', organizationSlug],
    queryFn: () => listMetricFavorites(api, organizationSlug),
  });

  const starred = new Set((favorites.data ?? []).map((favorite) => favorite.metricKey));

  const toggle = useMutation({
    mutationFn: async (metricKey: InsightMetricKey) => {
      if (starred.has(metricKey)) {
        await removeMetricFavorite(api, organizationSlug, metricKey);
      } else {
        await addMetricFavorite(api, organizationSlug, metricKey);
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['insight-metric-favorites', organizationSlug] }),
  });

  const starredList = (favorites.data ?? []).map((favorite) => favorite.metricKey);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow={t('MetricFavoritesView.eyebrow')}
      title={t('MetricFavoritesView.title')}
      description={t('MetricFavoritesView.description')}
    >
      <div className="tm-ins tm-ins-tool">
        <section className="tm-panel tm-stack" aria-labelledby="tm-metric-favorites-strip">
          <h2 id="tm-metric-favorites-strip" className="tm-eyebrow">
            {t('MetricFavoritesView.yourFavorites')}
          </h2>

          {favorites.isError ? (
            <InlineAlert tone="danger" title={t('MetricFavoritesView.loadError')} live>
              {describeError(favorites.error)}
            </InlineAlert>
          ) : null}

          {favorites.isPending ? (
            <LoadingRegion label={t('MetricFavoritesView.loading')}>
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!favorites.isPending && !favorites.isError ? (
            starredList.length === 0 ? (
              <InlineAlert tone="neutral" title={t('MetricFavoritesView.noFavoritesTitle')}>
                {t('MetricFavoritesView.noFavoritesBody')}
              </InlineAlert>
            ) : (
              <ul className="tm-tag-list">
                {starredList.map((metricKey) => (
                  <li key={metricKey} className="tm-tag">
                    {t(METRIC_LABEL_KEYS[metricKey])}
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </section>

        <section className="tm-panel tm-stack" aria-labelledby="tm-metric-favorites-all">
          <h2 id="tm-metric-favorites-all" className="tm-eyebrow">
            {t('MetricFavoritesView.allMetrics')}
          </h2>

          {toggle.isError ? (
            <InlineAlert tone="danger" title={t('MetricFavoritesView.updateError')} live>
              {describeError(toggle.error)}
            </InlineAlert>
          ) : null}

          <ul className="tm-list">
            {INSIGHT_METRIC_KEYS.map((metricKey) => {
              const isStarred = starred.has(metricKey);
              return (
                <li key={metricKey} className="tm-list__row">
                  <span>{t(METRIC_LABEL_KEYS[metricKey])}</span>
                  <Button
                    type="button"
                    tone={isStarred ? 'ink' : 'outline'}
                    size="accessible"
                    aria-pressed={isStarred}
                    loading={toggle.isPending && toggle.variables === metricKey}
                    loadingLabel={
                      isStarred
                        ? t('MetricFavoritesView.removing')
                        : t('MetricFavoritesView.saving')
                    }
                    disabled={favorites.isPending}
                    onClick={() => toggle.mutate(metricKey)}
                  >
                    {isStarred ? t('MetricFavoritesView.starred') : t('MetricFavoritesView.star')}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
