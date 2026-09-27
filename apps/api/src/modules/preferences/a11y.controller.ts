import { Body, Controller, Get, HttpCode, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { A11Y_PREFERENCES_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import { A11Y_FONT_SCALES } from '../../common/database/schema.js';
import type { A11yFontScale, A11yPreferences } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { A11yPreferencesRepository } from './a11y.repository.js';

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
 * Validation is here rather than in the store because a malformed body is the client's error to be
 * told about (400), not a state the store should ever hold: an unknown key, a font scale off the
 * closed vocabulary, or a non-boolean toggle is a 400 and nothing is written.
 */

/** What the GET/PUT route exchanges: the three accessibility settings, without row identity. */
export interface A11yPreferencesView {
  readonly fontScale: A11yFontScale;
  readonly reduceMotion: boolean;
  readonly highContrast: boolean;
}

/** The shipped defaults an unsaved member is reached by: medium type, motion and contrast normal. */
export const DEFAULT_A11Y_PREFERENCES: A11yPreferencesView = {
  fontScale: 'md',
  reduceMotion: false,
  highContrast: false,
};

/** The only keys a PUT body may carry — anything else is a 400 (fixed-key allowlist). */
const ALLOWED_KEYS: ReadonlySet<string> = new Set(['fontScale', 'reduceMotion', 'highContrast']);

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
    return row ? viewOf(row.a11yJson) : DEFAULT_A11Y_PREFERENCES;
  }

  @Put()
  @RequireCapability('work.read')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<A11yPreferencesView> {
    const settings = parseInput(body);
    return this.database.transaction(context, async (tx) => {
      await this.preferences.upsert(tx, context, principal.membershipId, settings);
      const row = await this.preferences.findForMembership(tx, context, principal.membershipId);
      return row ? viewOf(row.a11yJson) : viewOf(settings);
    });
  }
}

function viewOf(settings: A11yPreferences): A11yPreferencesView {
  return {
    fontScale: settings.fontScale,
    reduceMotion: settings.reduceMotion,
    highContrast: settings.highContrast,
  };
}

function parseInput(body: unknown): A11yPreferences {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  // Fixed-key allowlist: a key the store has no column for is the client's error, not a silent drop.
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      details.push({ field: key, message: 'is not a known preference' });
    }
  }

  const scale = value['fontScale'];
  if (!(A11Y_FONT_SCALES as readonly unknown[]).includes(scale)) {
    details.push({
      field: 'fontScale',
      message: `must be one of ${A11Y_FONT_SCALES.join(', ')}`,
    });
  }

  const bool = (field: string): boolean => {
    const raw = value[field];
    if (typeof raw !== 'boolean') {
      details.push({ field, message: 'must be a boolean' });
      return false;
    }
    return raw;
  };

  const reduceMotion = bool('reduceMotion');
  const highContrast = bool('highContrast');

  if (details.length > 0) {
    throw new ApiError(
      400,
      'validation_failed',
      'The accessibility preferences are invalid',
      details,
    );
  }

  return { fontScale: scale as A11yFontScale, reduceMotion, highContrast };
}
