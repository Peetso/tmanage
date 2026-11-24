import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  API_CONFIG,
  AUTHENTICATION_EVENT_RECORDER,
  AUTHENTICATION_SERVICE,
  PERSONAL_ACCESS_TOKEN_AUTHENTICATOR,
  SESSION_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import { PersonalAccessTokensService } from '../personal-access-tokens/personal-access-tokens.service.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { DatabaseAuthenticationEventRecorder } from '../../common/http/authentication-event-recorder.js';
import { SessionService } from './session.service.js';
import { DevelopmentSignInController, SessionController } from './session.controller.js';
import { AuthenticationService } from './authentication.service.js';
import { AuthenticationController, CredentialsController } from './authentication.controller.js';
import { CredentialsRepository } from './credentials.repository.js';
import { createSeedCipher } from './seed-cipher.js';
import { createSignInAbuseControl } from './sign-in-abuse-control.js';
import {
  PASSWORD_RESET_ADMISSION,
  PASSWORD_RESET_SERVICE,
  PasswordResetController,
} from './password-reset.controller.js';
import {
  EmailConfirmationService,
  PasswordResetService,
  createPasswordResetMailBudget,
} from './password-reset.service.js';
import {
  EMAIL_CONFIRMATION_REMINDER_JOB,
  EmailConfirmationReminderJob,
  EmailConfirmationReminderPass,
  REMINDER_MAX_PER_HOUR,
  emailConfirmationRemindersEnabled,
} from './email-confirmation-reminders.js';
import { reminderStore } from './email-confirmation-reminders.repository.js';
import {
  EMAIL_CONFIRMATION_SERVICE,
  EmailConfirmationController,
} from './email-confirmation.controller.js';
import type { PasswordResetMailer } from '../../common/email/password-reset-email.js';
import { MFA_CODE_MAILER, PASSWORD_RESET_MAILER } from '../../common/http/tokens.js';
import type { MfaCodeMailer } from '../../common/email/mfa-code-email.js';
import { createEmailCodeSendBudget } from './email-code.js';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import { CONTACT_MAX_PER_WINDOW, CONTACT_WINDOW_MS } from '../public-site/contact.module.js';
import { GeoModule, IP_INTELLIGENCE } from './geo/geo.module.js';
import type { IpIntelligenceService } from './geo/ip-intelligence.service.js';
import { SessionsRepository } from './sessions.repository.js';
// R18-e (56-25): the organization sign-in policy routes and the sign-in gate.
import { AUDIT_SERVICE, MAILER } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import type { Mailer } from '@tmanage/mail';
import {
  SIGN_IN_POLICY_SECRET,
  SIGN_IN_POLICY_SERVICE,
  SignInPolicyController,
} from './sign-in-policy.controller.js';
import { SignInPolicyService } from './sign-in-policy.service.js';
import { SsoEnforcedSignInPolicyGate } from '../sso/sso-enforcement.js';

/**
 * ID-001's HTTP surface.
 *
 * The one decision worth reading here is the conditional controller list.
 * `DevelopmentSignInController` accepts a `userId` on trust, because ID-002 is not written and
 * nothing in this application yet authenticates a person. In production that route is **not
 * registered at all** rather than registered and refusing.
 *
 * The difference matters. A route that exists and returns 403 is one flipped condition away
 * from existing and returning a valid session, and the flip could come from a guard edit, a
 * misordered `APP_GUARD`, or an environment variable set wrongly during a deploy. A route that
 * was never added to the module has no code path at all: the router has no entry, and the 404
 * it returns is the same 404 as any other unknown path. `http-pipeline.db.test.ts` asserts it.
 */
