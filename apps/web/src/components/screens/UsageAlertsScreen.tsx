'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createUsageAlert,
  listUsageAlerts,
  readUsageAlertStatus,
  type UsageAlertMetric,
} from '../../lib/api/billing';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import '../../styles/screens/billing.css';

export interface UsageAlertsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const METRICS = ['seats', 'storage', 'api'] as const satisfies readonly UsageAlertMetric[];

/** Turn `storage` into `Storage` for the option labels. */
function humanize(metric: string): string {
  return metric.charAt(0).toUpperCase() + metric.slice(1);
}

/**
 * **Billing & entitlements (module 19, x200).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Billing ("usage/quota"). This screen owns the org-scoped
 * usage-alert *rules* an admin sets: a metric, a threshold percent, and whether the rule is active. It
 * creates a rule and lists the organization's rules with a live breach badge from the status read. Both
 * routes are gated on the server by `org.manage`, so a member without the capability sees the API's
 * refusal rather than a blank page.
 *
 * ## What it does, and what it cannot
 *
 * - **Nothing is dispatched here.** A breach badge is a computed fact; email/notification delivery when
 *   a threshold is crossed is a later slice (Needs-Peter). The screen shows whether a rule is breached,
 *   never sends anything.
 */
export function UsageAlertsScreen({
  organizationSlug,
  organizationName,
  client,
}: UsageAlertsScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  const alerts = useQuery({
    queryKey: ['usage-alerts', organizationSlug],
    queryFn: () => listUsageAlerts(api, organizationSlug),
  });
  const status = useQuery({
    queryKey: ['usage-alerts-status', organizationSlug],
    queryFn: () => readUsageAlertStatus(api, organizationSlug),
  });

  const [metric, setMetric] = useState<UsageAlertMetric>(METRICS[0]);
  const [threshold, setThreshold] = useState('80');

  const rows = alerts.data ?? [];
  const breachedByMetric = new Map((status.data ?? []).map((s) => [s.metric, s.breached]));

  const create = useMutation({
    mutationFn: () =>
      createUsageAlert(api, organizationSlug, {
        metric,
        thresholdPercent: Number(threshold),
      }),
    onSuccess: async () => {
      setMetric(METRICS[0]);
      setThreshold('80');
      await queryClient.invalidateQueries({ queryKey: ['usage-alerts', organizationSlug] });
      await queryClient.invalidateQueries({ queryKey: ['usage-alerts-status', organizationSlug] });
    },
  });

  const thresholdValue = Number(threshold);
  const thresholdValid =
    Number.isInteger(thresholdValue) && thresholdValue >= 1 && thresholdValue <= 100;
  const canCreate = thresholdValid && !create.isPending;

  return (
    <SettingsShell
      section="billing"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('UsageAlertsScreen.eyebrow')}
      title={t('UsageAlertsScreen.title')}
      description={t('UsageAlertsScreen.description')}
    >
      <div className="tm-bil">
        <section className="tm-panel tm-stack" aria-labelledby="tm-usage-alert-new-heading">
          <h2 id="tm-usage-alert-new-heading" className="tm-eyebrow">
            {t('UsageAlertsScreen.newAlert')}
          </h2>
          <form
            className="tm-stack"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (canCreate) create.mutate();
            }}
          >
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-usage-alert-metric">
                {t('UsageAlertsScreen.metric')}
              </label>
              <select
                id="tm-usage-alert-metric"
                className="tm-field__control"
                value={metric}
                onChange={(event) => setMetric(event.target.value as UsageAlertMetric)}
              >
                {METRICS.map((value) => (
                  <option key={value} value={value}>
                    {humanize(value)}
                  </option>
                ))}
              </select>
            </div>

            <Field
              label={t('UsageAlertsScreen.thresholdPercent')}
              name="thresholdPercent"
              type="number"
              min={1}
              max={100}
              value={threshold}
              onChange={(event) => setThreshold(event.target.value)}
              hint={t('UsageAlertsScreen.thresholdHint')}
              required
            />

            {create.isError ? (
              <InlineAlert tone="danger" title={t('UsageAlertsScreen.createError')} live>
                {describeError(create.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={create.isPending}
                loadingLabel={t('UsageAlertsScreen.creating')}
                disabled={!canCreate}
              >
                {t('UsageAlertsScreen.createAlert')}
              </Button>
            </div>
          </form>
        </section>

        <section
          className="tm-panel tm-panel--quiet tm-stack"
          aria-labelledby="tm-usage-alert-list-heading"
        >
          <h2 id="tm-usage-alert-list-heading" className="tm-eyebrow">
            {t('UsageAlertsScreen.alerts')}
          </h2>

          {alerts.isError ? (
            <InlineAlert tone="danger" title={t('UsageAlertsScreen.loadError')} live>
              {describeError(alerts.error)}
            </InlineAlert>
          ) : null}

          {alerts.isPending ? (
            <LoadingRegion label={t('UsageAlertsScreen.loading')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!alerts.isPending && !alerts.isError && rows.length === 0 ? (
            <InlineAlert tone="neutral" title={t('UsageAlertsScreen.emptyTitle')}>
              {t('UsageAlertsScreen.emptyBody')}
            </InlineAlert>
          ) : null}

          {rows.length > 0 ? (
            <div
              className="tm-table-scroll"
              // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
              // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              role="region"
              aria-label={t('UsageAlertsScreen.tableLabel')}
            >
              <table className="tm-table">
                <caption className="tm-visually-hidden">
                  {t('UsageAlertsScreen.captionPrefix')} {rows.length}{' '}
                  {t('UsageAlertsScreen.captionShown')}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t('UsageAlertsScreen.colMetric')}</th>
                    <th scope="col">{t('UsageAlertsScreen.colThreshold')}</th>
                    <th scope="col">{t('UsageAlertsScreen.colActive')}</th>
                    <th scope="col">{t('UsageAlertsScreen.colState')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((alert) => (
                    <tr key={alert.id}>
                      <th scope="row" className="tm-table__title">
                        {humanize(alert.metric)}
                      </th>
                      <td>{alert.thresholdPercent}%</td>
                      <td>
                        {alert.active ? t('UsageAlertsScreen.yes') : t('UsageAlertsScreen.no')}
                      </td>
                      <td>
                        {breachedByMetric.get(alert.metric)
                          ? t('UsageAlertsScreen.breached')
                          : t('UsageAlertsScreen.ok')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </div>
    </SettingsShell>
  );
}
