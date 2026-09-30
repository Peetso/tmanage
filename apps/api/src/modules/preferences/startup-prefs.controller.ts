import { Body, Controller, Get, HttpCode, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { STARTUP_PREFS_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { LandingKey } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DEFAULT_LANDING_KEY, parseStartupInput } from './startup-prefs.service.js';
import type { StartupPrefsRepository } from './startup-prefs.repository.js';

/**
 * PREF-STARTUP default startup landing view — the caller's own choice of which screen the app opens
 * to on sign-in, read and replaced (module 20 Preferences & accessibility, x287).
 *
 * ## Own preference only, and the capability reused rather than invented
 *
 * There is no membership in the path (`/me/startup`): the subject is the authenticated `principal`'s
 * membership, so no caller can read or write another member's preference — the request has no way to
 * name one. The capability is **`work.read`**, the same choice and reason the sibling preferences
 * slices (x183/x215) made: `12-PERMISSION-MATRIX` names no preferences capability, `work.read` is the
 * one every internal role holds and no client role does, and pass-25 forbids editing
 * `capabilities.ts`. The control that matters is here: a member reads and writes their own row and
 * nothing else.
 *
 * ## PUT is a full replacement over a closed vocabulary
 *
 * The body carries the one setting and the upsert stores exactly it. Validation is in the service
 * rather than the store because a malformed body is the client's error to be told about (400), not a
 * state the store should ever hold: an unknown key or a `landingKey` off the allowlist (e.g.
 * `payroll`) is a 400 and nothing is written. Absence of a row reads the shipped default (`home`), so
 * "never saved" and "saved home" are one behaviour.
 */

/** What the GET/PUT route exchanges: the chosen landing destination, without row identity. */
export interface StartupPrefView {
  readonly landingKey: LandingKey;
}

@Controller('v1/organizations/:orgSlug/me/startup')
export class StartupPrefsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(STARTUP_PREFS_REPOSITORY) private readonly preferences: StartupPrefsRepository,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StartupPrefView> {
    const row = await this.database.read(context, (runner) =>
      this.preferences.findForMembership(runner, context, principal.membershipId),
    );
    return { landingKey: row ? row.landingKey : DEFAULT_LANDING_KEY };
  }

  @Put()
  @RequireCapability('work.read')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<StartupPrefView> {
    const landingKey = parseStartupInput(body);
    return this.database.transaction(context, async (tx) => {
      await this.preferences.upsert(tx, context, principal.membershipId, landingKey);
      const row = await this.preferences.findForMembership(tx, context, principal.membershipId);
      return { landingKey: row ? row.landingKey : landingKey };
    });
  }
}
