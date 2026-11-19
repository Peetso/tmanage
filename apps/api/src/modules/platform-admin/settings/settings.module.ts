import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { loadFieldCipherKeyring, keyringFromSeedKeyring } from '@tmanage/domain/field-cipher';
import type { ApiConfig } from '../../../common/http/api-config.js';
import { API_CONFIG, MAILER, TENANT_DATABASE } from '../../../common/http/tokens.js';
import type { Mailer } from '@tmanage/mail';
import {
  PLATFORM_PUBLIC_SIGNUP_DEFAULT,
  platformAdminCore,
} from '../platform-admin-core.module.js';
import { PLATFORM_ADMIN_LOOKUP } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import {
  PLATFORM_ANNOUNCEMENTS_SERVICE,
  PlatformAnnouncementsController,
} from './announcements.controller.js';
import { PlatformAnnouncementsRepository } from './announcements.repository.js';
import { PlatformAnnouncementsService } from './announcements.service.js';
import { PLATFORM_FLAGS_SERVICE, PlatformFlagsController } from './flags.controller.js';
import {
  PLATFORM_MAIL_PEOPLE_SERVICE,
  PlatformMailPeopleController,
} from './mail-people.controller.js';
import { MailPeopleRepository } from './mail-people.repository.js';
import { MailPeopleService } from './mail-people.service.js';
import {
  PLATFORM_PERSON_MAIL_SERVICE,
  PlatformPersonMailController,
} from './person-mail.controller.js';
import { PersonMailRepository } from './person-mail.repository.js';
import { PersonMailService } from './person-mail.service.js';
import { PlatformFlagsRepository } from './flags.repository.js';
import { PlatformFlagsService } from './flags.service.js';
import { PLATFORM_KEYS_SERVICE, PlatformKeysController } from './keys.controller.js';
import { PlatformKeysRepository } from './keys.repository.js';
import { PlatformKeysService } from './keys.service.js';
import { PLATFORM_SETTINGS_SERVICE, PlatformSettingsController } from './settings.controller.js';
import { PlatformSettingsRepository } from './settings.repository.js';
import { PlatformSettingsService } from './settings.service.js';
import {
  PLATFORM_UNIT_COSTS_SERVICE,
  PlatformUnitCostsController,
} from './unit-costs.controller.js';
import { UnitCostsService } from './unit-costs.service.js';

/**
 * Platform admin · Settings (listed in `platform-admin.areas.ts`): D1 General + integrations,
 * D2 feature flags, D3 announcements. D4 maintenance stays in `platform/maintenance.controller.ts`
 * (its own module, registered since wave 9).
 */
@Module({})
export class PlatformSettingsModule {
  static register(): DynamicModule {
    return {
      module: PlatformSettingsModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: PLATFORM_SETTINGS_SERVICE,
          inject: [PLATFORM_ADMIN_LOOKUP, PLATFORM_PUBLIC_SIGNUP_DEFAULT, TENANT_DATABASE],
          useFactory: (
            repository: PlatformAdminRepository,
            publicSignupDefault: boolean,
            database: TenantDatabase,
          ) =>
            new PlatformSettingsService(repository, publicSignupDefault, {
              store: new PlatformSettingsRepository(database),
            }),
        },
        {
          provide: PLATFORM_FLAGS_SERVICE,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) =>
            new PlatformFlagsService(new PlatformFlagsRepository(database)),
        },
        {
          provide: PLATFORM_ANNOUNCEMENTS_SERVICE,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) =>
            new PlatformAnnouncementsService(new PlatformAnnouncementsRepository(database)),
        },
        // ---- EMAILBUILD ---- the people who sign tips; the test send goes to the admin only.
        {
          provide: PLATFORM_MAIL_PEOPLE_SERVICE,
          inject: [TENANT_DATABASE, { token: MAILER, optional: true }],
          useFactory: (database: TenantDatabase, mailer: Mailer | null | undefined) =>
            new MailPeopleService(new MailPeopleRepository(database), {
              mailer: mailer ?? null,
              supportLoginConfigured:
                (process.env['SMTP_SUPPORT_USER'] ?? '').trim() !== '' &&
                (process.env['SMTP_SUPPORT_PASS'] ?? '') !== '',
            }),
        },
        // ---- EMAILBUILD2 ---- the "Tips and reminders" switch and the "Feature news" card.
        {
          provide: PLATFORM_PERSON_MAIL_SERVICE,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) =>
            new PersonMailService(new PersonMailRepository(database)),
        },
        // ---- 56-02 Keys ---- status only; key ids from env, never a value.
        {
          provide: PLATFORM_KEYS_SERVICE,
          inject: [TENANT_DATABASE, { token: API_CONFIG, optional: true }],
          useFactory: (database: TenantDatabase, config: ApiConfig | undefined) =>
            new PlatformKeysService(new PlatformKeysRepository(database), {
              keyring: loadFieldCipherKeyring(process.env),
              mfaFallback:
                config?.mfaSeedKeys === undefined
                  ? null
                  : keyringFromSeedKeyring(config.mfaSeedKeys),
              sessionOverlap: (process.env['SESSION_SECRET_PREVIOUS'] ?? '').trim() !== '',
            }),
        },
        // ---- 62-A3 GROWTH (B14) ---- the monthly unit costs behind "cost per active company".
        {
          provide: PLATFORM_UNIT_COSTS_SERVICE,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) =>
            new UnitCostsService(new PlatformSettingsRepository(database)),
        },
      ],
      controllers: [
        PlatformSettingsController,
        PlatformFlagsController,
        PlatformAnnouncementsController,
        PlatformKeysController,
        PlatformMailPeopleController,
        PlatformPersonMailController,
        PlatformUnitCostsController,
      ],
    };
  }
}
