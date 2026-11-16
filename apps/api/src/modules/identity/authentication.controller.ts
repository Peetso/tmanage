import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { CurrentSession, NoTenant, Public } from '../../common/http/decorators.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { AUTHENTICATION_SERVICE, SESSION_SERVICE } from '../../common/http/tokens.js';
// ---- platform-admin v2 · PA-10 ---- (the maintenance sign-in gate)
import { API_CONFIG, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { assertSignInOpen } from '../platform/maintenance.controller.js';
import type { AuthenticatedSession, SessionService } from './session.service.js';
import {
  AuthenticationRejectedError,
  EmailFactorUnavailableError,
  FreshSignInRequiredError,
  PasswordRejectedError,
  ReauthenticationRequiredError,
  type AuthenticationService,
  type EmailCodeSentView,
  type EmailFactorStartedView,
  type EnrolledFactorView,
} from './authentication.service.js';
import { describePasswordRejection } from './password.js';
import { RESET_SIGN_IN_GRANT_COOKIE, RESET_SIGN_IN_GRANT_PATH } from './reset-sign-in-grant.js';
import { expireCookie, readCookie } from './session-token.js';
import { countRecentAttemptsByIp } from './credentials.repository.js';
import { IP_INTELLIGENCE } from './geo/geo.module.js';
import type { IpIntelligenceService } from './geo/ip-intelligence.service.js';
import { parseClientSignals, scoreAutomation } from './geo/automation-signal.js';
import { notifyIfNewDevice } from './passkeys/new-device-notice.js';

/**
 * `D05`. The header a credential-changing request carries its re-authentication token in.
 *
 * A header rather than a body field, for the same reason the CSRF token is one:
 * `DELETE /factors/:id` has no body to put it in, and one convention across the five routes
 * is one thing for a client to get right.
 */
export const REAUTH_HEADER = 'x-reauth-token';

/**
 * ID-002's HTTP surface — `22-SCREEN-BY-SCREEN` §3's `ID-01`, `ID-02` and the enrolment half
 * of `ID-05`.
 *
 * Two controllers, split by whether the caller is already authenticated:
 *
 *   * {@link AuthenticationController} is `@Public()`. Its three routes are the only
 *     unauthenticated write endpoints in the application, and each of them ends either in a
 *     session or in one indistinguishable refusal.
 *   * {@link CredentialsController} requires a session. Setting a password, enrolling a
 *     factor and regenerating recovery codes are things a person does to their own account
 *     while signed in.
 *
 * Both are `@NoTenant()`: these are about the person, not about an organization, so there is
 * no `:orgSlug` to resolve and no capability to check. `ID-04` is the screen where an
 * organization is chosen, and it comes after all of this.
 *
 * ## Why the failures are shaped the way they are
 *
 * `AuthenticationService` raises `AuthenticationRejectedError` carrying two values: a coarse
 * `rejection` for the caller and a precise `reason` for the log. This controller maps the
 * first and discards the second — it never reaches the response, and it never reaches a
 * message. `ApiError`'s `auditCode` parameter carries it into the log instead, which is the
 * same arrangement `MembershipResolver` and `SessionService` already use.
 *
 * The one deliberate exception is `rate_limited` → **429**. It does tell an attacker that the
 * account exists, and it is still right: `22` §3's `ID-02` specifies a rate-limited state on
 * the screen, and a person who has locked themselves out needs to be told that waiting is the
 * fix rather than being sent round the password loop again.
 */

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

interface ReplyLike {
  header(name: string, value: string | readonly string[]): unknown;
}

function cookieHeaderOf(request: RequestLike): string | undefined {
  const raw = request.headers['cookie'];
  return Array.isArray(raw) ? raw.join('; ') : raw;
}

interface PasswordSignInBody {
  readonly email?: unknown;
  readonly password?: unknown;
  /**
   * R12 (D3). What the sign-in page reports about itself — `{webdriver, formMs, keystrokes,
   * hints}`. Validated field by field; a bad value is ignored, never a 400.
   */
  readonly client?: unknown;
}

/** R12 (D3 `rate_high`): attempts from one address counted over the last ten minutes. */
const RATE_WINDOW_SECONDS = 600;

interface ChallengeBody {
  readonly challengeToken?: unknown;
  readonly code?: unknown;
  /** MFAOPTIONS: `'email'` for a mailed code; anything else is an authenticator code. */
  readonly method?: unknown;
}

interface EmailCodeBody {
  readonly challengeToken?: unknown;
}

interface ConfirmEmailFactorBody {
  readonly factorId?: unknown;
  readonly code?: unknown;
}

/**
 * MFAOPTIONS. Turning the e-mail method on was refused before a code was sent: **409 `conflict`**,
 * one detail naming the reason (`email_not_verified`, `already_enabled`, `mail_unavailable`) so
 * the security screen can say what to do. Only ever reached by the signed-in owner.
 */
function emailFactorConflict(error: EmailFactorUnavailableError): ApiError {
  return new ApiError(
    409,
    'conflict',
    'E-mail codes cannot be turned on right now.',
    [{ field: 'reason', message: error.reason }],
    error.reason,
  );
}

interface SetPasswordBody {
  readonly password?: unknown;
}

interface ReauthenticateBody {
  readonly password?: unknown;
  readonly code?: unknown;
}

interface BeginEnrolmentBody {
  readonly label?: unknown;
  readonly accountName?: unknown;
}

interface ConfirmEnrolmentBody {
  readonly factorId?: unknown;
  readonly code?: unknown;
}

/** The shape both completion routes return, and what `POST /password` returns on success. */
export interface EstablishedView {
  readonly status: 'authenticated';
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export interface ChallengeResponseView {
  readonly status: 'mfa_required';
  readonly challengeToken: string;
  readonly expiresAt: string;
  readonly factors: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
  }[];
}

/** MFAOPTIONS. The account address an e-mail code goes to (masked) and whether it is verified. */
export interface FactorMailContactView {
  readonly address: string;
  readonly verified: boolean;
}

/** `GET /v1/auth/factors`: the methods, the backup codes left, and the e-mail contact. */
export interface FactorsView {
  readonly factors: readonly EnrolledFactorView[];
  readonly recoveryCodesRemaining: number;
  readonly email: FactorMailContactView;
}

@Controller('v1/auth')
export class AuthenticationController {
  constructor(
    @Inject(AUTHENTICATION_SERVICE) private readonly authentication: AuthenticationService,
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService,
    // ---- platform-admin v2 · PA-10 ---- optional so the controller still builds without them
    @Optional() @Inject(TENANT_DATABASE) private readonly database?: TenantDatabase,
    @Optional() @Inject(API_CONFIG) private readonly config?: ApiConfig,
    // R12. Optional like the two above: a suite that builds the controller without `GeoModule`
    // signs in with no automation signal and no IP cache row.
    @Optional() @Inject(IP_INTELLIGENCE) private readonly ipIntelligence?: IpIntelligenceService,
  ) {}

  /**
   * `ID-01`. Email and password.
   *
   * `@HttpCode(200)` rather than 201 even when it creates a session, because the two possible
   * outcomes — a session, or a challenge — are both answers to "what happens next" and a
   * client that branched on the status code as well as the body would have two things to keep
   * in agreement.
   */
  @Post('password')
  @Public()
  @HttpCode(200)
  async signInWithPassword(
    @Body() body: PasswordSignInBody,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<EstablishedView | ChallengeResponseView> {
    const state = requireRequestState(request);
    const email = typeof body?.email === 'string' ? body.email : undefined;
    const password = typeof body?.password === 'string' ? body.password : undefined;

    if (!email || !password) {
      // A shape error, not a credential error. Saying "email is required" reveals nothing
      // about any account, so this one is allowed to be specific.
      throw new ApiError(400, 'validation_failed', 'email and password are required', [
        ...(email ? [] : [{ field: 'email', message: 'must be a string' }]),
        ...(password ? [] : [{ field: 'password', message: 'must be a string' }]),
      ]);
    }

    // N01 (wave 11). The reset sign-in grant travels only in its own `HttpOnly` cookie, scoped to
    // this route. Any attempt that presents it clears it, whatever the outcome - the header is
    // set before the attempt runs so a refusal carries it too - and the first succeeded sign-in
    // row spends it server-side as well, so a copy kept elsewhere is no use either.
    const resetGrant = readCookie(cookieHeaderOf(request), RESET_SIGN_IN_GRANT_COOKIE);
    if (resetGrant !== undefined) {
      reply.header(
        'set-cookie',
        expireCookie(RESET_SIGN_IN_GRANT_COOKIE, {
          path: RESET_SIGN_IN_GRANT_PATH,
          sameSite: 'Lax',
          secure: true,
        }),
      );
    }

    const context = {
      ...this.contextOf(request, state.correlationId),
      automation: await this.automationOf(body?.client, request, state.correlationId),
    };
    try {
      const outcome = await this.run(() =>
        this.authentication.signInWithPassword({ email, password, context, resetGrant }),
      );

      if (outcome.status === 'authenticated') {
        return await this.establish(outcome.userId, request, reply, state.correlationId);
      }

      return {
        status: 'mfa_required',
        challengeToken: outcome.challengeToken,
        expiresAt: outcome.expiresAt.toISOString(),
        factors: outcome.factors,
      };
    } finally {
      // R12. After the attempt's own transactions, whatever the outcome; `record` never throws.
      void this.ipIntelligence?.record(request.ip, state.correlationId);
    }
  }

  /**
   * R12 (D3). The automation signal stamped on this attempt's events. Best effort: a failing
   * count is treated as zero attempts, and nothing here can refuse the sign-in.
   */
  private async automationOf(
    rawClient: unknown,
    request: RequestLike,
    correlationId: string,
  ): Promise<{ score: number; reasons: readonly string[]; clientHints: string | null }> {
    const client = parseClientSignals(rawClient);
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : null;
    };
    const chUa = header('sec-ch-ua');
    const clientHints = [chUa, client?.hints].filter((v): v is string => !!v).join(' | ') || null;
    const network = this.ipIntelligence?.classify(request.ip) ?? null;
    let recent = 0;
    if (this.database && network && network.networkKind !== 'local') {
      recent = await this.database
        .identityRead({ correlationId, tables: ['authentication_events'] }, (db) =>
          countRecentAttemptsByIp(db, network.ip, RATE_WINDOW_SECONDS),
        )
        .catch(() => 0);
    }
    const signal = scoreAutomation({
      userAgent: header('user-agent'),
      clientHints,
      acceptLanguage: header('accept-language'),
      client,
      hostingIp: network?.networkKind === 'hosting',
      torIp: network?.isTor ?? false,
      recentAttemptsFromIp: recent,
    });
    return { score: signal.score, reasons: signal.reasons, clientHints };
  }

  /** `ID-02`. A code from an authenticator. */
  @Post('mfa')
  @Public()
  @HttpCode(200)
  async completeMfa(
    @Body() body: ChallengeBody,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<EstablishedView> {
    const state = requireRequestState(request);
    const outcome = await this.run(() =>
      this.authentication.completeMfaChallenge({
        challengeToken: typeof body?.challengeToken === 'string' ? body.challengeToken : undefined,
        code: typeof body?.code === 'string' ? body.code : '',
        // MFAOPTIONS. Which kind of code; the service accepts only a method the person holds.
        method: body?.method === 'email' ? 'email' : 'totp',
        context: this.contextOf(request, state.correlationId),
      }),
    );
    return this.establish(outcome.userId, request, reply, state.correlationId);
  }

  /**
   * MFAOPTIONS. Mail a code that finishes this sign-in challenge — "Get a code by e-mail". Needs a
   * valid challenge token (the password step passed); refused with the sign-in's 401 otherwise,
   * and 429 inside the 30-second pause or past five sends an hour.
   */
  @Post('mfa/email-code')
  @Public()
  @HttpCode(200)
  async sendEmailCode(
    @Body() body: EmailCodeBody,
    @Req() request: RequestLike,
  ): Promise<EmailCodeSentView> {
    const state = requireRequestState(request);
    try {
      return await this.run(() =>
        this.authentication.sendSignInEmailCode({
          challengeToken:
            typeof body?.challengeToken === 'string' ? body.challengeToken : undefined,
          context: this.contextOf(request, state.correlationId),
        }),
      );
    } catch (error) {
      if (error instanceof EmailFactorUnavailableError) throw emailFactorConflict(error);
      throw error;
    }
  }

  /** `ID-02`'s "Enter a recovery code" fallback. */
  @Post('recovery-code')
  @Public()
  @HttpCode(200)
  async completeWithRecoveryCode(
    @Body() body: ChallengeBody,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<EstablishedView> {
    const state = requireRequestState(request);
    const outcome = await this.run(() =>
      this.authentication.completeWithRecoveryCode({
        challengeToken: typeof body?.challengeToken === 'string' ? body.challengeToken : undefined,
        code: typeof body?.code === 'string' ? body.code : '',
        context: this.contextOf(request, state.correlationId),
      }),
    );
    return this.establish(outcome.userId, request, reply, state.correlationId);
  }

  // ───────────────────────────────────────────────────────────────────────────

  /** Start the session and set its cookies. The one place this controller creates one. */
  private async establish(
    userId: string,
    request: RequestLike,
    reply: ReplyLike,
    correlationId: string,
  ): Promise<EstablishedView> {
    // ---- platform-admin v2 · PA-10 ---- maintenance with "block sign-in": only platform admins
    // get a session; everyone else sees the maintenance message. Checked before the session exists.
    if (this.database) {
      await assertSignInOpen(this.database, this.config?.platformAdminEmails ?? [], {
        userId,
        acceptLanguage: request.headers['accept-language'],
        correlationId,
      });
    }
    const userAgent = request.headers['user-agent'];
    const established = await this.sessions.start({
      userId,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
      correlationId,
      // R12 (0280): `sessions.sign_in_event_id` = this request's succeeded sign-in row.
      linkSignInEvent: true,
    });
    // 56-22. "A new device signed in" on the credential-notice outbox; best effort, never throws.
    if (this.database) {
      await notifyIfNewDevice(this.database, {
        userId,
        sessionId: established.sessionId,
        userAgent: typeof userAgent === 'string' ? userAgent : null,
        correlationId,
      });
    }
    reply.header('set-cookie', established.cookies);
    return {
      status: 'authenticated',
      csrfToken: established.csrfToken,
      expiresAt: established.expiresAt.toISOString(),
    };
  }

  /**
   * Run one authentication step and translate its refusal.
   *
   * The `reason` is passed as `ApiError`'s `auditCode` and is never serialised, so the
   * response is identical for an unknown email, a wrong password and a spent recovery code.
   */
  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AuthenticationRejectedError) {
        if (error.rejection === 'rate_limited') {
          throw new ApiError(
            429,
            'rate_limited',
            'Too many attempts. Wait a few minutes and try again.',
            undefined,
            error.reason,
          );
        }
        throw new ApiError(
          401,
          'unauthenticated',
          MESSAGES.unauthenticated,
          undefined,
          error.reason,
        );
      }
      throw error;
    }
  }

  private contextOf(request: RequestLike, correlationId: string) {
    const userAgent = request.headers['user-agent'];
    return {
      correlationId,
      ip: request.ip ?? null,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
    };
  }
}

