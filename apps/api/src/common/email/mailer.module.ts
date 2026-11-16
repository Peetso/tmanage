import { Global, Module } from '@nestjs/common';
import { ConsoleMailer, QueueMailer, SmtpMailer, withTemplateKey } from '@tmanage/mail';
import type { Mailer } from '@tmanage/mail';
import { MailQueueRepository } from '../database/mail-queue.repository.js';
import type { TenantDatabase } from '../database/tenant-context.js';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  INVITATION_MAILER,
  MAILER,
  MFA_CODE_MAILER,
  PASSWORD_RESET_MAILER,
  TENANT_DATABASE,
  WELCOME_MAILER,
} from '../http/tokens.js';
import { InvitationMailer } from './invitation-mailer.js';
import { MfaCodeMailer } from './mfa-code-email.js';
import { PasswordResetMailer } from './password-reset-email.js';
import { WelcomeMailer } from './welcome-email.js';

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
  /**
   * 56-31. Enqueue into `mail_queue` instead of submitting: the worker drainer sends in lane order
   * against the shared hour window. Only with `driver: 'smtp'` — the console driver keeps
   * printing in-process. Off until the drainer runs wherever this API runs (MAIL_QUEUE=on).
   */
  readonly queue?: boolean | undefined;
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

/** The producers over one transport. Template keys are stamped here so lanes.ts can map them. */
function producersFor(mailer: Mailer | null, webPublicUrl: string) {
  const keyed = (key: string): Mailer | null =>
    mailer === null ? null : withTemplateKey(mailer, key);
  return {
    invitation: new InvitationMailer(keyed('invitation'), webPublicUrl),
    passwordReset: new PasswordResetMailer(keyed('password_reset'), webPublicUrl),
    welcome: new WelcomeMailer(keyed('welcome'), webPublicUrl),
    // MFAOPTIONS. `mfa_code` is the auth lane lanes.ts already reserves (10-minute deadline).
    mfaCode: new MfaCodeMailer(keyed('mfa_code')),
  };
}

function moduleFor(mailer: Mailer | null, webPublicUrl: string): DynamicModule {
  const producers = producersFor(mailer, webPublicUrl);
  const mailerProvider: Provider = { provide: MAILER, useValue: mailer };
  const invitationMailer: Provider = { provide: INVITATION_MAILER, useValue: producers.invitation };
  const passwordResetMailer: Provider = {
    provide: PASSWORD_RESET_MAILER,
    useValue: producers.passwordReset,
  };
  const welcomeMailer: Provider = { provide: WELCOME_MAILER, useValue: producers.welcome };
  const mfaCodeMailer: Provider = { provide: MFA_CODE_MAILER, useValue: producers.mfaCode };
  const all = [mailerProvider, invitationMailer, passwordResetMailer, welcomeMailer, mfaCodeMailer];
  return {
    module: MailerModule,
    global: true,
    providers: all,
    exports: all,
  };
}

/** 56-31: every producer enqueues through `mail_queue` on the global `TENANT_DATABASE`. */
function queuedModule(webPublicUrl: string): DynamicModule {
  const QUEUE = Symbol.for('tmanage.MailQueueProducers');
  const queue: Provider = {
    provide: QUEUE,
    inject: [TENANT_DATABASE],
    useFactory: (database: TenantDatabase) => {
      const mailer = new QueueMailer(new MailQueueRepository(database));
      return { mailer, ...producersFor(mailer, webPublicUrl) };
    },
  };
  type Queued = { mailer: Mailer } & ReturnType<typeof producersFor>;
  const from = (token: symbol, pick: (queued: Queued) => unknown): Provider => ({
    provide: token,
    inject: [QUEUE],
    useFactory: pick,
  });
  const providers = [
    from(MAILER, (q) => q.mailer),
    from(INVITATION_MAILER, (q) => q.invitation),
    from(PASSWORD_RESET_MAILER, (q) => q.passwordReset),
    from(WELCOME_MAILER, (q) => q.welcome),
    from(MFA_CODE_MAILER, (q) => q.mfaCode),
  ];
  return {
    module: MailerModule,
    global: true,
    providers: [queue, ...providers],
    exports: providers,
  };
}

@Global()
@Module({})
export class MailerModule {
  static forConfig(config: MailerModuleConfig): DynamicModule {
    if (config.queue === true && config.driver === 'smtp') return queuedModule(config.webPublicUrl);
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
