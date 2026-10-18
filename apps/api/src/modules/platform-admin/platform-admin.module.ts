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
import { PLATFORM_ADMIN_SERVICE, PlatformAdminController } from './platform-admin.controller.js';
import {
  PLATFORM_ADMIN_ALLOWLIST,
  PLATFORM_ADMIN_LOOKUP,
  PlatformAdminGuard,
} from './platform-admin.guard.js';
import { PlatformAdminRepository } from './platform-admin.repository.js';
import { PlatformAdminService } from './platform-admin.service.js';

/**
 * Platform admin (`/v1/platform/*`). Registered by `AppModule` ONLY when
 * `PLATFORM_ADMIN_EMAILS` names somebody, so with the variable unset the routes do not exist
 * and answer the router's ordinary 404 (the `SETUP_TOKEN` pattern); the guard refuses an
 * empty list as well, so a mis-wired registration still fails closed.
 *
 * The step-up confirms the password (+ code) with its own `AuthenticationService`, built the
 * way `IdentityModule` builds one — the same credential checks and an abuse control of its
 * own — rather than widening `IdentityModule`'s exports. The reset email is the ordinary
 * self-service `PasswordResetService`.
 */
@Module({})
export class PlatformAdminModule {
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
    const service: Provider = {
      provide: PLATFORM_ADMIN_SERVICE,
      inject: [
        TENANT_DATABASE,
        API_CONFIG,
        PLATFORM_ADMIN_LOOKUP,
        { token: PASSWORD_RESET_MAILER, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        config: ApiConfig,
        lookup: PlatformAdminRepository,
        mailer: PasswordResetMailer | undefined,
      ) =>
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
          new PasswordResetService(database, mailer ?? null),
          config.publicSignup === true,
        ),
    };

    return {
      module: PlatformAdminModule,
      providers: [repository, allowlist, service, PlatformAdminGuard],
      controllers: [PlatformAdminController],
    };
  }
}
