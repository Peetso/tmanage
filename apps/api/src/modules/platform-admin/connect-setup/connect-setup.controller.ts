import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformAdminCore } from '../platform-admin-core.module.js';
import { PlatformAdminGuard, PlatformStepUpExempt } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import { connectSetupView, type ConnectSetupView } from './connect-setup.js';

/**
 * `GET /v1/platform/connect-setup` — R37, the data behind the owner's "Set it up" checklist and its
 * "Check again" button on Connected apps: which providers have their keys on the server and the
 * public return addresses to register. Booleans and public URLs only, never a secret.
 *
 * Platform owner only (`platform.settings.edit`). Exempt from the 15-minute step-up because it
 * reveals nothing sensitive and the owner reaches it from a workspace screen, not Platform admin.
 */
@Controller('v1/platform/connect-setup')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformConnectSetupController {
  @Get()
  @RequirePlatformPermission('platform.settings.edit')
  @PlatformStepUpExempt()
  read(): ConnectSetupView {
    return connectSetupView(process.env);
  }
}

/** R37 · a platform area module (listed in `platform-admin.areas.ts`). */
@Module({})
export class PlatformConnectSetupModule {
  static register(): DynamicModule {
    return {
      module: PlatformConnectSetupModule,
      imports: [platformAdminCore()],
      controllers: [PlatformConnectSetupController],
    };
  }
}
