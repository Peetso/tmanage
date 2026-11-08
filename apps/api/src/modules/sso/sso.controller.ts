import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Module,
  Post,
  Put,
  Query,
  Redirect,
  Req,
  Res,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, Public, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  clientAddressKey,
  createFixedWindowLimiter,
  type RequestAdmission,
} from '../../common/http/rate-limiter.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { API_CONFIG, AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import { openPendingMfa, sealPendingMfa } from '../google-auth/google-oidc.js';
import { CredentialsRepository } from '../identity/credentials.repository.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import { SessionService } from '../identity/session.service.js';
import { expireCookie, readCookie, serializeCookie } from '../identity/session-token.js';
import { SsoEnforcedSignInPolicyGate } from './sso-enforcement.js';
import {
  SSO_COOKIE_PATH,
  SSO_FLOW_COOKIE,
  SSO_FLOW_TTL_SECONDS,
  SSO_MFA_COOKIE,
  SsoTokenRejectedError,
  openSsoFlow,
  sealSsoFlow,
  ssoStateMatches,
} from './sso-oidc.js';
import {
  SAML_FLOW_COOKIE,
  SAML_FLOW_TTL_SECONDS,
  SamlRejectedError,
  openSamlFlow,
  samlRelayStateMatches,
  samlSpMetadata,
  sealSamlFlow,
} from './sso-saml.js';
import { SsoService, type SsoConnectionView, type SsoOutcome } from './sso.service.js';
import { createSsoTransport, type SsoTransport } from './sso-transport.js';

/** DI tokens, co-located with the slice (ADR-0003). */
export const SSO_SERVICE = Symbol.for('tmanage.SsoService');
export const SSO_SESSIONS = Symbol.for('tmanage.SsoSessions');
export const SSO_HTTP_OPTIONS = Symbol.for('tmanage.SsoHttpOptions');
export const SSO_ADMISSION = Symbol.for('tmanage.SsoAdmission');

export interface SsoHttpOptions {
  readonly sessionSecret: string;
  readonly secureCookies: boolean;
}

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

interface ReplyLike {
  header(name: string, value: string | readonly string[]): unknown;
}

/** Wire bodies (contracts-check pairs these with apps/web/src/lib/api/sso.ts). */
export interface SsoStartView {
  readonly url: string;
}

export interface SsoPendingMfaView {
  readonly status: 'mfa_required';
  readonly challengeToken: string;
  readonly expiresAt: string;
  readonly factors: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
  }[];
  readonly returnTo: string;
}