/**
 * F01 (wave 9). The request state, refusing anything but a cookie session.
 *
 * A personal access token or an AI grant is bound to one organization and must never manage the
 * person's credentials: these routes are `@NoTenant()`, so the token's organization binding is
 * never applied here, and a token that could set a first password, re-authenticate, enrol a
 * factor or end sessions would turn itself into control of the whole account. Refused with **403
 * `forbidden`**, audit code `session_required_for_credentials`. `CsrfGuard` refuses the same
 * schemes on these routes and on `v1/sessions`; this is the controller's own copy of the rule, so
 * it holds even if the guard chain is ever composed differently.
 */
export function requireCookieSession(request: object): ReturnType<typeof requireRequestState> {
  const state = requireRequestState(request);
  if (state.authScheme !== 'cookie') {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      undefined,
      'session_required_for_credentials',
    );
  }
  return state;
}

/**
 * The enrolment routes. Every one of them requires a **cookie** session (F01) and acts on that
 * session's own user — no route here takes a `userId`, so there is no id to tamper with.
 */
@Controller('v1/auth')
export class CredentialsController {
  constructor(
    @Inject(AUTHENTICATION_SERVICE) private readonly authentication: AuthenticationService,
  ) {}

  /**
   * `D05`. Re-present the password (and the code, when a factor exists) from inside a live
   * session, and receive the short-lived token the five credential-changing routes require.
   *
   * The refusal is the same 401 sign-in gives, with the same discipline: whether a factor
   * exists is not disclosed by the response. The session itself is untouched either way.
   */
  @Post('reauth')
  @NoTenant()
  @HttpCode(200)
  async reauthenticate(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: ReauthenticateBody,
    @Req() request: RequestLike,
  ): Promise<{ reauthToken: string; expiresAt: string }> {
    const state = requireCookieSession(request);
    const password = typeof body?.password === 'string' ? body.password : undefined;
    if (!password) {
      throw new ApiError(400, 'validation_failed', 'password is required', [
        { field: 'password', message: 'must be a string' },
      ]);
    }

    try {
      const minted = await this.authentication.confirmReauthentication({
        userId: session.userId,
        sessionId: session.sessionId,
        password,
        code: typeof body?.code === 'string' ? body.code : undefined,
        context: this.contextOf(request, state.correlationId),
      });
      return { reauthToken: minted.reauthToken, expiresAt: minted.expiresAt.toISOString() };
    } catch (error) {
      if (error instanceof AuthenticationRejectedError) {
        if (error.rejection === 'rate_limited') {
          throw new ApiError(
            429,
            'rate_limited',
            'Too many attempts. Wait a few minutes and try again.',
            undefined,
            error.reason,
          );
        }
        throw new ApiError(
          401,
          'unauthenticated',
          MESSAGES.unauthenticated,
          undefined,
          error.reason,
        );
      }
      throw error;
    }
  }

