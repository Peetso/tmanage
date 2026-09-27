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
import { BillingContactsService } from './contacts.service.js';
import type { BillingContactView } from './contacts.service.js';

/**
 * Billing contacts — Billing module 19 (x199). The controller for the org's nominated billing/
 * notification contacts: add one, list them, remove one. Thin over {@link BillingContactsService},
 * which owns the authorization, validation and the tenant-scoped data access.
 *
 * The billing profile (x180) carries one billing email on the org row; this surface adds the *list* of
 * contacts a studio nominates — an accounts-payable address, an owner, a finance manager. Every route
 * is behind `org.manage` (owners), the same gate the billing profile takes; no capability is invented
 * and `capabilities.ts` is untouched. No email is sent to a contact (delivery is Needs-Peter) and no
 * payment instrument is ever stored (04-SECURITY-PRIVACY §4).
 */

/**
 * The contacts-list read. Not a `…View` and not a named web interface — it is the endpoint's envelope
 * around the one paired projection ({@link BillingContactView}), the shape the billing-seats list read
 * uses inline. The element is what the contracts gate pairs.
 */
export type BillingContactsList = {
  readonly contacts: readonly BillingContactView[];
};

/** DI token for the co-located service, so no `tokens.ts` edit is needed for this slice. */
const BILLING_CONTACTS_SERVICE = Symbol.for('tmanage.BillingContactsService');

@Controller('v1/organizations/:orgSlug/billing/contacts')
export class BillingContactsController {
  constructor(
    @Inject(BILLING_CONTACTS_SERVICE) private readonly contacts: BillingContactsService,
  ) {}

  /** List the tenant's billing contacts. `org.manage`. */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<BillingContactsList> {
    const contacts = await this.contacts.list(context, principal);
    return { contacts };
  }

  /** Add a billing contact. `org.manage`. */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<BillingContactView> {
    return this.contacts.add(context, principal, body);
  }

  /** Remove a billing contact, tenant-scoped. `org.manage`. */
  @Delete(':contactId')
  @RequireCapability('org.manage')
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('contactId') contactId: string,
  ): Promise<BillingContactView> {
    if (typeof contactId !== 'string' || contactId === '') {
      throw new ApiError(400, 'validation_failed', 'contactId is required', [
        { field: 'contactId', message: 'must be a non-empty string' },
      ]);
    }
    return this.contacts.remove(context, principal, contactId);
  }
}

/**
 * Billing module 19 (x199). The module that wires the controller and its service. Registered in
 * `app.module.ts` as a self-contained billing-contacts module, file-disjoint from the sibling billing
 * slices; it depends only on the tenant database.
 */
@Module({})
export class BillingContactsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: BILLING_CONTACTS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new BillingContactsService(database),
    };

    return {
      module: BillingContactsModule,
      providers: [service],
      controllers: [BillingContactsController],
    };
  }
}
