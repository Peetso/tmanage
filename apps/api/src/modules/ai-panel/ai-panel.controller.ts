import {
  Controller,
  Get,
  Inject,
  Module,
  Param,
  Query,
  createParamDecorator,
} from '@nestjs/common';
import type { DynamicModule, ExecutionContext } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { requestState } from '../../common/http/request-state.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import { AiActivityReader } from '../audit/ai-activity.service.js';
import { databaseStanding, tmanageAiStatusReader } from '../copilot/copilot-chat.adapters.js';
import { mayManageAiSettings } from '../copilot/ai-settings.rules.js';
import type { InjectCapable } from '../mcp/mcp-endpoint.controller.js';
import { buildOpRequest, subjectFromBody } from '../mcp/pending-actions.js';
import { injectExecutor } from '../mcp/pending-actions.controller.js';
import { PENDING_AI_ACTIONS_SERVICE } from '../mcp/pending-actions.service.js';
import type { PendingAiActionsService } from '../mcp/pending-actions.service.js';
import { AI_ACCESS_SWITCHES, aiAccessSwitchesProvider } from '../oauth/ai-access.js';
import type { AiAccessSwitches } from '../oauth/ai-access.js';
import { ConnectedAppsService, isAiOwner } from '../oauth/grants.service.js';
import { parseActivityCursor } from './ai-activity.js';
import { AiActivityService } from './ai-activity.service.js';
import type { AiActivityPageView, SubjectNamer } from './ai-activity.service.js';
import { AiPanelService } from './ai-panel.service.js';
import type { AiPanelView } from './ai-panel.service.js';

/**
 * **The AI panel's own API (AI panel with two tabs, Fable 5.2 rulings 2026-11-23).**
 *
 * - `GET /v1/organizations/:orgSlug/ai/panel`: whether TManage AI and the member's own AI are on,
 *   who may turn each on, the member's connected apps and the waiting count ({@link AiPanelView}).
 * - `GET /v1/organizations/:orgSlug/ai/activity?cursor=`: the member's own connected AI's tool
 *   calls, newest first, 20 a page, named under the member's own access ({@link AiActivityPageView}).
 *
 * Both are the member's own, by construction (no parameter widens them), so `ai.use` is enough.
 * Both need a cookie session: an AI app must never read its own activity or the panel's switches.
 * Both are NEVER entries of the AI registry.
 */

export const AI_PANEL_SERVICE = Symbol.for('tmanage.AiPanelService');
export const AI_ACTIVITY_SERVICE = Symbol.for('tmanage.AiActivityService');

interface PanelCaller {
  readonly authScheme: string | undefined;
  readonly role: string | undefined;
}

const CurrentPanelCaller = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PanelCaller => {
    const state = requestState(context.switchToHttp().getRequest<object>());
    return { authScheme: state?.authScheme, role: state?.membership?.role };
  },
);

/** Only a person in a browser session reads the panel and the activity. */
export function requirePanelSession(authScheme: string | undefined): void {
  if (authScheme !== 'cookie') {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      undefined,
      'session_required_for_ai_panel',
    );
  }
}

@Controller('v1/organizations/:orgSlug/ai')
export class AiPanelController {
  constructor(
    @Inject(AI_PANEL_SERVICE) private readonly panel: AiPanelService,
    @Inject(AI_ACTIVITY_SERVICE) private readonly activity: AiActivityService,
  ) {}

  @Get('panel')
  @RequireCapability('ai.use')
  view(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @CurrentPanelCaller() caller: PanelCaller,
  ): Promise<AiPanelView> {
    requirePanelSession(caller.authScheme);
    return this.panel.view(context, {
      mayManageTmanageAi: mayManageAiSettings(principal),
      mayManageOwnAi: isAiOwner(caller.role),
    });
  }

  @Get('activity')
  @RequireCapability('ai.use')
  list(
    @Ctx() context: TenantContext,
    @Param('orgSlug') orgSlug: string,
    @Query('cursor') cursor: unknown,
    @CurrentPanelCaller() caller: PanelCaller,
  ): Promise<AiActivityPageView> {
    requirePanelSession(caller.authScheme);
    return this.activity.page(context, orgSlug, parseActivityCursor(cursor));
  }
}

/** The attribution of the panel's naming reads (never a credential; reads only). */
const PANEL_READER = { clientId: 'tmanage-panel', clientName: 'TManage' } as const;

/**
 * Name one item by running its registry read in-process as the member: one single-use internal
 * grant, the full guard chain, the member's own permissions. Anything but a 200 names nothing.
 */
export function injectSubjectNamer(app: () => InjectCapable): SubjectNamer {
  return async (context, orgSlug, read) => {
    const response = await injectExecutor(app())(
      buildOpRequest(read.op, { ...read.args }, orgSlug),
      {
        grantId: `ai-activity:${context.correlationId}`,
        userId: context.userId,
        membershipId: context.membershipId,
        organizationId: context.organizationId,
        ...PANEL_READER,
        opId: read.op.id,
      },
      context.correlationId,
    );
    return response.status === 200 ? subjectFromBody(response.body) : null;
  };
}

@Module({})
export class AiPanelModule {
  static register(): DynamicModule {
    return {
      module: AiPanelModule,
      providers: [
        aiAccessSwitchesProvider,
        {
          provide: AI_PANEL_SERVICE,
          inject: [TENANT_DATABASE, AI_ACCESS_SWITCHES, PENDING_AI_ACTIONS_SERVICE],
          useFactory: (
            database: TenantDatabase,
            switches: AiAccessSwitches,
            pending: PendingAiActionsService,
          ) => {
            const apps = new ConnectedAppsService(database, switches);
            return new AiPanelService({
              tmanageAi: tmanageAiStatusReader(databaseStanding(database)),
              switches,
              apps: (context) => apps.ownApps(context),
              pendingCount: (context) => pending.countPending(context),
            });
          },
        },
        {
          provide: AI_ACTIVITY_SERVICE,
          inject: [TENANT_DATABASE, AI_ACCESS_SWITCHES, HttpAdapterHost],
          useFactory: (
            database: TenantDatabase,
            switches: AiAccessSwitches,
            host: HttpAdapterHost,
          ) => {
            const apps = new ConnectedAppsService(database, switches);
            return new AiActivityService({
              reader: new AiActivityReader(database),
              clients: (context, clientPks) => apps.clientLabels(context, clientPks),
              namer: injectSubjectNamer(() => host.httpAdapter.getInstance<InjectCapable>()),
            });
          },
        },
      ],
      controllers: [AiPanelController],
    };
  }
}
