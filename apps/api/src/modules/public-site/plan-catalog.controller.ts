import { Controller, Get, Inject, Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { Public } from '../../common/http/decorators.js';
import { PlanCatalogService } from './plan-catalog.service.js';
import type { PublicPlanView } from './plan-catalog.service.js';

/**
 * FEAT · module 1 Public site (x157). The public pricing endpoint.
 *
 * `GET /v1/public/site/plans` returns the static plan catalog. The controller is `@Public()`, which
 * takes it out of the whole guard pipeline — no session, no CSRF, no tenant, no capability — because
 * the audience is an unauthenticated visitor deciding whether to sign up. That is the one deliberate
 * departure from every other controller here, and it is safe for the reason `decorators.ts` gives: a
 * public *read* establishes no authority and exercises none. The response carries display copy and
 * prices only; there is no principal to scope to and nothing tenant-specific to leak.
 *
 * It does not accept a body, a query or a tenant segment — the catalog is the same for everyone — so
 * there is no input to validate and no id to resolve. The token below is module-local rather than a
 * shared `tokens.ts` symbol, keeping this slice file-disjoint from the sibling public-site slices,
 * and `@Inject` names it explicitly because this codebase does not enable `emitDecoratorMetadata`
 * (ADR-0003): a constructor parameter's type is invisible to Nest, so the token must be written.
 */
const PLAN_CATALOG_SERVICE = Symbol('tmanage.public-site.PlanCatalogService');

@Controller('v1/public/site')
@Public()
export class PlanCatalogController {
  constructor(@Inject(PLAN_CATALOG_SERVICE) private readonly catalog: PlanCatalogService) {}

  @Get('plans')
  plans(): { readonly plans: readonly PublicPlanView[] } {
    return { plans: this.catalog.list() };
  }
}

/**
 * The public-site module — registered in `app.module.ts`. Defined here beside its one controller (as
 * the docs template-variables and insights-adoption slices do) so the whole slice is its three new
 * files plus the shared appends, and no `*.module.ts` of its own.
 */
@Module({})
export class PublicSiteModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PLAN_CATALOG_SERVICE,
      useFactory: () => new PlanCatalogService(),
    };
    return {
      module: PublicSiteModule,
      providers: [service],
      controllers: [PlanCatalogController],
    };
  }
}
