import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  createParamDecorator,
} from '@nestjs/common';
import type { DynamicModule, ExecutionContext, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { requestState } from '../../common/http/request-state.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PersonalAccessTokensService } from './personal-access-tokens.service.js';
import type {
  CreatedPersonalAccessTokenView,
  PersonalAccessTokenView,
} from './personal-access-tokens.service.js';

/**
 * The member's own personal access tokens — the Preferences → Security screen's backend.
 *
 * Own tokens only: there is no membership in the path, so the subject is always the
 * authenticated `principal`'s membership and no caller can name another. The capability is
 * `work.read` for the same reason the accessibility and notification preferences use it — it is
 * the one every internal role holds and no client role does, and `12-PERMISSION-MATRIX` names no
 * preferences capability. The real control is here: a member reaches their own tokens and nothing
 * else.
 *
 * Create returns the plaintext token exactly once (`201`); it is never retrievable again. Revoke
 * is a soft revocation (the row survives for the audit trail) and returns `204`.
 *
 * Its own module (registered from `app.module.ts`) so the slice touches no file another slice in
 * the same pass appends to.
 */

const PERSONAL_ACCESS_TOKENS_SERVICE = Symbol.for('tmanage.PersonalAccessTokensService');

/**
 * How `SessionAuthGuard` authenticated this request. Read from the server-set request state (not
 * from the request), so a controller can require a true interactive session for an action that a
 * token must not perform.
 */
const AuthScheme = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    requestState(context.switchToHttp().getRequest())?.authScheme,
);

/**
 * Managing tokens is a session-only action (0202). A personal access token must not create or
 * revoke tokens: that would let a single leaked token mint fresh long-lived credentials, so
 * revoking the leaked one no longer ends the access — a privilege-persistence escalation beyond
 * the member's own interactive reach. The member manages their tokens from the Security screen,
 * behind a real cookie session (and therefore behind CSRF and the full re-auth posture); a token
 * presented on this route is refused with the generic `forbidden`.
 */
function requireInteractiveSession(authScheme: string | undefined): void {
  if (authScheme !== 'cookie') {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      undefined,
      'session_required_for_token_management',
    );
  }
}

interface CreateTokenBody {
  readonly name?: unknown;
  readonly expiresInDays?: unknown;
}

@Controller('v1/organizations/:orgSlug/me/personal-access-tokens')
export class PersonalAccessTokensController {
  constructor(
    @Inject(PERSONAL_ACCESS_TOKENS_SERVICE)
    private readonly tokens: PersonalAccessTokensService,
  ) {}

  /** List the member's own tokens, newest first. No hash, no plaintext. */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly tokens: readonly PersonalAccessTokenView[] }> {
    return { tokens: await this.tokens.list(context, principal) };
  }

  /** Create a token. The response carries the plaintext once; the client must save it then. */
  @Post()
  @RequireCapability('work.read')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateTokenBody,
    @AuthScheme() authScheme: string | undefined,
  ): Promise<CreatedPersonalAccessTokenView> {
    requireInteractiveSession(authScheme);
    const name = typeof body?.name === 'string' ? body.name : undefined;
    if (name === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'name', message: 'must be a string' },
      ]);
    }
    const expiresInDays = parseExpiry(body?.expiresInDays);
    return this.tokens.create(context, principal, { name, expiresInDays });
  }

  /** Revoke one of the member's own tokens. Unknown, foreign, or already-revoked is a 404. */
  @Delete(':tokenId')
  @RequireCapability('work.read')
  @HttpCode(204)
  async revoke(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('tokenId') tokenId: string,
    @AuthScheme() authScheme: string | undefined,
  ): Promise<void> {
    requireInteractiveSession(authScheme);
    if (typeof tokenId !== 'string' || tokenId === '') {
      throw new ApiError(400, 'validation_failed', 'tokenId is required', [
        { field: 'tokenId', message: 'must be a non-empty string' },
      ]);
    }
    await this.tokens.revoke(context, principal, tokenId);
  }
}

/** `expiresInDays` is optional; absent or null means "never expires". Anything else must be a number. */
function parseExpiry(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'expiresInDays', message: 'must be a number of days, or null' },
    ]);
  }
  return raw;
}

/**
 * The module's wiring — a self-contained module registered from `app.module.ts`, file-disjoint
 * from the other slices in the pass. The service needs only the tenant database injected; it
 * resolves the acting membership from the context and never from the body.
 */
@Module({})
export class PersonalAccessTokensModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PERSONAL_ACCESS_TOKENS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new PersonalAccessTokensService(database),
    };
    return {
      module: PersonalAccessTokensModule,
      providers: [service],
      controllers: [PersonalAccessTokensController],
    };
  }
}