  /**
   * Set or change this person's password.
   *
   * The rejections are returned in full, which is the opposite of every other route in this
   * file and is right here: the person is authenticated, the subject is their own password,
   * and they cannot fix it without being told what is wrong with it.
   *
   * `D05`: changing an existing password needs the `x-reauth-token` header; setting the first
   * one needs a fresh sign-in on this session (F01, wave 9). The service decides which case this
   * is.
   */
  @Post('password/set')
  @NoTenant()
  @HttpCode(204)
  async setPassword(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: SetPasswordBody,
    @Req() request: RequestLike,
  ): Promise<void> {
    const state = requireCookieSession(request);
    const password = typeof body?.password === 'string' ? body.password : undefined;
    if (!password) {
      throw new ApiError(400, 'validation_failed', 'password is required', [
        { field: 'password', message: 'must be a string' },
      ]);
    }

    try {
      await this.authentication.setPassword({
        userId: session.userId,
        sessionId: session.sessionId,
        password,
        reauthToken: this.reauthTokenOf(request),
        context: this.contextOf(request, state.correlationId),
      });
    } catch (error) {
      this.translateReauth(error);
      if (error instanceof FreshSignInRequiredError) {
        // F01: a first password needs a sign-in from the last few minutes on this session. 401
        // with this code (not `unauthenticated`), so the web client does not try a refresh; the
        // Preferences screen asks the person to sign in with Google again and retry.
        throw new ApiError(
          401,
          'reauthentication_required',
          'Sign in again, then set your password.',
          undefined,
          'reauth_required',
        );
      }
      if (error instanceof PasswordRejectedError) {
        throw new ApiError(
          422,
          'validation_failed',
          'That password cannot be used.',
          error.rejections.map((rejection) => ({
            field: 'password',
            message: describePasswordRejection(rejection),
          })),
          error.remoteScreenUnavailable ? 'breach_screen_unavailable' : undefined,
        );
      }
      throw error;
    }
  }

