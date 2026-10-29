import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { deriveUnsubscribeKey } from '@tmanage/mail';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import { platformAdminCore } from '../platform-admin/platform-admin-core.module.js';
import { sendingDomainOf } from './domain-auth.js';
import {
  EMAIL_DELIVERABILITY_READER,
  EmailDeliverabilityController,
  EmailDeliverabilityReader,
} from './email-deliverability.controller.js';
import { EmailSuppressionsRepository } from './email-suppressions.repository.js';
import {
  EMAIL_SUPPRESSION_WRITER,
  UNSUBSCRIBE_CONFIG,
  UnsubscribeController,
} from './unsubscribe.controller.js';
import type { UnsubscribeConfig } from './unsubscribe.controller.js';

/**
 * 51-11 wiring. Reads `process.env` the way `ProductEventsModule` does, so no config-schema
 * change is needed: `SESSION_SECRET` is required by the one schema (the HMAC key is derived from it
 * under its own label — the worker derives the same key), `EMAIL_FROM_ADDRESS` names the sending
 * domain, and the optional `EMAIL_DKIM_SELECTORS` overrides Hostinger's default selectors.
 */
function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

export function unsubscribeConfigFromEnv(): UnsubscribeConfig {
  const secret = env('SESSION_SECRET');
  return {
    key: secret === undefined ? null : deriveUnsubscribeKey(secret),
    webPublicUrl: env('WEB_PUBLIC_URL') ?? 'http://localhost:3000',
  };
}

export function dkimSelectorsFromEnv(): readonly string[] | undefined {
  const list = env('EMAIL_DKIM_SELECTORS')
    ?.split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9._-]{1,63}$/u.test(s));
  return list === undefined || list.length === 0 ? undefined : list;
}

/** The public one-click route. Registered by `AppModule` beside the other public modules. */
@Module({})
export class EmailUnsubscribeModule {
  static register(): DynamicModule {
    return {
      module: EmailUnsubscribeModule,
      providers: [
        { provide: UNSUBSCRIBE_CONFIG, useFactory: unsubscribeConfigFromEnv },
        {
          provide: EMAIL_SUPPRESSION_WRITER,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) => new EmailSuppressionsRepository(database),
        },
      ],
      controllers: [UnsubscribeController],
    };
  }
}

/** The platform read — a platform area module (listed in `platform-admin.areas.ts`). */
@Module({})
export class EmailDeliverabilityModule {
  static register(): DynamicModule {
    return {
      module: EmailDeliverabilityModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: EMAIL_DELIVERABILITY_READER,
          useFactory: () =>
            new EmailDeliverabilityReader(
              sendingDomainOf(env('EMAIL_FROM_ADDRESS')),
              dkimSelectorsFromEnv(),
            ),
        },
      ],
      controllers: [EmailDeliverabilityController],
      exports: [EMAIL_DELIVERABILITY_READER],
    };
  }
}
