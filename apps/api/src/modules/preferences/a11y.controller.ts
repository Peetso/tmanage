import { Body, Controller, Get, HttpCode, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { A11Y_PREFERENCES_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { A11yPreferencesRepository } from './a11y.repository.js';
import { DEFAULT_A11Y_PREFERENCES, a11yViewOf, parseA11yPreferences } from './a11y-preferences.js';
import type { A11yPreferencesView } from './a11y-preferences.js';

/**
 * A11Y-183 accessibility preferences — the caller's own settings, read and replaced (module 20
 * Preferences & accessibility, x183).
 *
 * ## Own settings only, and the capability reused rather than invented
 *
 * There is no membership in the path: the subject is the authenticated `principal`'s membership,
 * so no caller can read or write another member's settings — the request has no way to name one.
 * The capability is **`work.read`**, the same choice and for the same reason NOTIF-001's
 * preferences made: `12-PERMISSION-MATRIX` names no preferences capability, `work.read` is the one
 * every internal role holds and no client role does, and adding an `a11y.write` would put a word in
 * the ceiling table the matrix does not have (and pass-21 forbids editing `capabilities.ts`). The
 * control that matters is here, not in the coarse guard: a member reads and writes their own row
 * and nothing else.
 *
 * ## PUT is a full replacement over a fixed-key allowlist
 *
 * The body carries every setting and the upsert stores exactly it — a partial PUT would make
 * "unset" and "set to the default" indistinguishable, and the screen sends the whole form.
 * Validation (the shared `a11y-preferences.ts`, which the portal route uses too) runs before the
 * store because a malformed body is the client's error to be told about (400), not a state the store should ever hold: an unknown key, a font scale off the
 * closed vocabulary, or a non-boolean toggle is a 400 and nothing is written.
 */

// Re-exported: the e2e shape contract and the route tests import them from the route.
export { DEFAULT_A11Y_PREFERENCES };
export type { A11yPreferencesView };

@Controller('v1/organizations/:orgSlug/me/accessibility')
export class A11yPreferencesController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(A11Y_PREFERENCES_REPOSITORY)
    private readonly preferences: A11yPreferencesRepository,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<A11yPreferencesView> {
    const row = await this.database.read(context, (runner) =>
      this.preferences.findForMembership(runner, context, principal.membershipId),
    );
    return row ? a11yViewOf(row.a11yJson) : DEFAULT_A11Y_PREFERENCES;
  }

  @Put()
  @RequireCapability('work.read')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<A11yPreferencesView> {
    const settings = parseA11yPreferences(body);
    return this.database.transaction(context, async (tx) => {
      await this.preferences.upsert(tx, context, principal.membershipId, settings);
      const row = await this.preferences.findForMembership(tx, context, principal.membershipId);
      return row ? a11yViewOf(row.a11yJson) : a11yViewOf(settings);
    });
  }
}
