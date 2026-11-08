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
  Req,
  Res,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { ApiConfig } from '../../../common/http/api-config.js';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { CurrentSession, NoTenant, Public } from '../../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import {
  clientAddressKey,
  createFixedWindowLimiter,
  type RequestAdmission,
} from '../../../common/http/rate-limiter.js';
import { requireRequestState } from '../../../common/http/request-state.js';
import { API_CONFIG, TENANT_DATABASE } from '../../../common/http/tokens.js';
import { assertSignInOpen } from '../../platform/maintenance.controller.js';
import { REAUTH_HEADER, requireCookieSession } from '../authentication.controller.js';
import {
  ReauthenticationRequiredError,
  signInMethodNotAllowed,
} from '../authentication.service.js';
import { CredentialsRepository } from '../credentials.repository.js';
import { SessionIntelReader } from '../geo/session-intel.service.js';
import { createSeedCipher } from '../seed-cipher.js';
import { SessionService, type AuthenticatedSession } from '../session.service.js';
import { SsoEnforcedSignInPolicyGate } from '../../sso/sso-enforcement.js';
import { notifyIfNewDevice } from './new-device-notice.js';
import {
  PasskeyPolicyRefusedError,
  PasskeyRejectedError,
  PasskeysService,
  type AssertionBody,
  type AttestationBody,
} from './passkeys.service.js';
import type { SecurityScoreView } from './security-score.js';
import { relyingPartyFrom } from './relying-party.js';

export const PASSKEYS_SERVICE = Symbol.for('tmanage.PasskeysService');
export const PASSKEY_SESSIONS = Symbol.for('tmanage.PasskeySessions');
export const PASSKEY_ADMISSION = Symbol.for('tmanage.PasskeyAdmission');

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

interface ReplyLike {
  header(name: string, value: string | readonly string[]): unknown;
}

