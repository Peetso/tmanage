import { Body, Controller, Get, HttpCode, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PrivacyPreferencesRepository } from './privacy-prefs.repository.js';

export const PRIVACY_PREFERENCES_REPOSITORY = Symbol.for('tmanage.PrivacyPreferencesRepository');

export interface PrivacyPreferencesView {
  /** Whether other people see when the caller is online and when they were last seen. */
  readonly showLastSeen: boolean;
}

/**
 * R7 privacy preferences (F4) — the caller's own "show last seen / online" toggle, default on.
 * No membership in the path: the subject is always the authenticated membership. Behind
 * `conversation.read`, the gate presence itself uses.
 */
@Controller('v1/organizations/:orgSlug/me/privacy-preferences')
export class PrivacyPreferencesController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(PRIVACY_PREFERENCES_REPOSITORY) private readonly store: PrivacyPreferencesRepository,
  ) {}

  @Get()
  @RequireCapability('conversation.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PrivacyPreferencesView> {
    if (principal.kind === 'client') return { showLastSeen: true };
    const showLastSeen = await this.database.read(context, (runner) =>
      this.store.readShowLastSeen(runner, context, principal.membershipId),
    );
    return { showLastSeen };
  }

  @Put()
  @RequireCapability('conversation.read')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<PrivacyPreferencesView> {
    const value = (body as { showLastSeen?: unknown } | null)?.showLastSeen;
    if (typeof value !== 'boolean') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'showLastSeen', message: 'must be a boolean' },
      ]);
    }
    // A client person's membership is not a `memberships` row, so there is nowhere to keep it.
    if (principal.kind === 'client') {
      throw new ApiError(422, 'validation_failed', 'This setting is not available here');
    }
    await this.database.transaction(context, (tx) =>
      this.store.writeShowLastSeen(tx, context, principal.membershipId, value),
    );
    return { showLastSeen: value };
  }
}