  /**
   * Begin TOTP enrolment.
   *
   * The response carries the secret, which is the only time it leaves the server readable —
   * a person whose camera will not read the QR code has to be able to type it. The factor
   * authorises nothing until it is confirmed.
   *
   * `D05`: needs the `x-reauth-token` header, like `/confirm` below and like the other three
   * credential-changing routes. See {@link AuthenticationService.beginTotpEnrolment} for why
   * both halves of the enrolment carry the gate and which of the two is load-bearing.
   */
  @Post('factors/totp')
  @NoTenant()
  @HttpCode(201)
  async beginTotpEnrolment(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: BeginEnrolmentBody,
    @Req() request: RequestLike,
  ): Promise<{ factorId: string; secret: string; uri: string }> {
    const state = requireCookieSession(request);
    try {
      return await this.authentication.beginTotpEnrolment({
        userId: session.userId,
        sessionId: session.sessionId,
        label: typeof body?.label === 'string' && body.label !== '' ? body.label : 'Authenticator',
        // The label an authenticator app shows. Falls back to the user id rather than to an
        // email the session does not carry — `AuthenticatedSession` holds no address, and
        // fetching one here to make the QR code prettier would put a user read on this path.
        accountName:
          typeof body?.accountName === 'string' && body.accountName !== ''
            ? body.accountName
            : session.userId,
        reauthToken: this.reauthTokenOf(request),
        context: this.contextOf(request, state.correlationId),
      });
    } catch (error) {
      this.translateReauth(error);
      throw error;
    }
  }