export interface PasskeyView {
  readonly id: string;
  readonly name: string;
  readonly backedUp: boolean;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

/** One row of the security page's device list: device, browser, country only, last seen. */
export interface SecurityDeviceView {
  readonly id: string;
  readonly current: boolean;
  readonly browser: string | null;
  readonly os: string | null;
  readonly deviceType: string;
  readonly country: string | null;
  readonly countryCode: string | null;
  readonly lastSeenAt: string;
}

function header(request: RequestLike, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function contextOf(request: RequestLike, correlationId: string) {
  return {
    correlationId,
    ip: request.ip ?? null,
    userAgent: header(request, 'user-agent') ?? null,
  };
}

/** The refusals, translated. A passkey refusal never says why on the wire. */
function translate(error: unknown): never {
  if (error instanceof ReauthenticationRequiredError) {
    throw new ApiError(
      403,
      'reauthentication_required',
      'Confirm your password to make this change.',
      undefined,
      error.reason,
    );
  }
  if (error instanceof PasskeyPolicyRefusedError) throw signInMethodNotAllowed(error.refusal);
  if (error instanceof PasskeyRejectedError) {
    throw new ApiError(
      401,
      'unauthenticated',
      MESSAGES.unauthenticated,
      undefined,
      `passkey_${error.reason}`,
    );
  }
  throw error;
}

/**
 * 56-22. The person's own passkeys, devices and security score — cookie sessions only (F01), and
 * every route acts on the session's own user.
 */
@Controller('v1/auth')
export class PasskeysController {
  private readonly intel: SessionIntelReader;

  constructor(
    @Inject(PASSKEYS_SERVICE) private readonly passkeys: PasskeysService,
    @Inject(PASSKEY_SESSIONS) private readonly sessions: SessionService,
    @Inject(TENANT_DATABASE) database: TenantDatabase,
  ) {
    this.intel = new SessionIntelReader(database);
  }

  @Get('passkeys')
  @NoTenant()
  async list(
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: RequestLike,
  ): Promise<{ passkeys: readonly PasskeyView[] }> {
    const state = requireCookieSession(request);
    const rows = await this.passkeys.list(session.userId, state.correlationId);
    return {
      passkeys: rows.map((row) => ({
        id: row.id,
        name: row.name,
        backedUp: row.backedUp,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      })),
    };
  }

  @Post('passkeys/options')
  @NoTenant()
  @HttpCode(200)
  async registrationOptions(
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: RequestLike,
  ) {
    const state = requireCookieSession(request);
    return this.passkeys
      .registrationOptions({
        userId: session.userId,
        sessionId: session.sessionId,
        correlationId: state.correlationId,
      })
      .catch(translate);
  }

  @Post('passkeys')
  @NoTenant()
  @HttpCode(201)
  async register(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: AttestationBody,
    @Req() request: RequestLike,
  ): Promise<{ id: string }> {
    const state = requireCookieSession(request);
    return this.passkeys
      .register({
        userId: session.userId,
        sessionId: session.sessionId,
        reauthToken: header(request, REAUTH_HEADER),
        body: body ?? {},
        context: contextOf(request, state.correlationId),
      })
      .catch((error: unknown) => {
        if (error instanceof PasskeyRejectedError) {
          throw new ApiError(
            400,
            'validation_failed',
            'That passkey could not be added.',
            [{ field: 'credential', message: 'not accepted' }],
            `passkey_${error.reason}`,
          );
        }
        return translate(error);
      });
  }

  @Delete('passkeys/:passkeyId')
  @NoTenant()
  @HttpCode(204)
  async remove(
    @CurrentSession() session: AuthenticatedSession,
    @Param('passkeyId') passkeyId: string,
    @Req() request: RequestLike,
  ): Promise<void> {
    const state = requireCookieSession(request);
    const removed = await this.passkeys
      .remove({
        userId: session.userId,
        sessionId: session.sessionId,
        passkeyId,
        reauthToken: header(request, REAUTH_HEADER),
        context: contextOf(request, state.correlationId),
      })
      .catch(translate);
    if (!removed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
  }

  @Get('security-score')
  @NoTenant()
  async score(
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: RequestLike,
  ): Promise<SecurityScoreView> {
    const state = requireCookieSession(request);
    return this.passkeys.securityScore(session.userId, state.correlationId);
  }

  /** The device list for the security page; sign-out reuses `DELETE /v1/sessions[/:id]`. */
  @Get('security-devices')
  @NoTenant()
  async devices(
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: RequestLike,
  ): Promise<{ devices: readonly SecurityDeviceView[] }> {
    const state = requireCookieSession(request);
    const rows = await this.sessions.listForUser({
      userId: session.userId,
      correlationId: state.correlationId,
    });
    const intel = await this.intel.forSessions(
      state.correlationId,
      rows.map((row) => ({ ...row, lastSeenAt: row.rotatedAt ?? row.createdAt })),
    );
    const devices = rows.map((row): SecurityDeviceView => {
      const view = intel.get(row.id);
      return {
        id: row.id,
        current: row.id === session.sessionId,
        browser: view?.device.browser ?? null,
        os: view?.device.os ?? null,
        deviceType: view?.device.deviceType ?? 'unknown',
        // Country only: never the city, region or address on this screen.
        country: view?.location?.country ?? null,
        countryCode: view?.location?.countryCode ?? null,
        lastSeenAt: (row.rotatedAt ?? row.createdAt).toISOString(),
      };
    });
    devices.sort(
      (a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.localeCompare(a.lastSeenAt),
    );
    return { devices };
  }
}

/** The public half: the challenge and the assertion that starts a session. */
@Controller('v1/auth/passkey')
export class PasskeySignInController {
  constructor(
    @Inject(PASSKEYS_SERVICE) private readonly passkeys: PasskeysService,
    @Inject(PASSKEY_SESSIONS) private readonly sessions: SessionService,
    @Inject(PASSKEY_ADMISSION) private readonly admit: RequestAdmission,
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post('options')
  @Public()
  @HttpCode(200)
  options(@Req() request: RequestLike) {
    this.gate(request);
    return this.passkeys.signInOptions();
  }

  @Post()
  @Public()
  @HttpCode(200)
  async signIn(
    @Body() body: AssertionBody,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<{ status: 'authenticated'; csrfToken: string; expiresAt: string }> {
    this.gate(request);
    const state = requireRequestState(request);
    const context = contextOf(request, state.correlationId);
    const { userId } = await this.passkeys.signIn({ body: body ?? {}, context }).catch(translate);
    await assertSignInOpen(this.database, this.config.platformAdminEmails ?? [], {
      userId,
      acceptLanguage: request.headers['accept-language'],
      correlationId: state.correlationId,
    });
    const established = await this.sessions.start({
      userId,
      userAgent: context.userAgent,
      correlationId: state.correlationId,
      linkSignInEvent: true,
    });
    await notifyIfNewDevice(this.database, {
      userId,
      sessionId: established.sessionId,
      userAgent: context.userAgent,
      correlationId: state.correlationId,
    });
    reply.header('set-cookie', established.cookies);
    return {
      status: 'authenticated',
      csrfToken: established.csrfToken,
      expiresAt: established.expiresAt.toISOString(),
    };
  }

  private gate(request: RequestLike): void {
    if (!this.admit(clientAddressKey(request.ip))) {
      throw new ApiError(
        429,
        'rate_limited',
        'Too many attempts. Wait a few minutes and try again.',
      );
    }
  }
}

@Module({})
export class PasskeysModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PASSKEYS_SERVICE,
      inject: [TENANT_DATABASE, API_CONFIG],
      useFactory: (database: TenantDatabase, config: ApiConfig) =>
        new PasskeysService(
          database,
          new CredentialsRepository(createSeedCipher(config.mfaSeedKeys)),
          {
            sessionSecret: config.sessionSecret,
            rp: relyingPartyFrom(config.webPublicUrl),
            signInPolicy: new SsoEnforcedSignInPolicyGate(database),
          },
        ),
    };
    const sessions: Provider = {
      provide: PASSKEY_SESSIONS,
      inject: [TENANT_DATABASE, API_CONFIG],
      useFactory: (database: TenantDatabase, config: ApiConfig) =>
        new SessionService(database, config),
    };
    const admission: Provider = {
      provide: PASSKEY_ADMISSION,
      useFactory: () => createFixedWindowLimiter({ windowMs: 10 * 60 * 1000, max: 60 }),
    };
    return {
      module: PasskeysModule,
      providers: [service, sessions, admission],
      controllers: [PasskeysController, PasskeySignInController],
    };
  }
}
