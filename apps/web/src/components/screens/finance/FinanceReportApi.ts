import type { ApiClient } from '../../../lib/api/client';

/**
 * Finance reports: the accounting-export history `GET …/finance/exports` (`finance.view`). The aging
 * roll-up comes from `InvoiceApi.getInvoiceAging`. Mirrors the API's `FinanceExportView`.
 */

export interface FinanceExportRow {
  readonly id: string;
  readonly target: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly kinds: readonly string[];
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly latinOnly: boolean;
  readonly createdAt: string;
}

export async function listFinanceExports(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly FinanceExportRow[]> {
  const { data } = await client.request<{ exports: readonly FinanceExportRow[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/finance/exports`,
  });
  return data.exports;
}
