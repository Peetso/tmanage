import { Body, Controller, Get, HttpCode, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { PORTAL_A11Y_PREFERENCES_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { A11yPreferencesView } from './a11y-preferences.js';
import type { PortalA11yPreferencesService } from './portal-a11y.service.js';

/**
 * PORTALA11Y — the client portal's "Display and accessibility" settings: the signed-in client's
 * own text size, high contrast and reduced motion. Under `/portal` like every client surface, behind
 * `client_projection.read` (the one capability every client role holds); the service confines the
 * subject to the caller's own client membership.
 */
@Controller('v1/organizations/:orgSlug/portal/me/accessibility')
export class PortalA11yPreferencesController {
  constructor(
    @Inject(PORTAL_A11Y_PREFERENCES_SERVICE)
    private readonly service: PortalA11yPreferencesService,
  ) {}

  @Get()
  @RequireCapability('client_projection.read')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<A11yPreferencesView> {
    return this.service.read(context, principal);
  }

  @Put()
  @RequireCapability('client_projection.read')
  @HttpCode(200)
  put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<A11yPreferencesView> {
    return this.service.replace(context, principal, body);
  }
}
