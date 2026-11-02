import { Body, Controller, Get, HttpCode, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { DISPLAY_PREFERENCES_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { DisplayPreferencesService, DisplayPreferencesView } from './display-prefs.service.js';

/**
 * PREF-DISPLAY display-preferences hub (x285, module 20 Preferences & accessibility).
 *
 * One place for a member to set the app's display behaviour — theme, density, locale, timezone and
 * date format — and read it back. The screen links out to the notification, accessibility and
 * quiet-hours preferences rather than re-implementing them; this route owns only the five display
 * settings.
 *
 * ## Own settings only, behind `work.read`
 *
 * There is no membership in the path: the subject is the authenticated `principal`'s membership, so
 * no caller can read or write another member's settings — the request has no way to name one. Both
 * routes sit behind `work.read`, the internal-read capability A11Y-183's preferences reuse (module
 * 20, and pass-25 forbids inventing a capability). Validation and the closed vocabularies live in
 * {@link DisplayPreferencesService}.
 *
 * ## 55-04 (R20-c): Simple / Power mode rides on the same two routes
 *
 * The body may carry `uiMode` (`simple` | `power`; absent = inherit the org default) and the GET
 * returns the effective `uiMode`, `uiModeSource` and `uiModeLocked`. The caller's `principal.role`
 * is passed so the service can apply the org's `ui_mode_locked_roles`: a locked role sending a mode
 * other than the org default is refused 409 (detail `ui_mode_locked`) with nothing written. Personal mode is
 * self-service under the unchanged `work.read`; the org default and the lock are `org.manage`
 * through the existing `PUT …/settings/:key` (keys `default_ui_mode`, `ui_mode_locked_roles`). The
 * mode changes no capability. No route was added.
 */
@Controller('v1/organizations/:orgSlug/me/display-preferences')
export class DisplayPreferencesController {
  constructor(
    @Inject(DISPLAY_PREFERENCES_SERVICE) private readonly service: DisplayPreferencesService,
  ) {}

  @Get()
  @RequireCapability('work.read')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DisplayPreferencesView> {
    return this.service.read(context, principal.membershipId, principal.role);
  }

  @Put()
  @RequireCapability('work.read')
  @HttpCode(200)
  put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<DisplayPreferencesView> {
    return this.service.replace(context, principal.membershipId, principal.role, body);
  }
}
