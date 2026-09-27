import { Body, Controller, Inject, Module, Optional, Post } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PolicySimulateService } from './policy-simulate.service.js';
import type { PolicySimulationView } from './policy-simulate.service.js';

/**
 * Access-policy simulation (Administration module 18, x196) — a read-only "can member X do Y?" evaluator
 * over the roles and access policies x174 stored. The audit named it absent: x174 lets an administrator
 * *store* a policy but gives no way to see the effect of a role or a policy on a specific member. This
 * one route answers that, without a mutation and without a side effect.
 *
 * ## One route, behind `org.manage`, read-only
 *
 * `POST …/policies/simulate` — body `{ memberId, capability, context? }` → the decision the live
 * `authorize()` would reach for that member, with the deciding rule made explicit. It opens a **read**,
 * never a transaction: it computes and returns, and writes nothing.
 *
 * ## The safety is that it does not lie, and does not leak
 *
 * The decision is made by the same evaluator the request path uses, over a `Principal` assembled by the
 * same session-builder read (`PolicySimulateService`), so the simulator can never diverge from the real
 * decision. And every lookup is tenant-scoped before the compute: a cross-tenant organization or member
 * is a 404, an unknown capability a 400, and a caller without `org.manage` a 403 — asserted both by the
 * `CapabilityGuard` (through the route metadata) and by the handler's own real `authorize`.
 */
@Controller('v1/organizations/:orgSlug/policies/simulate')
export class PolicySimulateController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional() private readonly service: PolicySimulateService = new PolicySimulateService(),
  ) {}

  /**
   * Simulate a single access decision (200). The body is validated to shape first (400), then the whole
   * decision — organization resolve (404), the caller's `org.manage` (403), capability validation (400),
   * member resolve (404) and the evaluator call — runs inside one tenant-scoped read.
   */
  @Post()
  @RequireCapability('org.manage')
  async simulate(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<PolicySimulationView> {
    const input = this.service.parse(body);
    return this.database.read(context, (runner) =>
      this.service.simulate(runner, context, principal, input),
    );
  }
}

/**
 * x196's wiring — a self-contained module registered from `app.module.ts`, file-disjoint from x174's
 * `AdminPoliciesModule`. The service is stateless (a collection of tenant-scoped reads and the evaluator
 * call), constructed here; the controller injects it and the `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class AdminPolicySimulateModule {
  static register(): DynamicModule {
    return {
      module: AdminPolicySimulateModule,
      providers: [
        { provide: PolicySimulateService, useFactory: () => new PolicySimulateService() },
      ],
      controllers: [PolicySimulateController],
    };
  }
}