  /**
   * Confirm the factor with a code, and receive the recovery codes once.
   *
   * `D05`: needs the `x-reauth-token` header. This is the route the third clause of the
   * finding was about — confirming replaces the account's recovery codes and hands the new
   * set back, so a live session on its own must not be able to reach it.
   */
  @Post('factors/totp/confirm')
  @NoTenant()
  @HttpCode(200)
  async confirmTotpEnrolment(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: ConfirmEnrolmentBody,
    @Req() request: RequestLike,
  ): Promise<{ recoveryCodes: readonly string[] }> {
    const state = requireCookieSession(request);
    const factorId = typeof body?.factorId === 'string' ? body.factorId : undefined;
    const code = typeof body?.code === 'string' ? body.code : undefined;
    if (!factorId || !code) {
      throw new ApiError(400, 'validation_failed', 'factorId and code are required', [
        ...(factorId ? [] : [{ field: 'factorId', message: 'must be a string' }]),
        ...(code ? [] : [{ field: 'code', message: 'must be a string' }]),
      ]);
    }

    try {
      return await this.authentication.confirmTotpFactor({
        userId: session.userId,
        sessionId: session.sessionId,
        factorId,
        code,
        reauthToken: this.reauthTokenOf(request),
        context: this.contextOf(request, state.correlationId),
      });
    } catch (error) {
      this.translateReauth(error);
      if (error instanceof AuthenticationRejectedError) {
        // One answer for a wrong code and for someone else's factor id, so the route cannot
        // be used to discover whether a factor exists.
        throw new ApiError(
          400,
          'validation_failed',
          'That code did not match.',
          [{ field: 'code', message: 'That code did not match.' }],
          error.reason,
        );
      }
      throw error;
    }
  }

