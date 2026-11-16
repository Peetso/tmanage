import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { PasswordResetMailer } from '../../common/email/password-reset-email.js';
import { API_CONFIG, PASSWORD_RESET_MAILER, TENANT_DATABASE } from '../../common/http/tokens.js';
import { AuthenticationService } from '../identity/authentication.service.js';
import { CredentialsRepository } from '../identity/credentials.repository.js';
import { PasswordResetService } from '../identity/password-reset.service.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import { createSignInAbuseControl } from '../identity/sign-in-abuse-control.js';
import {
  PLATFORM_ADMIN_ALLOWLIST,
  PLATFORM_ADMIN_LOOKUP,
  PlatformAdminGuard,
} from './platform-admin.guard.js';
import { PlatformAdminRepository } from './platform-admin.repository.js';
import { PlatformAdminService } from './platform-admin.service.js';
import { PlatformAuditService } from './platform-audit.service.js';
import { PlatformBootstrapReport } from './platform-bootstrap-report.js';

/**
 * The shared core of the Platform admin (platform-admin v2, PA-02): the guard and its lookup,
 * the platform audit writer, the session/step-up service, the team table, and the two things the
 * area services need from the identity module (the reset mailer, the public sign-up default).
 *
 * Every area module (`platform-admin.areas.ts`) imports {@link platformAdminCore} — ONE dynamic
 * module object, so Nest builds these providers once however many areas import it.
 */

export const PLATFORM_ADMIN_SERVICE = Symbol.for('tmanage.PlatformAdminService');
export const PLATFORM_AUDIT_SERVICE = Symbol.for('tmanage.PlatformAuditService');
export const PLATFORM_ADMINS_REPOSITORY = Symbol.for('tmanage.PlatformAdminsRepository');
export const PLATFORM_RESET_MAILER = Symbol.for('tmanage.PlatformResetMailer');
export const PLATFORM_PUBLIC_SIGNUP_DEFAULT = Symbol.for('tmanage.PlatformPublicSignupDefault');

@Module({})
export class PlatformAdminCoreModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PLATFORM_ADMIN_LOOKUP,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new PlatformAdminRepository(database),
    };
    const allowlist: Provider = {
      provide: PLATFORM_ADMIN_ALLOWLIST,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => config.platformAdminEmails ?? [],
    };
    const admins: Provider = {
      provide: PLATFORM_ADMINS_REPOSITORY,
      inject: [PLATFORM_ADMIN_LOOKUP],
      useFactory: (lookup: PlatformAdminRepository) => lookup.admins,
    };
    const audit: Provider = {
      provide: PLATFORM_AUDIT_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new PlatformAuditService(database),
    };
    const resets: Provider = {
      provide: PLATFORM_RESET_MAILER,
      inject: [TENANT_DATABASE, { token: PASSWORD_RESET_MAILER, optional: true }],
      useFactory: (database: TenantDatabase, mailer: PasswordResetMailer | undefined) =>
        new PasswordResetService(database, mailer ?? null),
    };
    const signupDefault: Provider = {
      provide: PLATFORM_PUBLIC_SIGNUP_DEFAULT,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => config.publicSignup === true,
    };
    // The step-up confirms the password (+ code) with its own `AuthenticationService`, built the
    // way `IdentityModule` builds one — the same credential checks and an abuse control of its
    // own — rather than widening `IdentityModule`'s exports.
    const service: Provider = {
      provide: PLATFORM_ADMIN_SERVICE,
      inject: [TENANT_DATABASE, API_CONFIG, PLATFORM_ADMIN_LOOKUP],
      useFactory: (database: TenantDatabase, config: ApiConfig, lookup: PlatformAdminRepository) =>
        new PlatformAdminService(
          lookup,
          new AuthenticationService(
            database,
            {
              sessionSecret: config.sessionSecret,
              maxFailuresInWindow: config.maxFailuresInWindow,
              failureWindowSeconds: config.failureWindowSeconds,
              totpIssuer: config.totpIssuer,
              abuseControl: createSignInAbuseControl({
                windowMs: config.authAbuseWindowSeconds * 1000,
                maxPerSource: config.authAbuseMaxPerSource,
                maxPerSourceAccount: config.authAbuseMaxPerSourceAccount,
                maxGlobal: config.authAbuseMaxGlobal,
              }),
            },
            new CredentialsRepository(createSeedCipher(config.mfaSeedKeys)),
          ),
        ),
    };

    const providers = [
      repository,
      allowlist,
      admins,
      audit,
      resets,
      signupDefault,
      service,
      PlatformAdminGuard,
      // PLATFORMFIX: one start-up line on what the server list amounts to (counts only).
      PlatformBootstrapReport,
    ];
    return {
      module: PlatformAdminCoreModule,
      providers,
      exports: [
        PLATFORM_ADMIN_LOOKUP,
        PLATFORM_ADMIN_ALLOWLIST,
        PLATFORM_ADMINS_REPOSITORY,
        PLATFORM_AUDIT_SERVICE,
        PLATFORM_RESET_MAILER,
        PLATFORM_PUBLIC_SIGNUP_DEFAULT,
        PLATFORM_ADMIN_SERVICE,
        PlatformAdminGuard,
      ],
    };
  }
}

let core: DynamicModule | null = null;

/** The one core module object every area imports (see the file comment). */
export function platformAdminCore(): DynamicModule {
  core ??= PlatformAdminCoreModule.register();
  return core;
}
