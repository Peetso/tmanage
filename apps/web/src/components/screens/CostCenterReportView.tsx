'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getCostCenterReport } from '../../lib/api/cost-center-report';
import type { CostCenterReportRow } from '../../lib/api/cost-center-report';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import '../../styles/screens/billing.css';

export interface CostCenterReportViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Billing spend-by-cost-centre report (x331).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Billing & plan management (cost allocation);
 * `22-SCREEN-INVENTORY` §Billing. A read-only roll-up: each cost centre a billing admin defined (x281)
 * with the number of projects assigned to it and their summed budget (x293). It reads
 * `GET …/billing/cost-center-report`, gated on the server by `org.manage`, so a member without the
 * capability sees the API's refusal rather than a blank page.
 *
 * As on the sibling billing screens, **authorization is the API's**: a caller without the capability
 * gets the ordinary refusal, which `describeError()` turns into a sentence. Read-only — nothing here
 * writes or charges.
 */
export function CostCenterReportView({
  organizationSlug,
  organizationName,
  client,
}: CostCenterReportViewProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();

  const report = useQuery({
    queryKey: ['cost-center-report', organizationSlug],
    queryFn: () => getCostCenterReport(api, organizationSlug),
  });

  const rows = report.data ?? [];

  return (
    <SettingsShell
      section="billing"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('CostCenterReportView.eyebrow')}
      title={t('CostCenterReportView.title')}
      description={t('CostCenterReportView.description')}
    >
      <div className="tm-bil">
        <section className="tm-panel tm-stack" aria-labelledby="tm-cost-center-report-heading">
          <h2 id="tm-cost-center-report-heading" className="tm-eyebrow">
            {t('CostCenterReportView.costCentersHeading')}
          </h2>

          {report.isError ? (
            <InlineAlert tone="danger" title={t('CostCenterReportView.loadError')} live>
              {describeError(report.error)}
            </InlineAlert>
          ) : null}

          {report.isPending ? (
            <LoadingRegion label={t('CostCenterReportView.loadingLabel')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!report.isPending && !report.isError && rows.length === 0 ? (
            <InlineAlert tone="neutral" title={t('CostCenterReportView.emptyTitle')}>
              {t('CostCenterReportView.emptyBody')}
            </InlineAlert>
          ) : null}

          {rows.length > 0 ? (
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                {t('CostCenterReportView.tableCaption')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('CostCenterReportView.colCode')}</th>
                  <th scope="col">{t('CostCenterReportView.colName')}</th>
                  <th scope="col">{t('CostCenterReportView.colProjects')}</th>
                  <th scope="col">{t('CostCenterReportView.colBudgetedHours')}</th>
                  <th scope="col">{t('CostCenterReportView.colBudgetedAmount')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.code}</td>
                    <td>{row.name}</td>
                    <td>{row.projectCount}</td>
                    <td>{row.totalBudgetHours}</td>
                    <td>{formatAmount(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      </div>
    </SettingsShell>
  );
}

/**
 * The budgeted amount cell. A single currency shows the summed amount in its major unit; a cost centre
 * with no budgeted amount shows a dash; mixed currencies show "Mixed" rather than a misleading single
 * figure (the API sets `currency` to null in that case).
 */
function formatAmount(row: CostCenterReportRow): string {
  if (row.currency !== null) {
    return `${(row.totalBudgetAmountMinor / 100).toFixed(2)} ${row.currency}`;
  }
  return row.totalBudgetAmountMinor === 0 ? '—' : 'Mixed';
}
