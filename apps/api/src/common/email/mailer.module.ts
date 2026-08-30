import { Global, Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { INVITATION_MAILER, MAILER } from '../http/tokens.js';
import { ConsoleMailer } from './console-mailer.js';
import { InvitationMailer } from './invitation-mailer.js';
import type { Mailer } from './mailer.js';
import { SmtpMailer } from './smtp-mailer.js';

/**
 * The mail wiring — `DatabaseModule`'s dual shape, applied to the other network resource.
 *
 * `forConfig` is what `main.ts` calls with the environment's answers; `forMailer` is what a
 * suite calls with a transport it owns, so a test can hold the messages in its hand the way
 * `DatabaseModule.forPool` lets it hold the pool. `none()` is the default `AppModule` falls
 * back to when the composition root passes nothing — every delivery then answers `'none'`,
 * which is precisely the pre-mailer behaviour the printed link exists for.
 *
 * `@Global` for `AuditModule`'s reason: the producer lives in `TenancyModule`, which
 * resolves cross-cutting singletons from the root injector rather than importing sibling
 * dynamic modules (see tenancy.module.ts on why importing one twice is worse).
 */

export interface MailerModuleConfig {
  readonly driver: 'console' | 'smtp';
  readonly fromAddress: string;
  readonly fromName: string;
  readonly webPublicUrl: string;
  readonly smtpHost?: string | undefined;
  readonly smtpPort?: number | undefined;
  readonly smtpSecure?: boolean | undefined;
  readonly smtpUsername?: string | undefined;
  readonly smtpPassword?: string | undefined;
}

function driverFrom(config: MailerModuleConfig): Mailer {
  if (config.driver === 'console') {
    return new ConsoleMailer({ fromAddress: config.fromAddress, fromName: config.fromName });
  }
  if (config.smtpHost === undefined || config.smtpHost === '') {
    // `packages/config` already refuses this combination at boot; repeated here so a
    // caller that bypassed `loadEnv` fails at wiring time rather than at the first send.
    throw new Error('EMAIL_DRIVER=smtp requires SMTP_HOST');
  }
  return new SmtpMailer({
    host: config.smtpHost,
    port: config.smtpPort ?? 587,
    secure: config.smtpSecure ?? false,
    username: config.smtpUsername,
    password: config.smtpPassword,
    fromAddress: config.fromAddress,
    fromName: config.fromName,
  });
}

function moduleFor(mailer: Mailer | null, webPublicUrl: string): DynamicModule {
  const mailerProvider: Provider = { provide: MAILER, useValue: mailer };
  const invitationMailer: Provider = {
    provide: INVITATION_MAILER,
    useValue: new InvitationMailer(mailer, webPublicUrl),
  };
  return {
    module: MailerModule,
    global: true,
    providers: [mailerProvider, invitationMailer],
    exports: [mailerProvider, invitationMailer],
  };
}

@Global()
@Module({})
export class MailerModule {
  static forConfig(config: MailerModuleConfig): DynamicModule {
    return moduleFor(driverFrom(config), config.webPublicUrl);
  }

  /** A suite's transport, held by the suite. `webPublicUrl` shapes the link under test. */
  static forMailer(mailer: Mailer, webPublicUrl: string): DynamicModule {
    return moduleFor(mailer, webPublicUrl);
  }

  /** No transport at all: every delivery answers `'none'` and nothing is composed. */
  static none(): DynamicModule {
    return moduleFor(null, '');
  }
}
