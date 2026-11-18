import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { InvoiceSummary } from '../finance/client-invoices.service.js';
import type { WorkItemView } from '../work/work-items.service.js';
import type { SummarySources } from './summary-sources.js';

/**
 * ONEPAGE (B01). The two paged walks the summaries make over a source list read. Both are bounded:
 * a summary is one page view, so past the budget it reports `complete: false` rather than turning
 * one request into a scan. The page size is the source's own maximum.
 */

/** Work pages of the source's maximum size walked per project before reporting incomplete. */
export const WORK_PAGE_SIZE = 200;
export const WORK_PAGE_BUDGET = 10;
/** Invoice pages (the source's fixed page) walked per client before reporting incomplete. */
export const INVOICE_PAGE_BUDGET = 10;

export interface Walked<T> {
  readonly items: readonly T[];
  readonly complete: boolean;
}

/** Every work item of the project the viewer may read, through `WorkItemsService.list`. */
export async function readableWork(
  work: SummarySources['work'],
  context: TenantContext,
  principal: Principal,
  projectId: string,
): Promise<Walked<WorkItemView>> {
  const items: WorkItemView[] = [];
  let after: string | undefined;
  for (let page = 0; page < WORK_PAGE_BUDGET; page += 1) {
    const rows = await work.list(context, principal, {
      projectId,
      limit: WORK_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    items.push(...rows);
    const last = rows[rows.length - 1];
    if (rows.length < WORK_PAGE_SIZE || last === undefined) return { items, complete: true };
    after = last.id;
  }
  return { items, complete: false };
}

/** Every invoice of the client company, through `ClientInvoicesService.list` and its cursor. */
export async function clientInvoices(
  invoices: SummarySources['invoices'],
  context: TenantContext,
  principal: Principal,
  clientOrganizationId: string,
): Promise<Walked<InvoiceSummary>> {
  const items: InvoiceSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < INVOICE_PAGE_BUDGET; page += 1) {
    const result = await invoices.list(context, principal, {
      clientOrganizationId,
      ...(cursor === null ? {} : { cursor }),
    });
    items.push(...result.invoices);
    if (result.nextCursor === null) return { items, complete: true };
    cursor = result.nextCursor;
  }
  return { items, complete: false };
}
