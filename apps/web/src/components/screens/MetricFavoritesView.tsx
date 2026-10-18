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
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface MetricFavoritesViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The human label for each known metric id — the closed vocabulary the API validates against. */
const METRIC_LABELS: Readonly<Record<InsightMetricKey, string>> = {
  'portfolio.projectCount': 'Projects in portfolio',
  'portfolio.openItemCount': 'Open work items (portfolio)',
  'deliveryFlow.itemCount': 'Delivery-flow items',
  'approvalCycle.approvalCount': 'Approvals in cycle',
  'workload.assigneeCount': 'People with workload',
  'workload.openItemCount': 'Open work items (workload)',
  'workload.scheduledItemCount': 'Scheduled work items',
  'adoption.activeMembers': 'Active members',
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
  const api = client ?? browserApiClient();
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
      eyebrow="Insights"
      title="Favorite metrics"
      description="Star the insight metrics you watch most. Starred metrics surface first; only you see your favorites."
    >
      <div className="tm-ins tm-ins-tool">
        <section className="tm-panel tm-stack" aria-labelledby="tm-metric-favorites-strip">
          <h2 id="tm-metric-favorites-strip" className="tm-eyebrow">
            Your favorites
          </h2>

          {favorites.isError ? (
            <InlineAlert tone="danger" title="Could not load your favorite metrics" live>
              {describeError(favorites.error)}
            </InlineAlert>
          ) : null}

          {favorites.isPending ? (
            <LoadingRegion label="Loading your favorite metrics.">
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!favorites.isPending && !favorites.isError ? (
            starredList.length === 0 ? (
              <InlineAlert tone="neutral" title="No favorites yet">
                Star a metric below to pin it here.
              </InlineAlert>
            ) : (
              <ul className="tm-tag-list">
                {starredList.map((metricKey) => (
                  <li key={metricKey} className="tm-tag">
                    {METRIC_LABELS[metricKey]}
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </section>

        <section className="tm-panel tm-stack" aria-labelledby="tm-metric-favorites-all">
          <h2 id="tm-metric-favorites-all" className="tm-eyebrow">
            All metrics
          </h2>

          {toggle.isError ? (
            <InlineAlert tone="danger" title="Could not update the favorite" live>
              {describeError(toggle.error)}
            </InlineAlert>
          ) : null}

          <ul className="tm-list">
            {INSIGHT_METRIC_KEYS.map((metricKey) => {
              const isStarred = starred.has(metricKey);
              return (
                <li key={metricKey} className="tm-list__row">
                  <span>{METRIC_LABELS[metricKey]}</span>
                  <Button
                    type="button"
                    tone={isStarred ? 'ink' : 'outline'}
                    size="accessible"
                    aria-pressed={isStarred}
                    loading={toggle.isPending && toggle.variables === metricKey}
                    loadingLabel={isStarred ? 'Removing' : 'Saving'}
                    disabled={favorites.isPending}
                    onClick={() => toggle.mutate(metricKey)}
                  >
                    {isStarred ? 'Starred' : 'Star'}
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

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
