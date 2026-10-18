'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Announce, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/insights.css';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  INSIGHT_REPORT_KINDS,
  createInsightSavedView,
  deleteInsightSavedView,
  listInsightSavedViews,
} from '../../lib/api/insight-saved-views';
import type { InsightReportKind, InsightSavedViewView } from '../../lib/api/insight-saved-views';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface SavedInsightViewsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const REPORT_KIND_LABELS: Readonly<Record<InsightReportKind, string>> = {
  portfolio: 'Portfolio',
  'delivery-flow': 'Delivery flow',
  'approval-cycle': 'Approval cycle',
  workload: 'Workload',
  adoption: 'Adoption',
  forecast: 'Forecast',
};

/**
 * **Saved insight views** (module 15, x210).
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Insights & reporting: the insights reads exist, but a
 * person cannot name and re-open a report configuration. This screen is that editor — a form to name
 * and save a view (a report kind plus an optional single filter), the list of the caller's own views,
 * and a "Remove" action.
 *
 * The decisions are the sibling insights screens':
 * 1. **Authorization is the API's.** All routes sit behind `work.read`; a caller without it sees the
 *    API's 403 turned into a sentence in the panel's alert, never a blank page.
 * 2. **Private to the owner.** The list is only ever the caller's own views (the API scopes by owner),
 *    and a removed view is one the caller owns — an id that is not the caller's answers 404.
 * 3. **The view is the configuration, echoed back.** `filters` is stored whole and read back to drive
 *    the existing insights reads; applying a view is the client's step, so the list shows the config
 *    rather than a live grid.
 */
export function SavedInsightViewsScreen({
  organizationSlug,
  organizationName,
  client,
}: SavedInsightViewsScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const listKey = ['insight-saved-views', organizationSlug] as const;

  const [name, setName] = useState('');
  const [reportKind, setReportKind] = useState<InsightReportKind>('portfolio');
  const [filterField, setFilterField] = useState('');
  const [filterValue, setFilterValue] = useState('');

  const savedViews = useQuery({
    queryKey: listKey,
    queryFn: () => listInsightSavedViews(api, organizationSlug),
  });

  const save = useMutation({
    mutationFn: (): Promise<InsightSavedViewView> => {
      const filters = filterField.trim() === '' ? {} : { [filterField.trim()]: filterValue.trim() };
      return createInsightSavedView(api, organizationSlug, {
        name: name.trim(),
        reportKind,
        filters,
      });
    },
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: listKey });
      setName('');
      setFilterField('');
      setFilterValue('');
    },
  });

  const remove = useMutation({
    mutationFn: (viewId: string) => deleteInsightSavedView(api, organizationSlug, viewId),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: listKey });
    },
  });

  const rows = savedViews.data ?? [];
  const canSave = name.trim() !== '' && !save.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow="Insights"
      title="Saved insight views"
      description="Name and re-open an insights report with the filters you use most."
    >
      <div className="tm-ins tm-ins-tool">
        <section className="tm-panel tm-stack" aria-labelledby="tm-insight-view-editor">
          <h2 id="tm-insight-view-editor" className="tm-eyebrow">
            New saved view
          </h2>

          <form
            className="tm-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave) save.mutate();
            }}
          >
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-insight-view-name">
                Name
              </label>
              <input
                id="tm-insight-view-name"
                className="tm-field__control"
                value={name}
                maxLength={300}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-insight-view-report">
                Report
              </label>
              <select
                id="tm-insight-view-report"
                className="tm-field__control"
                value={reportKind}
                onChange={(event) => setReportKind(event.target.value as InsightReportKind)}
              >
                {INSIGHT_REPORT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {REPORT_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </div>

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-insight-view-filter-field">
                Filter (optional)
              </label>
              <div className="tm-row">
                <input
                  id="tm-insight-view-filter-field"
                  className="tm-field__control"
                  value={filterField}
                  placeholder="Field — e.g. projectId"
                  onChange={(event) => setFilterField(event.target.value)}
                />
                <input
                  aria-label="Filter value"
                  className="tm-field__control"
                  value={filterValue}
                  placeholder="Value"
                  onChange={(event) => setFilterValue(event.target.value)}
                />
              </div>
              <span className="tm-field__hint">
                One field and value to pin the report to. Leave blank for no filter.
              </span>
            </div>

            {save.isError ? (
              <InlineAlert tone="danger" title="Could not save the view" live>
                {describeError(save.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                disabled={!canSave}
                loading={save.isPending}
                loadingLabel="Saving"
              >
                Save view
              </Button>
            </div>
          </form>
        </section>

        <section
          className="tm-panel tm-panel--quiet tm-stack"
          aria-labelledby="tm-insight-view-list"
        >
          <h2 id="tm-insight-view-list" className="tm-eyebrow">
            Your saved views
          </h2>

          {savedViews.isError ? (
            <InlineAlert tone="danger" title="Could not load your saved views" live>
              {describeError(savedViews.error)}
            </InlineAlert>
          ) : null}

          {remove.isError ? (
            <InlineAlert tone="danger" title="Could not remove the view" live>
              {describeError(remove.error)}
            </InlineAlert>
          ) : null}

          {savedViews.isPending ? (
            <LoadingRegion label="Loading your saved views.">
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!savedViews.isPending && !savedViews.isError && rows.length === 0 ? (
            <InlineAlert tone="neutral" title="No saved views yet">
              Save a report configuration above and it will appear here for you to re-open.
            </InlineAlert>
          ) : null}

          {rows.length > 0 ? (
            <ul className="tm-list tm-stack">
              {rows.map((view) => {
                const filterEntries = Object.entries(view.filters);
                return (
                  <li key={view.id} className="tm-row tm-row--wrap">
                    <div className="tm-stack tm-stack--tight">
                      <strong>{view.name}</strong>
                      <span className="tm-field__hint">
                        {REPORT_KIND_LABELS[view.reportKind]}
                        {filterEntries.length > 0
                          ? ` · ${filterEntries.map(([key, value]) => `${key}=${value}`).join(', ')}`
                          : ' · No filter'}
                      </span>
                    </div>
                    <Button
                      tone="outline"
                      size="accessible"
                      loading={remove.isPending && remove.variables === view.id}
                      loadingLabel="Removing"
                      onClick={() => remove.mutate(view.id)}
                    >
                      Remove
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        <Announce message={save.isSuccess ? 'Saved view stored.' : ''} />
      </div>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
