import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Mailer } from '@tmanage/mail';
import type { ApiConfig } from '../../../common/http/api-config.js';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import type { PasswordResetMailer } from '../../../common/email/password-reset-email.js';
import {
  API_CONFIG,
  MAILER,
  PASSWORD_RESET_MAILER,
  TENANT_DATABASE,
} from '../../../common/http/tokens.js';
import { CredentialsRepository } from '../../identity/credentials.repository.js';
import { EmailChangeNotifier } from '../../identity/credential-change/email-change-notice.js';
import {
  EmailConfirmationService,
  createPasswordResetMailBudget,
} from '../../identity/password-reset.service.js';
import { createSeedCipher } from '../../identity/seed-cipher.js';
import { PLATFORM_RESET_MAILER, platformAdminCore } from '../platform-admin-core.module.js';
import { PLATFORM_ADMIN_LOOKUP } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import type { ResetMailer } from '../platform-admin.service.js';
import { PLATFORM_PEOPLE_SERVICE, PlatformPeopleController } from './people.controller.js';
import { PlatformPeopleRepository } from './people.repository.js';
import { PLATFORM_CONFIRMATION_MAX_PER_HOUR, PlatformPeopleService } from './people.service.js';

/** Platform admin · People (listed in `platform-admin.areas.ts`). PA-06. */
@Module({})
export class PlatformPeopleModule {
  static register(): DynamicModule {
    return {
      module: PlatformPeopleModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: PLATFORM_PEOPLE_SERVICE,
          inject: [
            PLATFORM_ADMIN_LOOKUP,
            PLATFORM_RESET_MAILER,
            TENANT_DATABASE,
            API_CONFIG,
            { token: MAILER, optional: true },
            { token: PASSWORD_RESET_MAILER, optional: true },
          ],
          useFactory: (
            platform: PlatformAdminRepository,
            resets: ResetMailer,
            database: TenantDatabase,
            config: ApiConfig,
            mailer: Mailer | null | undefined,
            resetMailer: PasswordResetMailer | undefined,
          ) =>
            new PlatformPeopleService(
              platform,
              new PlatformPeopleRepository(
                database,
                new CredentialsRepository(createSeedCipher(config.mfaSeedKeys)),
              ),
              resets,
              new EmailChangeNotifier(mailer ?? null, config.webPublicUrl ?? ''),
              undefined,
              undefined,
              // RESENDVERIFY: the identity module's confirmation link and mail, with the
              // platform's own hourly bound (3 per address, 100 links in all).
              new EmailConfirmationService(
                database,
                resetMailer ?? null,
                undefined,
                createPasswordResetMailBudget({
                  maxDeliveries: PLATFORM_CONFIRMATION_MAX_PER_HOUR,
                }),
              ),
            ),
        },
      ],
      controllers: [PlatformPeopleController],
    };
  }
}
