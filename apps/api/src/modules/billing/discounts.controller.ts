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
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DiscountsService, type BillingDiscountView } from './discounts.service.js';

/**
 * Billing & plan management (module 19, x330). The org's discount / adjustment register: record a
 * discount, list them (each marked active or expired), and remove one. Thin over
 * {@link DiscountsService}, which owns the authorization, the tenant-scoping and the data access.
 *
 * The controller is the HTTP boundary: it validates the request (`label` a non-empty bounded string,
 * `kind` in the allowlist, `amount` an integer in the bounds the `kind` implies, `expiresOn` a calendar
 * date or null) and rejects an invalid body with a 400 *before the service is touched* — no write. Every
 * route reuses `org.manage` (owners), the same gate the sibling billing slices take; no capability is
 * invented and `capabilities.ts` is untouched. This is a *bookkeeping* register: nothing here moves
 * money, computes a charge or touches an invoice (applying a discount to a real charge is
 * Needs-Peter / Stripe). A discount is created and deleted, never edited.
 */

const LABEL_MAX = 200;
const FIXED_AMOUNT_MAX = 100_000_000;
const PERCENT_MAX = 100;
const KINDS = ['percent', 'fixed'] as const;
type DiscountKind = (typeof KINDS)[number];

interface CreateDiscountBody {
  readonly label?: unknown;
  readonly kind?: unknown;
  readonly amount?: unknown;
  readonly expiresOn?: unknown;
}

/** The list read's envelope around the one paired projection, {@link BillingDiscountView}. */
export type BillingDiscountsList = {
  readonly discounts: readonly BillingDiscountView[];
};

/** DI token for the co-located service, so no `tokens.ts` edit is needed for this slice. */
const BILLING_DISCOUNTS_SERVICE = Symbol.for('tmanage.BillingDiscountsService');

@Controller('v1/organizations/:orgSlug/billing/discounts')
export class BillingDiscountsController {
  constructor(@Inject(BILLING_DISCOUNTS_SERVICE) private readonly discounts: DiscountsService) {}

  /** List the acting tenant's discounts, each marked active or expired. `org.manage`. */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<BillingDiscountsList> {
    return this.discounts.list(context, principal);
  }

  /** Record a discount / adjustment. `org.manage`. An invalid field is a 400 with no write. */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateDiscountBody,
  ): Promise<BillingDiscountView> {
    const label = validateLabel(body?.label);
    const kind = validateKind(body?.kind);
    const amount = validateAmount(kind, body?.amount);
    const expiresOn = validateExpiresOn(body?.expiresOn);
    return this.discounts.create(context, principal, { label, kind, amount, expiresOn });
  }

  /** Remove a discount, tenant-scoped. A cross-tenant or absent id is a 404. `org.manage`. */
  @Delete(':discountId')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('discountId') discountId: string,
  ): Promise<void> {
    if (typeof discountId !== 'string' || discountId === '') {
      throw new ApiError(400, 'validation_failed', 'discountId is required', [
        { field: 'discountId', message: 'must be a non-empty string' },
      ]);
    }
    await this.discounts.remove(context, principal, discountId);
  }
}

function validateLabel(raw: unknown): string {
  const label = typeof raw === 'string' ? raw.trim() : '';
  if (label === '' || label.length > LABEL_MAX) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [
        {
          field: 'label',
          message: `must be a non-empty string of at most ${LABEL_MAX} characters`,
        },
      ],
      'billing_discount_label_invalid',
    );
  }
  return label;
}

function validateKind(raw: unknown): DiscountKind {
  if (typeof raw !== 'string' || !(KINDS as readonly string[]).includes(raw)) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [{ field: 'kind', message: `must be one of ${KINDS.join(', ')}` }],
      'billing_discount_kind_invalid',
    );
  }
  return raw as DiscountKind;
}

function validateAmount(kind: DiscountKind, raw: unknown): number {
  const max = kind === 'percent' ? PERCENT_MAX : FIXED_AMOUNT_MAX;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > max) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [
        {
          field: 'amount',
          message:
            kind === 'percent'
              ? `must be an integer percentage between 0 and ${PERCENT_MAX}`
              : `must be a non-negative integer of at most ${FIXED_AMOUNT_MAX} minor units`,
        },
      ],
      'billing_discount_amount_out_of_range',
    );
  }
  return raw;
}

/** A calendar date `YYYY-MM-DD`, or null. An absent/null value is a never-expiring record. */
function validateExpiresOn(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !isCalendarDate(raw)) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [{ field: 'expiresOn', message: 'must be a calendar date YYYY-MM-DD, or null' }],
      'billing_discount_expires_on_invalid',
    );
  }
  return raw;
}

/** True only for a real `YYYY-MM-DD` calendar date (rejects e.g. `2026-02-30`). */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(time)) return false;
  return new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * Billing & plan management (module 19, x330). The module that wires the controller and its service.
 * Registered in `app.module.ts` as a self-contained billing-discounts module, file-disjoint from the
 * sibling billing slices; it depends only on the tenant database and reuses `org.manage`, so it adds
 * nothing to the capability files.
 */
@Module({})
export class BillingDiscountsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: BILLING_DISCOUNTS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new DiscountsService(database),
    };

    return {
      module: BillingDiscountsModule,
      providers: [service],
      controllers: [BillingDiscountsController],
    };
  }
}
