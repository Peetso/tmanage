import { Body, Controller, Get, Inject, Module, Optional, Put } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { OrgPolicyValue } from '../../common/database/schema.js';
import {
  DEFAULT_POLICY,
  mergePolicy,
  normalizePolicy,
  validatePolicyPatch,
} from './policies.allowlist.js';
import { PoliciesRepository } from './policies.repository.js';

/**
 * Organization access policies (Administration module 18, x174) — the read + update surface the audit
 * named absent (rank #9, Admin Partial: policies absent). Two routes behind `org.manage`: read the
 * organization's access policy (its stored document, or the defaults if none), and update it.
 *
 * ## Distinct from x153 org settings
 *
 * x153 (`org_settings`) is the general string key/value preferences surface (timezone, re-auth window,
 * default project visibility), PUT one key at a time. This is the **access-policy** surface — session
 * lifetime, invite-domain allowlist, guest access — a fixed-key allowlist of *typed, bounded* values
 * stored as one JSON document per organization, PUT as a (partial) document at once.
 *
 * ## The allowlist is the substance
 *
 * `policies.allowlist.ts` is the single source of which policies exist, their defaults and their
 * per-key validators. A key outside it is a 400 with no write, and a value out of range or of the
 * wrong type is a 400 with no write — so no arbitrary key or value can ever be written.
 *
 * ## Two guards, and the order that matters
 *
 * `@RequireCapability('org.manage')` is the coarse gate `CapabilityGuard` reads: a caller whose role
 * does not hold `org.manage` is refused 403 before any handler runs. The handler *also* runs the real
 * `authorize` for the same capability — the org-wide, tenant-checked decision — so the safety is a rule
 * a controller test proves directly. The write path resolves the organization tenant-scoped **before**
 * it authorizes or writes (the Known trap): a context whose organization does not exist in this tenant
 * is a 404 with no write, before the 403, before the allowlist 400s.
 */
export interface OrgPolicyView {
  readonly policy: {
    readonly session_max_hours: number;
    readonly invite_domain_allowlist: readonly string[];
    readonly guest_access_enabled: boolean;
  };
}

@Controller('v1/organizations/:orgSlug/policies')
export class PoliciesController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional() private readonly policies: PoliciesRepository = new PoliciesRepository(),
  ) {}

  /** Read the organization's access policy — its stored document, or the defaults if none (200). */
  @Get()
  @RequireCapability('org.manage')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OrgPolicyView> {
    this.requireOrgManage(principal, context);
    const policy = await this.database.read(context, (runner) =>
      this.policies.find(runner, context),
    );
    return { policy: policy ? normalizePolicy(policy.policyJson) : DEFAULT_POLICY };
  }

  /**
   * Update the organization's access policy (200 — the full policy after the write). The organization is
   * resolved tenant-scoped before authorize/write (Known trap: a cross-tenant context is a 404, no
   * write); an off-allowlist key or a value the validator rejects is a 400 with no write. The body is a
   * (partial) policy document; the provided fields are validated, canonicalised and merged onto the
   * stored document (or the defaults), and the whole document is upserted.
   */
  @Put()
  @RequireCapability('org.manage')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<OrgPolicyView> {
    let merged: OrgPolicyValue = DEFAULT_POLICY;
    await this.database.transaction(context, async (tx) => {
      // 1. Resolve the organization tenant-scoped, BEFORE authorize/write (Known trap): a context
      //    whose organization is not in this tenant is a 404, never a dangling upsert.
      const org = await this.policies.resolveOrganization(tx, context);
      if (!org) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      // 2. The real org-wide authorize for `org.manage` (the decorator is the coarse HTTP gate; this
      //    is the tenant-checked decision the test exercises).
      this.requireOrgManage(principal, context);

      // 3. The allowlist is the boundary: an off-list key or a value the validator rejects is a 400
      //    with no write. No arbitrary key or out-of-range value is ever stored.
      const validated = validatePolicyPatch(body);
      if (!validated.ok) {
        throw new ApiError(400, 'validation_failed', 'That access policy is not allowed.', [
          { field: validated.field, message: validated.message },
        ]);
      }

      // 4. Merge the validated fields onto the stored document (or the defaults) and upsert the whole
      //    document on organization_id: a first write inserts, a re-set overwrites in place.
      const current = await this.policies.find(tx, context);
      const base = current ? normalizePolicy(current.policyJson) : DEFAULT_POLICY;
      merged = mergePolicy(base, validated.patch);
      await this.policies.upsert(tx, context, { policy: merged, updatedBy: principal.userId });
    });

    return { policy: merged };
  }

  /**
   * The real `org.manage` decision — org-wide, so `projectId: null` and an internal audience (the shape
   * `ClientsService` uses for the same capability). An internal role holding `org.manage` passes; a
   * client is refused (`org.manage` is internal-only), and a cross-tenant principal by the tenant check
   * inside `authorize`. A denial is a 403 with the machine-readable code.
   */
  private requireOrgManage(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
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
        `org_policies.write:${verdict.code}`,
      );
    }
  }
}

/**
 * x174's wiring — a self-contained module registered from `app.module.ts` (the shared append point),
 * file-disjoint from x153's `OrgSettingsModule` in the tenancy module. The repository is a stateless
 * collection of tenant-scoped reads and the upsert, constructed here; the controller injects it and the
 * `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class AdminPoliciesModule {
  static register(): DynamicModule {
    return {
      module: AdminPoliciesModule,
      providers: [{ provide: PoliciesRepository, useFactory: () => new PoliciesRepository() }],
      controllers: [PoliciesController],
    };
  }
}
