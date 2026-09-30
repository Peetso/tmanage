import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PurchaseOrdersService, type PurchaseOrderView } from './purchase-orders.service.js';

/**
 * Billing & entitlements (module 19, x282). Purchase-order (PO) references for the org: a billing
 * admin records the finance-issued PO numbers so a later invoice can cite one. Four routes: record a
 * PO, list the tenant's POs, close a PO, and remove a PO. Record only — nothing here charges,
 * transfers, or stores a payment instrument.
 *
 * The controller is the HTTP boundary: it validates the request (non-empty `poNumber`, a non-negative
 * integer `amount` when present, a 3-letter `currency` when present), and delegates the
 * tenant-scoping, authorization and duplicate/idempotency handling to {@link PurchaseOrdersService}.
 * Every route reuses `org.manage` — no billing capability exists and this slice adds none (the
 * `usage-alerts.controller.ts` records the same divergence). An empty `poNumber` or a negative
 * `amount` is a 400 with no write, decided before the service is touched; a duplicate number is a 409.
 */

const PO_NUMBER_MAX = 128;
const NOTE_MAX = 500;

interface CreatePurchaseOrderBody {
  readonly poNumber?: unknown;
  readonly amount?: unknown;
  readonly currency?: unknown;
  readonly note?: unknown;
}

/** DI token for the service, private to this slice so no `tokens.ts` edit is needed. */
const PURCHASE_ORDERS_SERVICE = Symbol.for('tmanage.PurchaseOrdersService');

@Controller('v1/organizations/:orgSlug/billing/purchase-orders')
export class PurchaseOrdersController {
  constructor(
    @Inject(PURCHASE_ORDERS_SERVICE) private readonly purchaseOrders: PurchaseOrdersService,
  ) {}

  /** List the acting tenant's PO references, number-ascending. `org.manage`. */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly purchaseOrders: readonly PurchaseOrderView[] }> {
    return { purchaseOrders: await this.purchaseOrders.list(context, principal) };
  }

  /** Record a PO reference. `org.manage`. An empty number or a negative amount is a 400; a duplicate
   * number is a 409. */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreatePurchaseOrderBody,
  ): Promise<PurchaseOrderView> {
    const poNumber = validatePoNumber(body?.poNumber);
    const amountMinor = validateAmount(body?.amount);
    const currency = validateCurrency(body?.currency);
    const note = validateNote(body?.note);
    return this.purchaseOrders.create(context, principal, {
      poNumber,
      amountMinor,
      currency,
      note,
    });
  }

  /** Close a PO reference. A cross-tenant or missing id is a 404. Idempotent. `org.manage`. */
  @Put(':id/close')
  @RequireCapability('org.manage')
  async close(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<PurchaseOrderView> {
    requireId(id);
    return this.purchaseOrders.close(context, principal, id);
  }

  /** Remove a PO reference. Idempotent (204 whether or not it existed). `org.manage`. */
  @Delete(':id')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<void> {
    requireId(id);
    await this.purchaseOrders.remove(context, principal, id);
  }
}

function validatePoNumber(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > PO_NUMBER_MAX) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [
        {
          field: 'poNumber',
          message: `must be a non-empty string of at most ${PO_NUMBER_MAX} characters`,
        },
      ],
      'purchase_order_number_invalid',
    );
  }
  return raw.trim();
}

function validateAmount(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [
        {
          field: 'amount',
          message: 'must be a non-negative integer in the smallest currency unit',
        },
      ],
      'purchase_order_amount_invalid',
    );
  }
  return raw;
}

function validateCurrency(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !/^[A-Za-z]{3}$/.test(raw)) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'currency', message: 'must be a 3-letter ISO-4217 code' },
    ]);
  }
  return raw.toUpperCase();
}

function validateNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw.length > NOTE_MAX) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'note', message: `must be a string of at most ${NOTE_MAX} characters` },
    ]);
  }
  return raw;
}

function requireId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id === '') {
    throw new ApiError(400, 'validation_failed', 'id is required', [
      { field: 'id', message: 'must be a non-empty string' },
    ]);
  }
}

/**
 * Billing & entitlements (module 19, x282). The module that wires the controller and its service.
 * Registered in `app.module.ts` as a self-contained purchase-orders module, file-disjoint from the
 * sibling billing slices; it reuses `org.manage`, so it adds nothing to the capability files.
 */
@Module({})
export class BillingPurchaseOrdersModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PURCHASE_ORDERS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new PurchaseOrdersService(database),
    };

    return {
      module: BillingPurchaseOrdersModule,
      providers: [service],
      controllers: [PurchaseOrdersController],
    };
  }
}