  /** The factors this person holds. No secrets, ever. */
  @Get('factors')
  @NoTenant()
  async listFactors(
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: RequestLike,
  ): Promise<FactorsView> {
    const state = requireCookieSession(request);
    const [factors, recoveryCodesRemaining, email] = await Promise.all([
      this.authentication.listFactors({
        userId: session.userId,
        correlationId: state.correlationId,
      }),
      this.authentication.countUsableRecoveryCodes({
        userId: session.userId,
        correlationId: state.correlationId,
      }),
      // MFAOPTIONS. The masked address an e-mail code would go to, and whether it is verified.
      this.authentication.describeMailContact({
        userId: session.userId,
        correlationId: state.correlationId,
      }),
    ]);

    return {
      factors: factors.map((factor) => ({
        id: factor.id,
        kind: factor.kind,
        label: factor.label,
        confirmedAt: factor.confirmedAt?.toISOString() ?? null,
        isDefault: factor.isDefault,
      })),
      recoveryCodesRemaining,
      email,
    };
  }

  /**
   * MFAOPTIONS. Begin turning the e-mail method on: mails a code to the account's verified
   * address. `D05`: needs the `x-reauth-token` header. 409 when the address is not verified or
   * the method is already on; 429 inside the resend pause.
   */
  @Post('factors/email')
  @NoTenant()
  @HttpCode(201)
  async beginEmailFactor(
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: RequestLike,
  ): Promise<EmailFactorStartedView> {
    const state = requireCookieSession(request);
    try {
      return await this.authentication.beginEmailFactor({
        userId: session.userId,
        sessionId: session.sessionId,
        reauthToken: this.reauthTokenOf(request),
        context: this.contextOf(request, state.correlationId),
      });
    } catch (error) {
      this.translateReauth(error);
      if (error instanceof EmailFactorUnavailableError) throw emailFactorConflict(error);
      if (error instanceof AuthenticationRejectedError && error.rejection === 'rate_limited') {
        throw new ApiError(
          429,
          'rate_limited',
          'Wait a moment before asking for another code.',
          undefined,
          error.reason,
        );
      }
      throw error;
    }
  }

