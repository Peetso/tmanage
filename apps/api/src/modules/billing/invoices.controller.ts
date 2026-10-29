import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { INVOICES_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InvoiceRow } from '../../common/database/schema.js';
import { InvoicesRepository, effectivePageSize as invoicePageSize } from './invoices.repository.js';
import type { InvoiceStatus } from './invoices.repository.js';

/**
 * FEAT: Billing & plan management (module 19) — invoice history (x179). The read surface: a
 * tenant-scoped list and a by-id detail, both behind `org.manage` (the capability the sibling usage
 * read reuses; there is no dedicated billing capability in the role matrix — DIVERGENCE AUTH-16,
 * `usage.service.ts`).
 *
 * This slice is **read-only**. Invoices are produced by the subscription lifecycle or the seed;
 * generating real invoices from a payment provider is Needs-Peter, so there is no mutation route
 * here and the runtime credential is granted no write on the table.
 *
 * The **detail** read is where the security substance sits: the id names a row, so the invoice is
 * resolved **tenant-scoped first** ({@link InvoicesRepository.findById}); a cross-tenant or unknown
 * id returns `null` → 404, **before** the capability check — a probe learns nothing about which
 * invoices exist in another tenant. Only then is `org.manage` authorized: a member without it gets
 * 403. Amounts are always integer cents ({@link InvoiceView.amountCents}), never a float.
 */

/**
 * One line of an invoice's breakdown, as it appears on the wire. Money is integer cents. An inline,
 * unexported member of {@link InvoiceDetailView} — a named exported edge type would be enumerated by
 * `contracts:check` as its own response projection needing a pair, and it is not one.
 */
interface InvoiceLineItemView {
  readonly description: string;
  readonly quantity: number;
  readonly unitAmountCents: number;
  readonly amountCents: number;
}

/**
 * An invoice as the history list shows it — the summary row.
 *
 * The wire shape lives here (the file the contracts checker scans and the one that serialises it);
 * `toInvoiceView` maps a row onto it. `amountCents` is an integer count of the smallest currency
 * unit, never a float; `currency` is an ISO-4217 code; the period bounds and `issuedAt` are ISO-8601
 * instants.
 */
export interface InvoiceView {
  readonly id: string;
  readonly number: string;
  /** ISO-8601 instant — the start of the billing period. */
  readonly periodStart: string;
  /** ISO-8601 instant — the end of the billing period. */
  readonly periodEnd: string;
  /** The total, in the smallest unit of `currency`. Integer cents, never a float. */
  readonly amountCents: number;
  /** ISO-4217, uppercase. */
  readonly currency: string;
  readonly status: InvoiceStatus;
  /** ISO-8601 instant — when the invoice was issued. The list is ordered by this, newest first. */
  readonly issuedAt: string;
}

/**
 * An invoice's detail — the summary plus the line-item breakdown and the row's creation time.
 * Returned by `GET …/billing/invoices/:invoiceId`.
 */
export interface InvoiceDetailView extends InvoiceView {
  /** The bounded line-item breakdown. Empty when the invoice carries no stored detail. */
  readonly lineItems: readonly InvoiceLineItemView[];
  /** ISO-8601 instant — when the invoice row was created. */
  readonly createdAt: string;
}

/** Map a row onto the summary view. */
function toInvoiceView(row: InvoiceRow): InvoiceView {
  return {
    id: row.id,
    number: row.number,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    amountCents: Number(row.amountCents),
    currency: row.currency,
    status: row.status,
    issuedAt: row.issuedAt.toISOString(),
  };
}

/** Map a row onto the detail view, normalising the stored line items to the bounded wire array. */
function toInvoiceDetailView(row: InvoiceRow): InvoiceDetailView {
  const lineItems = (row.lineItems ?? []).map((item) => ({
    description: item.description,
    quantity: item.quantity,
    unitAmountCents: item.unitAmountCents,
    amountCents: item.amountCents,
  }));
  return {
    ...toInvoiceView(row),
    lineItems,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The invoices service — authorize, then read. Defined here beside the controller rather than in a
 * file of its own because the controller is its only caller and the slice is one cohesive unit; the
 * unit suite (`invoices.controller.test.ts`) exercises it directly with the real `authorize()` over
 * fakes for the database and the repository.
 */
export class InvoicesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly invoices: InvoicesRepository = new InvoicesRepository(),
  ) {}

  /** The tenant's invoice history, newest issued first — `org.manage`. */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly limit?: number } = {},
  ): Promise<readonly InvoiceView[]> {
    this.authorizeManage(context, principal, 'invoices.list');

    const limit = invoicePageSize(options.limit);
    const rows = await this.database.read(context, (runner) =>
      this.invoices.list(runner, context, { limit }),
    );
    return rows.map(toInvoiceView);
  }

  /**
   * One invoice's detail — `org.manage`.
   *
   * The Known-trap order: the invoice is resolved **tenant-scoped first**. An unknown or
   * cross-tenant id returns `null` → 404, **before** the capability check, so a probe cannot learn
   * which invoices exist in another tenant. Only then is `org.manage` authorized: a member without
   * it gets 403.
   */
  async detail(
    context: TenantContext,
    principal: Principal,
    invoiceId: string,
  ): Promise<InvoiceDetailView> {
    const row = await this.database.read(context, (runner) =>
      this.invoices.findById(runner, context, invoiceId),
    );
    if (!row) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'invoice_not_visible');
    }

    this.authorizeManage(context, principal, 'invoices.detail');

    return toInvoiceDetailView(row);
  }

  /** Authorize `org.manage` at org level, or throw 403. Reused by both reads. */
  private authorizeManage(context: TenantContext, principal: Principal, action: string): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        // Org-level resource (billing history), no project relation to lean on.
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
 * The billing invoices surface — `org.manage`, on the `billing` path. Read-only: a list and a
 * by-id detail. `CapabilityGuard` refuses a caller without `org.manage` with 403 before the handler
 * runs; the service authorizes again (route guards are UX only, `25-AUTH-AND-TENANT-ISOLATION` §3)
 * and, for the detail, resolves the id tenant-scoped before that check so an unknown id is a 404.
 */
@Controller('v1/organizations/:orgSlug/billing/invoices')
export class InvoicesController {
  constructor(@Inject(INVOICES_SERVICE) private readonly invoices: InvoicesService) {}

  @Get()
  @RequireCapability('billing.view')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('limit') limit?: string,
  ): Promise<{ readonly invoices: readonly InvoiceView[] }> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      invoices: await this.invoices.list(context, principal, {
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      }),
    };
  }

  @Get(':invoiceId')
  @RequireCapability('billing.view')
  async detail(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('invoiceId') invoiceId: string,
  ): Promise<InvoiceDetailView> {
    if (typeof invoiceId !== 'string' || invoiceId === '') {
      throw new ApiError(400, 'validation_failed', 'invoiceId is required', [
        { field: 'invoiceId', message: 'must be a non-empty string' },
      ]);
    }
    return this.invoices.detail(context, principal, invoiceId);
  }
}
