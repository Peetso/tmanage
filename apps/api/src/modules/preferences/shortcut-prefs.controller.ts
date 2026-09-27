import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { SHORTCUT_PREFS_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ShortcutPrefsRepository } from './shortcut-prefs.repository.js';
import { isKnownActionKey, isValidChord, resolveShortcuts } from './shortcut-prefs.service.js';
import type { ResolvedShortcutView } from './shortcut-prefs.service.js';

/**
 * PRF keyboard shortcuts (x286, module 20 Preferences & accessibility) — the caller's own overrides
 * of the command-palette keyboard chords, read, rebound, and reset. Complements the built command
 * palette (x181): an override always names an action from that palette's fixed registry.
 *
 * ## Own overrides only, and the capability reused rather than invented
 *
 * There is no membership in the path: the subject is the authenticated `principal`'s membership, so
 * no caller can read, rebind, or reset another member's shortcut — the request has no way to name one.
 * The capability is **`work.read`**, the same choice and reason the sibling preferences slices
 * (x182/x183/x215) made: `12-PERMISSION-MATRIX` names no preferences capability, `work.read` is the
 * one every internal role holds and no client role does, and pass-22 forbids editing
 * `capabilities.ts`. The control that matters is here: a member reads and writes their own rows and
 * nothing else, and the store's writes are scoped to the caller's membership.
 *
 * ## The action allowlist and the chord grammar are the write's gate
 *
 * A PUT names an `actionKey` in the path and carries a `{ chord }` body. The action must be a command
 * id in the palette's registry (else 400, no upsert) and the chord must match the fixed grammar (else
 * 400, no upsert). A DELETE resets one action to its default by removing the caller's own row; it is
 * idempotent (204 whether or not a row existed). A GET returns the resolved map: every registry action
 * with its shipped default overlaid by the caller's overrides.
 */

/** What `GET .../me/shortcuts` returns: the resolved map plus the raw stored overrides. */
export interface ShortcutMapView {
  readonly shortcuts: readonly ResolvedShortcutView[];
}

/** What a PUT returns: the one action's resolved state after the rebind. */
export interface ShortcutView {
  readonly actionKey: string;
  readonly chord: string;
}

@Controller('v1/organizations/:orgSlug/me/shortcuts')
export class ShortcutPrefsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(SHORTCUT_PREFS_REPOSITORY) private readonly repository: ShortcutPrefsRepository,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShortcutMapView> {
    const rows = await this.database.read(context, (runner) =>
      this.repository.listForMembership(runner, context, principal.membershipId),
    );
    const overrides = new Map(rows.map((row) => [row.actionKey, row.chord] as const));
    return { shortcuts: resolveShortcuts(overrides) };
  }

  @Put(':actionKey')
  @RequireCapability('work.read')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('actionKey') actionKey: string,
    @Body() body: unknown,
  ): Promise<ShortcutView> {
    // The action must be one the palette declares — an unknown key is the client's error, not a row
    // the store should ever hold. Validated before any write, so a 400 leaves nothing behind.
    if (!isKnownActionKey(actionKey)) {
      throw new ApiError(400, 'validation_failed', 'The keyboard-shortcut request is invalid', [
        { field: 'actionKey', message: 'is not a known command-palette action' },
      ]);
    }
    const chord = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    if (!isValidChord(chord['chord'])) {
      throw new ApiError(400, 'validation_failed', 'The keyboard-shortcut request is invalid', [
        { field: 'chord', message: 'must be zero or more modifiers plus one key (e.g. Ctrl+K)' },
      ]);
    }
    const value = chord['chord'];
    await this.database.transaction(context, (tx) =>
      this.repository.upsert(tx, context, principal.membershipId, actionKey, value),
    );
    return { actionKey, chord: value };
  }

  @Delete(':actionKey')
  @RequireCapability('work.read')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('actionKey') actionKey: string,
  ): Promise<void> {
    // A reset of an unknown action is a no-op success, not a 400: DELETE is idempotent and the caller
    // is only ever clearing their own row, so there is nothing to validate a name against.
    await this.database.transaction(context, (tx) =>
      this.repository.remove(tx, context, principal.membershipId, actionKey),
    );
  }
}
