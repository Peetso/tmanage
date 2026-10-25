'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Announce, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/insights.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import {
  INSIGHT_REPORT_KINDS,
  createInsightSavedView,
  deleteInsightSavedView,
  listInsightSavedViews,
} from '../../lib/api/insight-saved-views';
import type { InsightReportKind, InsightSavedViewView } from '../../lib/api/insight-saved-views';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface SavedInsightViewsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const REPORT_KIND_KEY: Readonly<Record<InsightReportKind, MessageKey>> = {
  portfolio: 'SavedInsightViewsScreen.reportPortfolio',
  'delivery-flow': 'SavedInsightViewsScreen.reportDeliveryFlow',
  'approval-cycle': 'SavedInsightViewsScreen.reportApprovalCycle',
  workload: 'SavedInsightViewsScreen.reportWorkload',
  adoption: 'SavedInsightViewsScreen.reportAdoption',
  forecast: 'SavedInsightViewsScreen.reportForecast',
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
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();
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
      eyebrow={t('SavedInsightViewsScreen.eyebrow')}
      title={t('SavedInsightViewsScreen.title')}
      description={t('SavedInsightViewsScreen.description')}
    >
      <div className="tm-ins tm-ins-tool">
        <section className="tm-panel tm-stack" aria-labelledby="tm-insight-view-editor">
          <h2 id="tm-insight-view-editor" className="tm-eyebrow">
            {t('SavedInsightViewsScreen.newSavedView')}
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
                {t('SavedInsightViewsScreen.nameLabel')}
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
                {t('SavedInsightViewsScreen.report')}
              </label>
              <select
                id="tm-insight-view-report"
                className="tm-field__control"
                value={reportKind}
                onChange={(event) => setReportKind(event.target.value as InsightReportKind)}
              >
                {INSIGHT_REPORT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(REPORT_KIND_KEY[kind])}
                  </option>
                ))}
              </select>
            </div>

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-insight-view-filter-field">
                {t('SavedInsightViewsScreen.filterOptional')}
              </label>
              <div className="tm-row">
                <input
                  id="tm-insight-view-filter-field"
                  className="tm-field__control"
                  value={filterField}
                  placeholder={t('SavedInsightViewsScreen.filterFieldPlaceholder')}
                  onChange={(event) => setFilterField(event.target.value)}
                />
                <input
                  aria-label={t('SavedInsightViewsScreen.filterValueLabel')}
                  className="tm-field__control"
                  value={filterValue}
                  placeholder={t('SavedInsightViewsScreen.filterValuePlaceholder')}
                  onChange={(event) => setFilterValue(event.target.value)}
                />
              </div>
              <span className="tm-field__hint">{t('SavedInsightViewsScreen.filterHint')}</span>
            </div>

            {save.isError ? (
              <InlineAlert tone="danger" title={t('SavedInsightViewsScreen.saveFailed')} live>
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
                loadingLabel={t('SavedInsightViewsScreen.saving')}
              >
                {t('SavedInsightViewsScreen.saveView')}
              </Button>
            </div>
          </form>
        </section>

        <section
          className="tm-panel tm-panel--quiet tm-stack"
          aria-labelledby="tm-insight-view-list"
        >
          <h2 id="tm-insight-view-list" className="tm-eyebrow">
            {t('SavedInsightViewsScreen.yourSavedViews')}
          </h2>

          {savedViews.isError ? (
            <InlineAlert tone="danger" title={t('SavedInsightViewsScreen.loadFailed')} live>
              {describeError(savedViews.error)}
            </InlineAlert>
          ) : null}

          {remove.isError ? (
            <InlineAlert tone="danger" title={t('SavedInsightViewsScreen.removeFailed')} live>
              {describeError(remove.error)}
            </InlineAlert>
          ) : null}

          {savedViews.isPending ? (
            <LoadingRegion label={t('SavedInsightViewsScreen.loading')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!savedViews.isPending && !savedViews.isError && rows.length === 0 ? (
            <InlineAlert tone="neutral" title={t('SavedInsightViewsScreen.emptyTitle')}>
              {t('SavedInsightViewsScreen.emptyBody')}
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
                        {t(REPORT_KIND_KEY[view.reportKind])}
                        {filterEntries.length > 0
                          ? ` · ${filterEntries.map(([key, value]) => `${key}=${value}`).join(', ')}`
                          : t('SavedInsightViewsScreen.noFilter')}
                      </span>
                    </div>
                    <Button
                      tone="outline"
                      size="accessible"
                      loading={remove.isPending && remove.variables === view.id}
                      loadingLabel={t('SavedInsightViewsScreen.removing')}
                      onClick={() => remove.mutate(view.id)}
                    >
                      {t('SavedInsightViewsScreen.remove')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        <Announce message={save.isSuccess ? t('SavedInsightViewsScreen.savedViewStored') : ''} />
      </div>
    </AppShell>
  );
}
