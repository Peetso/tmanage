'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getCostCenterReport } from '../../lib/api/cost-center-report';
import type { CostCenterReportRow } from '../../lib/api/cost-center-report';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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
  const api = client ?? browserApiClient();

  const report = useQuery({
    queryKey: ['cost-center-report', organizationSlug],
    queryFn: () => getCostCenterReport(api, organizationSlug),
  });

  const rows = report.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Spend by cost center"
      description="Each cost center with the projects assigned to it and their summed budget."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-cost-center-report-heading">
        <h2 id="tm-cost-center-report-heading" className="tm-eyebrow">
          Cost centers
        </h2>

        {report.isError ? (
          <InlineAlert tone="danger" title="Could not load the report" live>
            {describeError(report.error)}
          </InlineAlert>
        ) : null}

        {report.isPending ? (
          <LoadingRegion label="Loading the cost-center report.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!report.isPending && !report.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No cost centers yet">
            Define cost centers and assign projects to them to see spend rolled up here.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              Each cost center with its assigned-project count and summed budget.
            </caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Projects</th>
                <th scope="col">Budgeted hours</th>
                <th scope="col">Budgeted amount</th>
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
    </AppShell>
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

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