@Module({})
export class IdentityModule {
  static register(): DynamicModule {
    const sessionService: Provider = {
      provide: SESSION_SERVICE,
      inject: [TENANT_DATABASE, API_CONFIG, IP_INTELLIGENCE],
      // R12: the refresh path records the address in the IP cache where `ip_last` moves.
      useFactory: (database: TenantDatabase, config: ApiConfig, ip: IpIntelligenceService) =>
        new SessionService(database, config, new SessionsRepository(), ip),
    };

    const authenticationService: Provider = {
      provide: AUTHENTICATION_SERVICE,
      inject: [TENANT_DATABASE, API_CONFIG, { token: MFA_CODE_MAILER, optional: true }],
      useFactory: (
        database: TenantDatabase,
        config: ApiConfig,
        mfaCodeMailer: MfaCodeMailer | undefined,
      ) =>
        new AuthenticationService(
          database,
          {
            sessionSecret: config.sessionSecret,
            maxFailuresInWindow: config.maxFailuresInWindow,
            failureWindowSeconds: config.failureWindowSeconds,
            totpIssuer: config.totpIssuer,
            // No breached-password screen is wired. HIBP's range API is a network call to a
            // third party and nothing here has ever made it; `password.ts` still screens
            // against the bundled list, and the gap is recorded rather than filled with a
            // screen that would fail open.
            //
            // D08. The source-based bound in front of every password oracle in the service.
            // Built here, once per application, because the map *is* the state: one control
            // per deployment is the intent, and it holds because the bootstrap profile runs a
            // single API process building a single application (`50-BOOTSTRAP` §3, `main.ts`).
            // A test process that builds several applications gets several controls, which is
            // what a suite wanting a fresh window per case relies on; in production a second
            // API process would count separately, and a restart forgets every window. The
            // config carries the window in seconds because that is what an operator writes in
            // an env file; the control counts in milliseconds, so it is converted here rather
            // than leaving two units loose in the codebase.
            abuseControl: createSignInAbuseControl({
              windowMs: config.authAbuseWindowSeconds * 1000,
              maxPerSource: config.authAbuseMaxPerSource,
              maxPerSourceAccount: config.authAbuseMaxPerSourceAccount,
              maxGlobal: config.authAbuseMaxGlobal,
            }),
            // R18-e (56-25): the organization sign-in policy, checked after the password; 54-14
            // adds "require company sign-in" (owners keep the password as break-glass).
            signInPolicy: new SsoEnforcedSignInPolicyGate(database),
            // MFAOPTIONS. The e-mail code method: the mail producer (optional, like the reset
            // mailer below; absent = the method fails closed) and the in-process send limits,
            // one budget per application for the abuse control's reason above.
            ...(mfaCodeMailer
              ? { emailCodes: { mailer: mfaCodeMailer, budget: createEmailCodeSendBudget() } }
              : {}),
          },
          // D07. The keyring was parsed and validated at boot by `packages/config`, so a
          // malformed `AUTH_MFA_SEED_KEYS` has already stopped the process by the time this
          // runs — the cipher is never built from a value nobody checked.
          new CredentialsRepository(createSeedCipher(config.mfaSeedKeys)),
        ),
    };

    // The guard recorder — status defect 4. Bound here because this module already holds its
    // dependencies (`TenantDatabase` and a `CredentialsRepository`), and exported so the global
    // `SessionAuthGuard` and `CsrfGuard` in `AppModule` can inject it. It reuses the sign-in
    // path's own recorder rather than a second write path; the cipher it constructs is unused by
    // `recordAuthenticationEvent` but is what a `CredentialsRepository` requires to exist.
    const authenticationEventRecorder: Provider = {
      provide: AUTHENTICATION_EVENT_RECORDER,
      inject: [TENANT_DATABASE, API_CONFIG],
      useFactory: (database: TenantDatabase, config: ApiConfig) =>
        new DatabaseAuthenticationEventRecorder(
          database,
          new CredentialsRepository(createSeedCipher(config.mfaSeedKeys)),
        ),
    };

    // 0202. The Bearer personal-access-token authenticator the global `SessionAuthGuard` falls
    // back to when a request carries no session cookie. Bound here (this module holds the tenant
    // database and is where authentication lives) and exported so the guard in `AppModule` can
    // inject it. A token resolves to its own member and tenant with no elevation; the ordinary
    // membership-resolver and permission checks run afterwards exactly as for a cookie session.
    const personalAccessTokenAuthenticator: Provider = {
      provide: PERSONAL_ACCESS_TOKEN_AUTHENTICATOR,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new PersonalAccessTokensService(database),
    };

    // ACC-02. Self-service password reset. The mailer is optional so a suite that builds this
    // module without `MailerModule` still boots; with no mailer a request is accepted and no
    // mail is composed, exactly like `EMAIL_DRIVER` unset for invitations.
    const passwordResetService: Provider = {
      provide: PASSWORD_RESET_SERVICE,
      inject: [TENANT_DATABASE, { token: PASSWORD_RESET_MAILER, optional: true }],
      useFactory: (database: TenantDatabase, mailer: PasswordResetMailer | undefined) =>
        new PasswordResetService(database, mailer ?? null),
    };
    // VERIFYMAIL. Confirming a password account's address with the reset's own kind of link.
    const emailConfirmationService: Provider = {
      provide: EMAIL_CONFIRMATION_SERVICE,
      inject: [TENANT_DATABASE, { token: PASSWORD_RESET_MAILER, optional: true }],
      useFactory: (database: TenantDatabase, mailer: PasswordResetMailer | undefined) =>
        new EmailConfirmationService(database, mailer ?? null),
    };
    // RESENDVERIFY. The 1/3/7-day "Confirm your e-mail" reminders: the same link and mail, on a
    // confirmation service of their own (its own hourly bound), hourly and in-process only.
    const emailConfirmationReminderJob: Provider = {
      provide: EMAIL_CONFIRMATION_REMINDER_JOB,
      inject: [TENANT_DATABASE, { token: PASSWORD_RESET_MAILER, optional: true }],
      useFactory: (database: TenantDatabase, mailer: PasswordResetMailer | undefined) =>
        new EmailConfirmationReminderJob(
          new EmailConfirmationReminderPass(
            reminderStore(database),
            new EmailConfirmationService(
              database,
              mailer ?? null,
              undefined,
              createPasswordResetMailBudget({ maxDeliveries: REMINDER_MAX_PER_HOUR }),
            ),
          ),
          emailConfirmationRemindersEnabled(),
        ),
    };
    const passwordResetAdmission: Provider = {
      provide: PASSWORD_RESET_ADMISSION,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) =>
        createFixedWindowLimiter({
          windowMs: config.contactWindowMs ?? CONTACT_WINDOW_MS,
          max: config.contactMaxPerWindow ?? CONTACT_MAX_PER_WINDOW,
        }),
    };