  /**
   * MFAOPTIONS. Finish turning the e-mail method on with the mailed code; returns new backup
   * codes once when the person had none left (otherwise an empty list). `D05`: reauth header.
   */
  @Post('factors/email/confirm')
  @NoTenant()
  @HttpCode(200)
  async confirmEmailFactor(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: ConfirmEmailFactorBody,
    @Req() request: RequestLike,
  ): Promise<{ recoveryCodes: readonly string[] }> {
    const state = requireCookieSession(request);
    const factorId = typeof body?.factorId === 'string' ? body.factorId : undefined;
    const code = typeof body?.code === 'string' ? body.code : undefined;
    if (!factorId || !code) {
      throw new ApiError(400, 'validation_failed', 'factorId and code are required', [
        ...(factorId ? [] : [{ field: 'factorId', message: 'must be a string' }]),
        ...(code ? [] : [{ field: 'code', message: 'must be a string' }]),
      ]);
    }
    try {
      return await this.authentication.confirmEmailFactor({
        userId: session.userId,
        sessionId: session.sessionId,
        factorId,
        code,
        reauthToken: this.reauthTokenOf(request),
        context: this.contextOf(request, state.correlationId),
      });
    } catch (error) {
      this.translateReauth(error);
      if (error instanceof AuthenticationRejectedError) {
        throw new ApiError(
          400,
          'validation_failed',
          'That code did not match.',
          [{ field: 'code', message: 'That code did not match.' }],
          error.reason,
        );
      }
      throw error;
    }
  }

