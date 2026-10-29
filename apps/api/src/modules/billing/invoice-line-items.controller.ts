import { Controller, Get, Inject, Param } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { INVOICE_LINE_ITEMS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InvoiceLineItemRow, InvoiceRow } from '../../common/database/schema.js';
import { InvoiceLineItemsRepository } from './invoice-line-items.repository.js';
import { InvoicesRepository } from './invoices.repository.js';

/**
 * FEAT: Billing & plan management (module 19) — per-invoice line-item detail (x225). x179 built the
 * invoice header history; this slice adds the durable, tenant-scoped line breakdown for one invoice
 * behind `org.manage` (the capability the sibling billing reads reuse; there is no dedicated billing
 * capability in the role matrix — DIVERGENCE AUTH-16).
 *
 * This slice is **read-only**. Lines are produced by the subscription lifecycle or the seed;
 * generating real invoices and their lines from a payment provider is Needs-Peter, so there is no
 * mutation route here and the runtime credential is granted no write on the table.
 *
 * The security substance sits in the resolve-before-authorize order: the `:invoiceId` names a row,
 * so the invoice is resolved **tenant-scoped first** ({@link InvoicesRepository.findById}); a
 * cross-tenant or unknown id returns `null` → 404, **before** the capability check, so a probe learns
 * nothing about which invoices exist in another tenant. Only then is `org.manage` authorized: a
 * member without it gets 403. Amounts are always integer minor units, never a float, and the summed
 * lines are asserted to reconcile against the stored header total.
 */

/**
 * One billed line of an invoice, as it appears on the wire. Money is integer minor units.
 */
export interface InvoiceLineItemView {
  readonly id: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitAmountCents: number;
  readonly amountCents: number;
}

/**
 * An invoice's line-item breakdown — the bounded line array plus the reconciliation between the
 * summed lines and the stored header total. Returned by `GET …/billing/invoices/:invoiceId/lines`.
 *
 * `lineTotalCents` is the sum of `lineItems[].amountCents`; `invoiceTotalCents` is the header's
 * stored total. `reconciled` is whether they agree — always `true` when lines exist (the service
 * throws on a mismatch), and `invoiceTotalCents === 0` for an invoice with no stored lines. All money
 * is integer minor units of `currency`, never a float.
 */
export interface InvoiceLinesView {
  readonly invoiceId: string;
  /** ISO-4217, uppercase — the header's currency. */
  readonly currency: string;
  /** The header's stored total, in integer minor units. */
  readonly invoiceTotalCents: number;
  /** The sum of the lines' `amountCents`, in integer minor units. */
  readonly lineTotalCents: number;
  /** Whether the summed lines reconcile to the header total. */
  readonly reconciled: boolean;
  readonly lineItems: readonly InvoiceLineItemView[];
}

/** Map a row onto the line view. Money stays an integer count of minor units. */
function toLineView(row: InvoiceLineItemRow): InvoiceLineItemView {
  return {
    id: row.id,
    description: row.description,
    quantity: Number(row.quantity),
    unitAmountCents: Number(row.unitAmountCents),
    amountCents: Number(row.amountCents),
  };
}

/**
 * The invoice line-items service — resolve the header, authorize, then read the lines. Defined here
 * beside the controller rather than in a file of its own because the controller is its only caller
 * and the slice is one cohesive unit; the unit suite exercises it directly with the real
 * `authorize()` over fakes for the database and the repositories.
 */
export class InvoiceLineItemsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly invoices: InvoicesRepository = new InvoicesRepository(),
    private readonly lines: InvoiceLineItemsRepository = new InvoiceLineItemsRepository(),
  ) {}

  /**
   * One invoice's line-item breakdown — `org.manage`.
   *
   * The Known-trap order: the invoice is resolved **tenant-scoped first**. An unknown or cross-tenant
   * id returns `null` → 404, **before** the capability check, so a probe cannot learn which invoices
   * exist in another tenant. Only then is `org.manage` authorized: a member without it gets 403.
   *
   * The summed lines are asserted to reconcile to the stored header total: when lines exist and their
   * summed `amountCents` does not equal the header's, that is a data-integrity fault (500), never a
   * silently wrong total. Amounts are integer minor units throughout — the sum is exact.
   */
  async listForInvoice(
    context: TenantContext,
    principal: Principal,
    invoiceId: string,
  ): Promise<InvoiceLinesView> {
    const header = await this.database.read(context, (runner) =>
      this.invoices.findById(runner, context, invoiceId),
    );
    if (!header) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'invoice_not_visible');
    }

    this.authorizeManage(context, principal, 'invoice_lines.list');

    const rows = await this.database.read(context, (runner) =>
      this.lines.listByInvoice(runner, context, invoiceId),
    );
    const lineItems = rows.map(toLineView);
    const lineTotalCents = lineItems.reduce((sum, item) => sum + item.amountCents, 0);
    const invoiceTotalCents = this.headerTotal(header);

    if (lineItems.length > 0 && lineTotalCents !== invoiceTotalCents) {
      // A stored breakdown whose lines do not sum to the header is a data-integrity fault, not a
      // total to serve — the seed and the (Needs-Peter) provider run own the invariant.
      throw new ApiError(
        500,
        'internal_error',
        MESSAGES.internal,
        undefined,
        'invoice_lines_unreconciled',
      );
    }

    return {
      invoiceId,
      currency: header.currency,
      invoiceTotalCents,
      lineTotalCents,
      reconciled:
        lineItems.length > 0 ? lineTotalCents === invoiceTotalCents : invoiceTotalCents === 0,
      lineItems,
    };
  }

  /** The header total as an integer count of minor units. */
  private headerTotal(header: InvoiceRow): number {
    return Number(header.amountCents);
  }

  /** Authorize `org.manage` at org level, or throw 403. */
  private authorizeManage(context: TenantContext, principal: Principal, action: string): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        // Org-level resource (billing detail), no project relation to lean on.
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `${action}:${verdict.code}`,
      );
    }
  }
}

/**
 * The billing invoice line-items surface — `org.manage`, nested under one invoice. Read-only: a
 * single by-invoice line list. `CapabilityGuard` refuses a caller without `org.manage` with 403
 * before the handler runs; the service authorizes again (route guards are UX only,
 * `25-AUTH-AND-TENANT-ISOLATION` §3) and resolves the id tenant-scoped before that check so an
 * unknown id is a 404.
 */
@Controller('v1/organizations/:orgSlug/billing/invoices/:invoiceId/lines')
export class InvoiceLineItemsController {
  constructor(
    @Inject(INVOICE_LINE_ITEMS_SERVICE) private readonly lines: InvoiceLineItemsService,
  ) {}

  @Get()
  @RequireCapability('billing.view')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('invoiceId') invoiceId: string,
  ): Promise<InvoiceLinesView> {
    if (typeof invoiceId !== 'string' || invoiceId === '') {
      throw new ApiError(400, 'validation_failed', 'invoiceId is required', [
        { field: 'invoiceId', message: 'must be a non-empty string' },
      ]);
    }
    return this.lines.listForInvoice(context, principal, invoiceId);
  }
}
