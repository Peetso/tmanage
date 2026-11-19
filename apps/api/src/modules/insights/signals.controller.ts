import { Body, Controller, Get, Inject, Module, Put } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import { RequireFeature } from '../admin/feature-gate.js';
import type { AuditService } from '../audit/audit.service.js';
import { SignalSettingsRepository } from './signals.repository.js';
import { SignalSettingsService } from './signals.service.js';
import type { SignalSettingsView } from './signals.service.js';

/** DI token for the signal settings service (registered through {@link SignalSettingsModule}). */
export const SIGNAL_SETTINGS_SERVICE = Symbol.for('tmanage.SignalSettingsService');

/**
 * 62-27 (B05) — Settings → Alerts, two routes under
 * `/v1/organizations/:orgSlug/insights/signal-settings`:
 *
 * - **GET** every rule the owner may see, with its setting, unit, limits and recipient choices.
 * - **PUT** `{ rules: [{ rule, enabled, threshold, recipient }] }` saves the listed rules whole
 *   (400 with no write on any bad field) and returns the new list.
 *
 * `org.manage` is the pipeline's capability floor; the service then admits the company owner
 * only. The whole controller exists only while the organization's `business_briefing` flag is on
 * (off is the calm 404 of `feature-gate.ts`).
 */
@Controller('v1/organizations/:orgSlug/insights/signal-settings')
@RequireFeature('business_briefing')
export class SignalSettingsController {
  constructor(@Inject(SIGNAL_SETTINGS_SERVICE) private readonly settings: SignalSettingsService) {}

  @Get()
  @RequireCapability('org.manage')
  read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SignalSettingsView> {
    return this.settings.read(context, principal);
  }

  @Put()
  @RequireCapability('org.manage')
  update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<SignalSettingsView> {
    return this.settings.update(context, principal, body);
  }
}

/** The wiring: registered from `app.module.ts` as `SignalSettingsModule.register()`. */
@Module({})
export class SignalSettingsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: SIGNAL_SETTINGS_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new SignalSettingsService({ database, audit, repository: new SignalSettingsRepository() }),
    };
    return {
      module: SignalSettingsModule,
      providers: [service],
      controllers: [SignalSettingsController],
    };
  }
}