function headerOf(request: RequestLike, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 54-14 — company sign-in, the owner's settings. `org.security.manage` at the route, the company
 * owner in the service (others holding the capability are refused). Withheld from the AI action
 * registry like the sign-in policy.
 *
 * - `GET    …/security/sso` — the connection (never the secret) and the redirect URL to register.
 * - `PUT    …/security/sso` — `{issuer, clientId, clientSecret?, allowedDomains, enforce, autoJoin}`.
 * - `DELETE …/security/sso` — remove the connection and its secret.
 */
@Controller('v1/organizations/:orgSlug/security/sso')
export class SsoSettingsController {
  constructor(@Inject(SSO_SERVICE) private readonly service: SsoService) {}

  @Get()
  @RequireCapability('org.security.manage')
  read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SsoConnectionView> {
    return this.service.read(context, principal);
  }

  @Put()
  @RequireCapability('org.security.manage')
  save(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<SsoConnectionView> {
    return this.service.save(context, principal, body);
  }

  @Delete()
  @RequireCapability('org.security.manage')
  remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SsoConnectionView> {
    return this.service.remove(context, principal);
  }
}

/**
 * 54-14 — company sign-in, the browser flow.
 *
 * - `POST /v1/auth/sso/start` `{email}` → `{url}`; 404 when no single organization lists the
 *   address's domain. Sets the signed flow cookie (organization, state, nonce, PKCE verifier).
 * - `GET  /v1/auth/sso/callback` — the provider's redirect: state against the cookie, code
 *   exchange with the verifier, ID token checks, then the membership rule. Every failure
 *   redirects to `/sign-in?sso_error=<code>`; nothing secret goes in a URL.
 * - `POST /v1/auth/sso/mfa` — the parked second-factor challenge, handed over once.
 * - 54-15: `POST /v1/auth/sso/saml/acs` (the IdP's HTTP-POST Response) and
 *   `GET /v1/auth/sso/saml/metadata` (the SP metadata). `start` answers the IdP URL with the
 *   AuthnRequest when the organization's connection speaks SAML.
 */
@Controller('v1/auth/sso')
export class SsoSignInController {
  constructor(
    @Inject(SSO_SERVICE) private readonly service: SsoService,
    @Inject(SSO_SESSIONS) private readonly sessions: SessionService,
    @Inject(SSO_HTTP_OPTIONS) private readonly options: SsoHttpOptions,
    @Inject(SSO_ADMISSION) private readonly admit: RequestAdmission,
  ) {}

  @Post('start')
  @Public()
  @HttpCode(200)
  async start(
    @Body() body: { readonly email?: unknown } | undefined,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<SsoStartView> {
    if (!this.admit(clientAddressKey(request.ip))) {
      throw new ApiError(
        429,
        'rate_limited',
        'Too many attempts. Wait a few minutes and try again.',
      );
    }
    const correlationId = requireRequestState(request).correlationId;
    let started: Awaited<ReturnType<SsoService['start']>>;
    try {
      started = await this.service.start(body?.email, correlationId);
    } catch (error) {
      console.error('[sso] start failed', error instanceof Error ? error.name : 'unknown');
      throw new ApiError(409, 'conflict', 'The company sign-in provider could not be reached.');
    }
    if (!started) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    if (started.samlFlow) {
      reply.header(
        'set-cookie',
        serializeCookie(
          SAML_FLOW_COOKIE,
          sealSamlFlow(started.samlFlow, this.options.sessionSecret),
          {
            path: SSO_COOKIE_PATH,
            maxAgeSeconds: SAML_FLOW_TTL_SECONDS,
            // The IdP answers with a cross-site POST, which a Lax cookie does not ride. Plain-HTTP
            // development cannot set None, so there the ACS refuses for want of the cookie.
            sameSite: this.options.secureCookies ? 'None' : 'Lax',
            secure: this.options.secureCookies,
          },
        ),
      );
      return { url: started.url };
    }
    reply.header(
      'set-cookie',
      serializeCookie(SSO_FLOW_COOKIE, sealSsoFlow(started.flow, this.options.sessionSecret), {
        path: SSO_COOKIE_PATH,
        maxAgeSeconds: SSO_FLOW_TTL_SECONDS,
        // Lax, not Strict: the provider's redirect back is a cross-site top-level GET.
        sameSite: 'Lax',
        secure: this.options.secureCookies,
      }),
    );
    return { url: started.url };
  }

  /**
   * 54-15 — the SAML Assertion Consumer Service (HTTP-POST binding). The RelayState must match
   * the signed flow cookie before the Response is looked at; then the full verification
   * (`verifySamlResponse`), the one-time request and Assertion IDs, and the same membership,
   * policy and second-factor rules as the OIDC callback. Every failure is a 303 to
   * `/sign-in?sso_error=<code>`.
   */
  @Post('saml/acs')
  @Public()
  @Redirect('/sign-in', 303)
  async samlAcs(
    @Body() body: Record<string, unknown> | undefined,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<{ url: string; statusCode: number }> {
    const correlationId = requireRequestState(request).correlationId;
    const cookies: string[] = [this.expireSaml()];
    const finish = (url: string) => {
      reply.header('set-cookie', cookies);
      return { url, statusCode: 303 };
    };
    const fail = (code: string) => finish(`/sign-in?sso_error=${encodeURIComponent(code)}`);
    const context = {
      ip: request.ip ?? null,
      userAgent: headerOf(request, 'user-agent') ?? null,
      correlationId,
    };
    if (!this.admit(clientAddressKey(request.ip))) return fail('failed');
    const flow = openSamlFlow(
      readCookie(headerOf(request, 'cookie'), SAML_FLOW_COOKIE),
      this.options.sessionSecret,
      Math.floor(Date.now() / 1000),
    );
    if (!flow || !samlRelayStateMatches(flow, body?.['RelayState'])) {
      await this.service.record(context, null, 'failed', 'sso_bad_state');
      return fail('state');
    }
    try {
      const verified = await this.service.verifySaml(flow, body?.['SAMLResponse'], correlationId);
      if (!verified) return fail('not_set_up');
      const outcome = await this.service.complete(verified.connection, verified.claims, context);
      return await this.land(outcome, context, cookies, finish, fail);
    } catch (error) {
      if (error instanceof SamlRejectedError) {
        await this.service.record(context, null, 'failed', `saml_${error.reason}`);
        return fail('token');
      }
      console.error('[sso] saml acs failed', error instanceof Error ? error.name : 'unknown');
      return fail('failed');
    }
  }

  /** 54-15 — the SP metadata an owner gives the IdP (also the SP entity ID). */
  @Get('saml/metadata')
  @Public()
  @Header('content-type', 'application/samlmetadata+xml; charset=utf-8')
  samlMetadata(): string {
    return samlSpMetadata({ entityId: this.service.spEntityId(), acsUrl: this.service.acsUrl() });
  }

  @Get('callback')
  @Public()
  @Redirect('/sign-in', 302)
  async callback(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<{ url: string; statusCode: number }> {
    const correlationId = requireRequestState(request).correlationId;
    const cookies: string[] = [this.expire(SSO_FLOW_COOKIE)];
    const finish = (url: string) => {
      reply.header('set-cookie', cookies);
      return { url, statusCode: 302 };
    };
    const fail = (code: string) => finish(`/sign-in?sso_error=${encodeURIComponent(code)}`);
    const context = {
      ip: request.ip ?? null,
      userAgent: headerOf(request, 'user-agent') ?? null,
      correlationId,
    };
    const flow = openSsoFlow(
      readCookie(headerOf(request, 'cookie'), SSO_FLOW_COOKIE),
      this.options.sessionSecret,
    );
    // State first: without a cookie whose state matches, nothing else is looked at.
    if (!flow || !ssoStateMatches(flow, query['state'])) {
      await this.service.record(context, null, 'failed', 'sso_bad_state');
      return fail('state');
    }
    if (typeof query['code'] !== 'string' || query['code'] === '') return fail('cancelled');

    try {
      const verified = await this.service.verify(flow, query['code'], correlationId);
      if (!verified) return fail('not_set_up');
      const outcome = await this.service.complete(verified.connection, verified.claims, context);
      return await this.land(outcome, context, cookies, finish, fail);
    } catch (error) {
      if (error instanceof SsoTokenRejectedError) {
        await this.service.record(context, null, 'failed', `sso_${error.reason}`);
        return fail(error.reason === 'email_unverified' ? 'unverified' : 'token');
      }
      console.error('[sso] callback failed', error instanceof Error ? error.name : 'unknown');
      return fail('failed');
    }
  }

  @Post('mfa')
  @Public()
  @HttpCode(200)
  pendingMfa(
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): SsoPendingMfaView {
    const pending = openPendingMfa(
      readCookie(headerOf(request, 'cookie'), SSO_MFA_COOKIE),
      this.options.sessionSecret,
    );
    reply.header('set-cookie', this.expire(SSO_MFA_COOKIE));
    if (!pending) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return { status: 'mfa_required', ...pending };
  }

  /** The outcome of either protocol: a refusal, the parked second factor, or a session. */
  private async land<T>(
    outcome: SsoOutcome,
    context: { readonly userAgent: string | null; readonly correlationId: string },
    cookies: string[],
    finish: (url: string) => T,
    fail: (code: string) => T,
  ): Promise<T> {
    if (outcome.kind === 'refused') return fail(outcome.reason);
    if (outcome.kind === 'mfa') {
      cookies.push(
        serializeCookie(
          SSO_MFA_COOKIE,
          sealPendingMfa(outcome.pending, this.options.sessionSecret),
          {
            path: SSO_COOKIE_PATH,
            maxAgeSeconds: 300,
            sameSite: 'Lax',
            secure: this.options.secureCookies,
          },
        ),
      );
      return finish('/sign-in?sso=mfa');
    }
    const established = await this.sessions.start({
      userId: outcome.userId,
      userAgent: context.userAgent,
      correlationId: context.correlationId,
    });
    cookies.push(...established.cookies);
    return finish(outcome.returnTo);
  }

  private expireSaml(): string {
    return expireCookie(SAML_FLOW_COOKIE, {
      path: SSO_COOKIE_PATH,
      sameSite: this.options.secureCookies ? 'None' : 'Lax',
      secure: this.options.secureCookies,
    });
  }

  private expire(name: string): string {
    return expireCookie(name, {
      path: SSO_COOKIE_PATH,
      sameSite: 'Lax',
      secure: this.options.secureCookies,
    });
  }
}

/**
 * Always registered: with no connection saved, `start` answers 404 and the sign-in screen says
 * company sign-in is not set up for that address. Nothing reaches a provider until an owner saves
 * one, and no secret can be saved without `FIELD_CIPHER_KEYS`.
 */
@Module({})
export class SsoModule {
  static register(transport: SsoTransport = createSsoTransport()): DynamicModule {
    const service: Provider = {
      provide: SSO_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, API_CONFIG],
      useFactory: (database: TenantDatabase, audit: AuditService, config: ApiConfig) =>
        new SsoService({
          database,
          audit,
          transport,
          cipher: createFieldCipher(loadFieldCipherKeyring(process.env)),
          credentials: new CredentialsRepository(createSeedCipher(config.mfaSeedKeys)),
          sessionSecret: config.sessionSecret,
          webPublicUrl: config.webPublicUrl ?? '',
          signInPolicy: new SsoEnforcedSignInPolicyGate(database),
        }),
    };
    const sessions: Provider = {
      provide: SSO_SESSIONS,
      inject: [TENANT_DATABASE, API_CONFIG],
      useFactory: (database: TenantDatabase, config: ApiConfig) =>
        new SessionService(database, config),
    };
    const options: Provider = {
      provide: SSO_HTTP_OPTIONS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): SsoHttpOptions => ({
        sessionSecret: config.sessionSecret,
        secureCookies: config.secureCookies,
      }),
    };
    const admission: Provider = {
      provide: SSO_ADMISSION,
      useFactory: () => createFixedWindowLimiter({ windowMs: 10 * 60 * 1000, max: 30 }),
    };
    return {
      module: SsoModule,
      providers: [service, sessions, options, admission],
      controllers: [SsoSettingsController, SsoSignInController],
    };
  }
}
