import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  UseGuards,
  createParamDecorator,
} from '@nestjs/common';
import type { DynamicModule, ExecutionContext, Provider } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { requestState } from '../../common/http/request-state.js';
import { CORRELATION_HEADER } from '../../common/http/correlation.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  AI_ACCESS_SWITCHES,
  AiPlatformSwitchGuard,
  aiAccessSwitchesProvider,
  aiWorkspaceDisabledError,
} from '../oauth/ai-access.js';
import type { AiAccessSwitches } from '../oauth/ai-access.js';
import { INTERNAL_GRANT_HEADER, internalGrants } from './internal-grant.js';
import type { InjectCapable } from './mcp-endpoint.controller.js';
import { PendingAiActionsService } from './pending-actions.service.js';
import type { OpExecutor, PendingAiActionView } from './pending-actions.service.js';

/**
 * **The approve page's API — `/v1/organizations/:orgSlug/ai/approvals/:id` (MCP connector S10).**
 *
 * The website's `/<org>/ai/approve/<id>` page reads one pending AI action and approves or declines
 * it. Three rules make the click the person's and nobody else's (architecture F3, B2):
 *
 *  1. **A cookie session only.** A personal access token or an AI internal grant is refused with
 *     the generic 403 — an AI client must never be able to approve its own request.
 *  2. **The same member.** The row must name the signed-in user *and* membership; any other member
 *     gets the same 404 as a missing id (`T-APR-02`).
 *  3. **POST, CSRF-checked, single use.** Approve and decline are POSTs behind the global
 *     `CsrfGuard`; the first decision wins a guarded transition and a repeat changes nothing
 *     (`T-APR-03`). The page itself is served with `frame-ancestors 'none'`.
 *
 * The capability is `work.read`, the one every internal role holds — the same choice the member's
 * own personal access tokens make. The real control is rule 2.
 *
 * These routes are in the AI registry's NEVER list: no AI tool can reach them.
 *
 * They are also behind the AI kill switches (S11): 503 while the platform switch is off, and an
 * approve answers 403 while the workspace owner has AI apps turned off, so an action frozen before
 * AI was switched off is never run through the `ai_grant` inject afterwards.
 */

const PENDING_AI_ACTIONS_SERVICE = Symbol.for('tmanage.PendingAiActionsService');

const AuthScheme = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    requestState(context.switchToHttp().getRequest())?.authScheme,
);

/** Rule 1: only a person in a browser session may see or decide an approval. */
export function requireCookieSession(authScheme: string | undefined): void {
  if (authScheme !== 'cookie') {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      undefined,
      'session_required_for_ai_approval',
    );
  }
}

// S11: 503 while the platform AI switch is off.
@UseGuards(AiPlatformSwitchGuard)
@Controller('v1/organizations/:orgSlug/ai/approvals')
export class PendingAiActionsController {
  constructor(
    @Inject(PENDING_AI_ACTIONS_SERVICE) private readonly approvals: PendingAiActionsService,
    @Inject(AI_ACCESS_SWITCHES) private readonly aiAccess: AiAccessSwitches,
  ) {}

  @Get(':id')
  @RequireCapability('work.read')
  async view(
    @Ctx() context: TenantContext,
    @Param('orgSlug') orgSlug: string,
    @Param('id') id: string,
    @AuthScheme() authScheme: string | undefined,
  ): Promise<PendingAiActionView> {
    requireCookieSession(authScheme);
    return this.approvals.view(context, id, orgSlug);
  }

  @Post(':id/approve')
  @RequireCapability('work.read')
  @HttpCode(200)
  async approve(
    @Ctx() context: TenantContext,
    @Param('orgSlug') orgSlug: string,
    @Param('id') id: string,
    @AuthScheme() authScheme: string | undefined,
  ): Promise<PendingAiActionView> {
    requireCookieSession(authScheme);
    // S11: nothing an AI asked for runs while the workspace owner has AI apps turned off.
    if (!(await this.aiAccess.organizationOn(context.organizationId, context.correlationId))) {
      throw aiWorkspaceDisabledError();
    }
    return this.approvals.approve(context, orgSlug, id);
  }

  @Post(':id/decline')
  @RequireCapability('work.read')
  @HttpCode(200)
  async decline(
    @Ctx() context: TenantContext,
    @Param('id') id: string,
    @AuthScheme() authScheme: string | undefined,
  ): Promise<PendingAiActionView> {
    requireCookieSession(authScheme);
    return this.approvals.decline(context, id);
  }
}

/**
 * Run a frozen op in-process: one `fastify.inject` with a one-time internal grant for the
 * approving member and no other credential, so it passes the whole guard chain as that member and
 * is attributed to the AI client that asked (architecture F2/F3, B1/B3).
 */
export function injectExecutor(app: InjectCapable): OpExecutor {
  return async (request, grant, correlationId) => {
    const response = await app.inject({
      method: request.method,
      url: request.url,
      headers: {
        [INTERNAL_GRANT_HEADER]: internalGrants.mint(grant),
        [CORRELATION_HEADER]: correlationId,
        ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(request.body !== undefined ? { payload: request.body } : {}),
    });
    return { status: response.statusCode, body: response.body };
  };
}

@Module({})
export class PendingAiActionsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PENDING_AI_ACTIONS_SERVICE,
      inject: [TENANT_DATABASE, HttpAdapterHost],
      useFactory: (database: TenantDatabase, adapterHost: HttpAdapterHost) =>
        new PendingAiActionsService(database, (request, grant, correlationId) =>
          injectExecutor(adapterHost.httpAdapter.getInstance<InjectCapable>())(
            request,
            grant,
            correlationId,
          ),
        ),
    };
    return {
      module: PendingAiActionsModule,
      providers: [service, aiAccessSwitchesProvider, AiPlatformSwitchGuard],
      exports: [service],
      controllers: [PendingAiActionsController],
    };
  }
}
