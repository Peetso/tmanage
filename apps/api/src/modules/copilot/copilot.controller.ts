import { Body, Controller, HttpCode, Inject, Post, Optional } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { FeatureFlagsRepository } from '../admin/feature-flags.repository.js';
import { CopilotService } from './copilot.service.js';
import type { CopilotAnswerView } from './copilot.service.js';

/**
 * AI copilot — the `ask` route of Module 16 (Search, command & AI).
 *
 * `POST …/copilot/ask {question}` returns a {@link CopilotAnswerView}: a provider's answer, the
 * evidence behind it, the caller's permission boundary, and the next safe action. The route is the
 * provider-agnostic shell; the only provider wired today is the deterministic offline stub, so the
 * endpoint makes no network call and needs no key (`38-MODULE-MAP §Search, command & AI`; the real
 * paid model is Needs-Peter / NS-13).
 *
 * Two gates, both enforced in {@link CopilotService} before any provider is asked: the `copilot`
 * per-org feature flag (off → 404, the module does not exist for this org) and the `search.use`
 * capability (missing → 403). It shares `search.use` with the rest of module 16, so no new
 * capability and no `capabilities.ts` edit. A second controller on the search-adjacent base path,
 * file-disjoint from the search slices, registered from `app.module.ts`.
 */
@Controller('v1/organizations/:orgSlug/copilot')
export class CopilotController {
  private readonly service: CopilotService;

  constructor(
    @Inject(TENANT_DATABASE) database: TenantDatabase,
    @Optional()
    @Inject(FeatureFlagsRepository)
    flags: FeatureFlagsRepository = new FeatureFlagsRepository(),
  ) {
    this.service = new CopilotService(database, flags);
  }

  /**
   * Ask the copilot a question (200 — the answer view). The flag is resolved first (404 off), the
   * `search.use` decision is re-asserted (403), and the question is validated (400) before the
   * offline stub produces a scope-aware, source-cited answer. Read-only: no write, no network.
   */
  @Post('ask')
  @RequireCapability('search.use')
  @HttpCode(200)
  ask(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: { readonly question?: unknown },
  ): Promise<CopilotAnswerView> {
    return this.service.ask(context, principal, body?.question);
  }
}
