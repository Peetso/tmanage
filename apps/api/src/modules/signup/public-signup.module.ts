import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  TENANT_DATABASE,
  WELCOME_MAILER,
} from '../../common/http/tokens.js';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { WelcomeMailer } from '../../common/email/welcome-email.js';
import type { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../identity/session.service.js';
import { CONTACT_MAX_PER_WINDOW, CONTACT_WINDOW_MS } from '../public-site/contact.module.js';
import { ProvisioningService } from '../tenancy/provisioning.service.js';
import { PublicSignupController } from './public-signup.controller.js';
import { PublicSignupService } from './public-signup.service.js';
import {
  PUBLIC_SIGNUP_ADMISSION,
  PUBLIC_SIGNUP_EMAIL_ADMISSION,
  PUBLIC_SIGNUP_SERVICE,
  PUBLIC_SIGNUP_SESSIONS,
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
  static register(): DynamicModule {
    const service: Provider = {
      provide: PUBLIC_SIGNUP_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, { token: WELCOME_MAILER, optional: true }],
      useFactory: (database: TenantDatabase, audit: AuditService, welcome?: WelcomeMailer) =>
        new PublicSignupService(
          database,
          new ProvisioningService(database, audit),
          welcome ?? null,
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
      providers: [service, sessions, admission, emailAdmission],
      controllers: [PublicSignupController],
    };
  }
}

/**
 * The `PUBLIC_SIGNUP` switch, in one place: the module list `app.module` spreads. Off (or a
 * hand-built config without the field) registers nothing, so the routes are the router's 404.
 */
export function publicSignupModules(config: Pick<ApiConfig, 'publicSignup'>): DynamicModule[] {
  return config.publicSignup === true ? [PublicSignupModule.register()] : [];
}