  /**
   * MFAOPTIONS. Make one of this person's methods the one a sign-in asks for first. `D05`: reauth
   * header. 404 for an id that is not one of their live, confirmed methods.
   */
  @Post('factors/:factorId/default')
  @NoTenant()
  @HttpCode(204)
  async setDefaultFactor(
    @CurrentSession() session: AuthenticatedSession,
    @Param('factorId') factorId: string,
    @Req() request: RequestLike,
  ): Promise<void> {
    const state = requireCookieSession(request);
    let changed: boolean;
    try {
      changed = await this.authentication.setDefaultFactor({
        userId: session.userId,
        sessionId: session.sessionId,
        factorId,
        reauthToken: this.reauthTokenOf(request),
        context: this.contextOf(request, state.correlationId),
      });
    } catch (error) {
      this.translateReauth(error);
      throw error;
    }
    if (!changed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
  }

  /**
   * `D05d`. What has been done to this account's credentials, newest first — `ID-05`'s
   * "security event receipt", and the answer to "were my recovery codes replaced, and when".
   *
   * `@NoTenant()` like the rest of this controller: credentials are not tenant-owned, so
   * neither is their history. The session's own `userId` and no parameter — there is no shape
   * of this request that names somebody else.
   *
   * Not behind `x-reauth-token`, unlike every route above that *changes* something. The
   * service header carries the argument: this is what a worried person opens, and it tells a
   * session holder only about actions that session holder performed.
   */
  @Get('security-activity')
  @NoTenant()
  async listCredentialChanges(
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: RequestLike,
  ): Promise<{ changes: readonly { id: string; action: string; occurredAt: string }[] }> {
    const state = requireCookieSession(request);
    const changes = await this.authentication.listCredentialChanges({
      userId: session.userId,
      correlationId: state.correlationId,
    });

    return {
      changes: changes.map((change) => ({
        id: change.id,
        action: change.action,
        occurredAt: change.occurredAt.toISOString(),
      })),
    };
  }

  /** Remove a factor. Soft-disabled, so the removal stays answerable. */
  @Delete('factors/:factorId')
  @NoTenant()
  @HttpCode(204)
  async disableFactor(
    @CurrentSession() session: AuthenticatedSession,
    @Param('factorId') factorId: string,
    @Req() request: RequestLike,
  ): Promise<void> {
    const state = requireCookieSession(request);
    let removed: boolean;
    try {
      removed = await this.authentication.disableFactor({
        userId: session.userId,
        sessionId: session.sessionId,
        factorId,
        reauthToken: this.reauthTokenOf(request),
        context: this.contextOf(request, state.correlationId),
      });
    } catch (error) {
      this.translateReauth(error);
      throw error;
    }
    // `not_found` for a factor belonging to someone else as well as for one that does not
    // exist. Distinguishing them would confirm that a given id is a real factor.
    if (!removed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
  }

  /** A fresh set of recovery codes. The previous set stops working immediately. */
  @Post('recovery-codes')
  @NoTenant()
  @HttpCode(200)
  async regenerateRecoveryCodes(
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: RequestLike,
  ): Promise<{ recoveryCodes: readonly string[] }> {
    const state = requireCookieSession(request);
    try {
      return await this.authentication.regenerateRecoveryCodes({
        userId: session.userId,
        sessionId: session.sessionId,
        reauthToken: this.reauthTokenOf(request),
        context: this.contextOf(request, state.correlationId),
      });
    } catch (error) {
      this.translateReauth(error);
      throw error;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────

  /** The `x-reauth-token` header, if one was sent. Absence is the service's decision to make. */
  private reauthTokenOf(request: RequestLike): string | undefined {
    const raw = request.headers[REAUTH_HEADER];
    return typeof raw === 'string' && raw !== '' ? raw : undefined;
  }

  /**
   * `D05`'s refusal: **403 `reauthentication_required`**. Not 401 — the session is genuine
   * and must stay usable — and not the generic `forbidden`, because the client's correct
   * response is specific: ask for the password, call `POST /v1/auth/reauth`, retry with the
   * header. The precise reason (missing, expired, another session's) goes to the log only.
   */
  private translateReauth(error: unknown): void {
    if (error instanceof ReauthenticationRequiredError) {
      throw new ApiError(
        403,
        'reauthentication_required',
        'Confirm your password to make this change.',
        undefined,
        error.reason,
      );
    }
  }

  private contextOf(request: RequestLike, correlationId: string) {
    const userAgent = request.headers['user-agent'];
    return {
      correlationId,
      ip: request.ip ?? null,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
    };
  }
}
