import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  PASSWORD_RESET_MAILER,
  TENANT_DATABASE,
  WELCOME_MAILER,
} from '../../common/http/tokens.js';
import type { PasswordResetMailer } from '../../common/email/password-reset-email.js';
import { EmailConfirmationService } from '../identity/password-reset.service.js';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { WelcomeMailer } from '../../common/email/welcome-email.js';
import type { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../identity/session.service.js';
import { CONTACT_MAX_PER_WINDOW, CONTACT_WINDOW_MS } from '../public-site/contact.module.js';
import { ProvisioningService } from '../tenancy/provisioning.service.js';
import { PlanVersionsRepository } from '../billing/plan-versions.repository.js';
import { PlanVersionsService } from '../billing/plan-versions.service.js';
import { createPublicSignupSwitch } from '../platform-admin/platform-settings.js';
import { PublicSignupController } from './public-signup.controller.js';
import { PublicSignupService } from './public-signup.service.js';
import {
  PUBLIC_SIGNUP_ADMISSION,
  PUBLIC_SIGNUP_EMAIL_ADMISSION,
  PUBLIC_SIGNUP_SERVICE,
  PUBLIC_SIGNUP_SESSIONS,
  PUBLIC_SIGNUP_SWITCH,
} from './public-signup.tokens.js';

/** Sign-ups admitted per email address per window: a person retries a typo, not a dozen times. */
export const SIGNUP_MAX_PER_EMAIL = 3;

/**
 * Public self-service sign-up. `app.module.ts` registers this module only while `PUBLIC_SIGNUP`
 * is on (the default), so with it off the routes do not exist and answer the router's 404 —
 * `FirstOwnerModule`'s reasoning. `TENANT_DATABASE`, `AUDIT_SERVICE`, `API_CONFIG` and the
 * mailers are global; the welcome mailer is optional so a suite without `MailerModule` boots.
 */
@Module({})
export class PublicSignupModule {
  static register(
    options: { readonly environmentDefault: boolean; readonly databaseBacked: boolean } = {
      environmentDefault: true,
      databaseBacked: false,
    },
  ): DynamicModule {
    // Platform admin's sign-up switch (0206): the stored value when one exists, else
    // `PUBLIC_SIGNUP`. Without Platform admin it is the variable alone and reads nothing.
    const signupSwitch: Provider = {
      provide: PUBLIC_SIGNUP_SWITCH,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => createPublicSignupSwitch(database, options),
    };
    const service: Provider = {
      provide: PUBLIC_SIGNUP_SERVICE,
      inject: [
        TENANT_DATABASE,
        AUDIT_SERVICE,
        { token: WELCOME_MAILER, optional: true },
        { token: PASSWORD_RESET_MAILER, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        welcome?: WelcomeMailer,
        confirmMailer?: PasswordResetMailer,
      ) =>
        new PublicSignupService(
          database,
          new ProvisioningService(database, audit),
          welcome ?? null,
          undefined,
          undefined,
          // VERIFYMAIL: a password sign-up is mailed the link that confirms its address.
          new EmailConfirmationService(database, confirmMailer ?? null),
          // PLANWEB: a plan picked on the pricing page, checked against the versions in force.
          new PlanVersionsService(database, new PlanVersionsRepository(database)),
        ),
    };
    const sessions: Provider = {
      provide: PUBLIC_SIGNUP_SESSIONS,
      inject: [TENANT_DATABASE, API_CONFIG],
      useFactory: (database: TenantDatabase, config: ApiConfig) =>
        new SessionService(database, config),
    };
    // The contact form's window and ceiling per source (same RATE_LIMIT_CONTACT_* overrides).
    const admission: Provider = {
      provide: PUBLIC_SIGNUP_ADMISSION,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) =>
        createFixedWindowLimiter({
          windowMs: config.contactWindowMs ?? CONTACT_WINDOW_MS,
          max: config.contactMaxPerWindow ?? CONTACT_MAX_PER_WINDOW,
        }),
    };
    const emailAdmission: Provider = {
      provide: PUBLIC_SIGNUP_EMAIL_ADMISSION,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) =>
        createFixedWindowLimiter({
          windowMs: config.contactWindowMs ?? CONTACT_WINDOW_MS,
          max: SIGNUP_MAX_PER_EMAIL,
        }),
    };

    return {
      module: PublicSignupModule,
      providers: [service, sessions, admission, emailAdmission, signupSwitch],
      controllers: [PublicSignupController],
    };
  }
}

/**
 * The `PUBLIC_SIGNUP` switch, in one place: the module list `app.module` spreads. Off (or a
 * hand-built config without the field) registers nothing, so the routes are the router's 404 —
 * unless Platform admin is on (`PLATFORM_ADMIN_EMAILS`), whose stored switch can open sign-up
 * while the variable says off. Then the routes exist and answer 404 themselves while closed.
 */
export function publicSignupModules(
  config: Pick<ApiConfig, 'publicSignup' | 'platformAdminEmails'>,
): DynamicModule[] {
  const environmentDefault = config.publicSignup === true;
  const databaseBacked = (config.platformAdminEmails?.length ?? 0) > 0;
  return environmentDefault || databaseBacked
    ? [PublicSignupModule.register({ environmentDefault, databaseBacked })]
    : [];
}
