import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { parseAiSettingsPatch, requireAiSettingsOwner } from './ai-settings.rules.js';
import type { AiSettingsService, AiSettingsView } from './ai-settings.service.js';

export const AI_SETTINGS_SERVICE = Symbol.for('tmanage.AiSettingsService');

/** The PATCH body (every field optional; the ids are this workspace's memberships). */
export interface AiSettingsPatchBody {
  readonly aiEnabled?: boolean;
  readonly writeScope?: 'read' | 'read_write';
  readonly runAtOnce?: boolean;
  readonly fileReading?: boolean;
  readonly memberSharePercent?: number;
  readonly conversationRetentionDays?: number;
  readonly blockMembershipIds?: readonly string[];
  readonly allowMembershipIds?: readonly string[];
}

/**
 * 62-17 — Settings > AI (Figma G1 v2 `786:48751`), the workspace owner's page.
 *
 * - `GET …/copilot/settings`: the owner's settings, the blocked members, the credits the member
 *   share stands for and the provider line.
 * - `PATCH …/copilot/settings`: change any of them; each change is audited in the same
 *   transaction. Answers the page's new state.
 *
 * Behind `org.manage`, then the owner gate on both routes (403 `copilot.settings:owner`); absent
 * off the test list (404). The workspace is always the session's. Both routes are NEVER entries of
 * the AI registry: the AI can never read or change its own settings.
 */
@Controller('v1/organizations/:orgSlug/copilot/settings')
export class AiSettingsController {
  constructor(@Inject(AI_SETTINGS_SERVICE) private readonly service: AiSettingsService) {}

  @Get()
  @RequireCapability('org.manage')
  read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiSettingsView> {
    requireAiSettingsOwner(principal);
    return this.service.view(context);
  }

  @Patch()
  @RequireCapability('org.manage')
  update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: AiSettingsPatchBody | null,
  ): Promise<AiSettingsView> {
    requireAiSettingsOwner(principal);
    return this.service.update(
      context,
      parseAiSettingsPatch((body ?? null) as Readonly<Record<string, unknown>> | null),
    );
  }
}
