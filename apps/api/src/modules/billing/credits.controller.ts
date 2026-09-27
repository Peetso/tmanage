import { Body, Controller, Get, HttpCode, Inject, Module, Post } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { CreditsService, type BillingCreditView } from './credits.service.js';

/**
 * Billing & entitlements (module 19, x226). A manual credit / adjustment ledger over the org's billing
 * account. Two routes: post a credit and list the tenant's credits newest-first with a running balance.
 *
 * The controller is the HTTP boundary: it validates the request (amount an integer in bounds, reason a
 * non-empty bounded string) and delegates the tenant-scoping, authorization and balance computation to
 * {@link CreditsService}. Every route reuses `org.manage` — no billing capability exists and this slice
 * adds none (the same divergence `usage-alerts.controller.ts` records). An out-of-bounds `amount` or an
 * empty/over-long `reason` is a 400 with no write, decided before the service is touched.
 *
 * This is a *bookkeeping* ledger: nothing here moves money or calls a payment gateway (real settlement
 * is Needs-Peter), and a posted credit is immutable — there is no edit or delete route, only post/list.
 */

const AMOUNT_MAX = 100_000_000;
const REASON_MAX = 500;

interface PostCreditBody {
  readonly amount?: unknown;
  readonly reason?: unknown;
}

/** DI token for the service, private to this slice so no `tokens.ts` edit is needed (the schedules
 * posture). Declared before the controller so its `@Inject` decorator can reference it. */
const CREDITS_SERVICE = Symbol.for('tmanage.BillingCreditsService');

@Controller('v1/organizations/:orgSlug/billing/credits')
export class BillingCreditsController {
  constructor(@Inject(CREDITS_SERVICE) private readonly credits: CreditsService) {}

  /** List the acting tenant's credits newest-first with a running balance. `org.manage`. */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly credits: readonly BillingCreditView[]; readonly balance: number }> {
    return this.credits.list(context, principal);
  }

  /** Post a credit / adjustment. `org.manage`. An out-of-bounds amount or bad reason is a 400. */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async post(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: PostCreditBody,
  ): Promise<BillingCreditView> {
    const amount = validateAmount(body?.amount);
    const reason = validateReason(body?.reason);
    return this.credits.post(context, principal, { amount, reason });
  }
}

function validateAmount(raw: unknown): number {
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw === 0 ||
    raw < -AMOUNT_MAX ||
    raw > AMOUNT_MAX
  ) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [
        {
          field: 'amount',
          message: `must be a non-zero integer between ${-AMOUNT_MAX} and ${AMOUNT_MAX} minor units`,
        },
      ],
      'billing_credit_amount_out_of_range',
    );
  }
  return raw;
}

function validateReason(raw: unknown): string {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason === '' || reason.length > REASON_MAX) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [
        {
          field: 'reason',
          message: `must be a non-empty string of at most ${REASON_MAX} characters`,
        },
      ],
      'billing_credit_reason_invalid',
    );
  }
  return reason;
}

/**
 * Billing & entitlements (module 19, x226). The module that wires the controller and its service.
 * Registered in `app.module.ts` directly rather than folded into a shared billing module, so this slice
 * touches no file another billing slice in the same pass appends to. It reuses `org.manage`, so it adds
 * nothing to the capability files.
 */
@Module({})
export class BillingCreditsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: CREDITS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new CreditsService(database),
    };

    return {
      module: BillingCreditsModule,
      providers: [service],
      controllers: [BillingCreditsController],
    };
  }
}