    // R18-e (56-25). The sign-in policy service (audit and mail optional, like the other modules).
    const signInPolicyService: Provider = {
      provide: SIGN_IN_POLICY_SERVICE,
      inject: [
        TENANT_DATABASE,
        { token: AUDIT_SERVICE, optional: true },
        { token: MAILER, optional: true },
      ],
      useFactory: (database: TenantDatabase, audit?: AuditService, mailer?: Mailer | null) =>
        new SignInPolicyService(database, audit, mailer ?? null),
    };
    const signInPolicySecret: Provider = {
      provide: SIGN_IN_POLICY_SECRET,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => config.sessionSecret,
    };

    return {
      module: IdentityModule,
      imports: [GeoModule],
      providers: [
        passwordResetService,
        emailConfirmationService,
        emailConfirmationReminderJob,
        passwordResetAdmission,
        sessionService,
        authenticationService,
        authenticationEventRecorder,
        personalAccessTokenAuthenticator,
        signInPolicyService,
        signInPolicySecret,
      ],
      exports: [
        sessionService,
        authenticationService,
        authenticationEventRecorder,
        personalAccessTokenAuthenticator,
      ],
      controllers: [
        SessionController,
        AuthenticationController,
        CredentialsController,
        PasswordResetController,
        EmailConfirmationController,
        SignInPolicyController,
      ],
    };
  }

  /** Everything in {@link register}, plus the development-only sign-in route. */
  static registerWithDevelopmentSignIn(): DynamicModule {
    const base = IdentityModule.register();
    return {
      ...base,
      controllers: [...(base.controllers ?? []), DevelopmentSignInController],
    };
  }
}
