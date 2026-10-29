import { ApiError } from '../../../common/http/errors.js';
import {
  environmentAiDisabled,
  PLATFORM_AI_ACCESS_SETTING,
  platformAiAccessOn,
} from '../../oauth/ai-access.js';
import { requireReason } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import type { PlatformSettingsView, RequestContext } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import { PUBLIC_SIGNUP_SETTING, publicSignupFromSetting } from '../platform-settings.js';

/**
 * Platform admin · Settings — public sign-up and the platform AI kill switch (S11). Moved out of
 * `PlatformAdminService` unchanged (PA-02 split); PA-10 owns it next.
 */
export class PlatformSettingsService {
  constructor(
    private readonly repository: PlatformAdminRepository,
    private readonly publicSignupDefault: boolean,
  ) {}

  async settings(context: RequestContext): Promise<PlatformSettingsView> {
    const stored = await this.repository.readSetting(PUBLIC_SIGNUP_SETTING, context.correlationId);
    const ai = await this.repository.readSetting(PLATFORM_AI_ACCESS_SETTING, context.correlationId);
    return this.settingsView(stored, ai);
  }

  /** S11: turn every AI app off (or back on) for the whole platform. Audited with a reason. */
  async setAiAccess(
    actor: PlatformAdminActor,
    body: { readonly on?: unknown; readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformSettingsView> {
    if (typeof body?.on !== 'boolean') {
      throw new ApiError(400, 'validation_failed', 'Choose on or off.', [
        { field: 'on', message: 'must be a boolean' },
      ]);
    }
    const reason = requireReason(body?.reason);
    await this.repository.writeSetting(
      PLATFORM_AI_ACCESS_SETTING,
      body.on ? 'on' : 'off',
      platformAuditFor(actor, context, {
        action: body.on ? 'platform.ai_access_on' : 'platform.ai_access_off',
        targetType: 'setting',
        targetId: null,
        targetLabel: PLATFORM_AI_ACCESS_SETTING,
        reason,
      }),
    );
    return this.settings(context);
  }

  async setPublicSignup(
    actor: PlatformAdminActor,
    body: { readonly open?: unknown; readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformSettingsView> {
    if (typeof body?.open !== 'boolean') {
      throw new ApiError(400, 'validation_failed', 'Choose open or closed.', [
        { field: 'open', message: 'must be a boolean' },
      ]);
    }
    const reason = requireReason(body?.reason);
    const value = body.open ? 'open' : 'closed';
    await this.repository.writeSetting(
      PUBLIC_SIGNUP_SETTING,
      value,
      platformAuditFor(actor, context, {
        action: body.open ? 'platform.public_signup_opened' : 'platform.public_signup_closed',
        targetType: 'setting',
        targetId: null,
        targetLabel: PUBLIC_SIGNUP_SETTING,
        reason,
      }),
    );
    return this.settings(context);
  }

  private settingsView(stored: string | null, aiStored: string | null): PlatformSettingsView {
    const environmentDisabled = environmentAiDisabled(process.env['TMANAGE_MCP_DISABLED']);
    return {
      aiAccess: {
        on: platformAiAccessOn(aiStored, environmentDisabled),
        environmentDisabled,
      },
      publicSignup: {
        open: publicSignupFromSetting(stored, this.publicSignupDefault),
        source: stored === null ? ('environment' as const) : ('platform_setting' as const),
        environmentDefault: this.publicSignupDefault,
      },
    };
  }
}
