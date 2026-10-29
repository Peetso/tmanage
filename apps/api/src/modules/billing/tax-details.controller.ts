import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { BILLING_TAX_DETAILS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  BillingTaxDetailsService,
  TaxDetailsView,
  UpdateTaxDetailsBody,
} from './tax-details.service.js';

/**
 * Billing tax / legal-entity details (module 19, x283) — the tax-details surface of the Billing
 * module. Two routes over one org-scoped row: read the organization's tax/legal-entity details and
 * upsert them. Distinct from the billing-profile contact slice (x180): legal name, tax id, registration
 * number and tax country only — no contact, no address, and deliberately no card or bank field.
 *
 * The controller is the HTTP surface only. `CapabilityGuard` (`@RequireCapability('billing.view' | 'billing.manage')`, PA-01) is
 * the coarse gate; the authoritative deny-by-default `authorize()`, the whole-body validation and the
 * single read/upsert all live in {@link BillingTaxDetailsService}. Neither route takes an
 * organization-id parameter — the tenant is `context.organizationId`, resolved from an active
 * membership before the handler runs — so a cross-tenant read or write is not expressible here.
 */
@Controller('v1/organizations/:orgSlug/billing/tax-details')
export class BillingTaxDetailsController {
  constructor(
    @Inject(BILLING_TAX_DETAILS_SERVICE) private readonly service: BillingTaxDetailsService,
  ) {}

  /** Read the acting tenant's tax details, or the defaults when none has been saved. */
  @Get()
  @RequireCapability('billing.view')
  read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TaxDetailsView> {
    return this.service.read(context, principal);
  }

  /** Create or replace the acting tenant's tax details. */
  @Put()
  @RequireCapability('billing.manage')
  update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: UpdateTaxDetailsBody,
  ): Promise<TaxDetailsView> {
    return this.service.update(context, principal, body);
  }
}
