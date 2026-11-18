import type { DynamicModule } from '@nestjs/common';
import type { Env } from '@tmanage/config';
import { deriveBounceKey } from '@tmanage/mail';
import { DatabaseModule } from './common/database/database.module.js';
import { createGuardEventLog } from './common/database/guard-event-log.js';
import { MailerModule } from './common/email/mailer.module.js';
import { StorageModule } from './common/storage/storage.module.js';
import { ScannerModule } from './common/scan/scanner.module.js';
import { AppModule } from './app.module.js';
import { apiConfigFrom } from './common/http/api-config.js';
import { serializeForLog } from './common/observability/logger.js';
import { PLAN_LIMITS } from './modules/billing/plan-catalog.js';
import { plansCutByCeiling } from './modules/billing/storage-allowance.js';

/**
 * The application module as a deployment composes it — from a validated `Env` and nothing
 * else. `main.ts` (the HTTP process) and `sweep.ts` (USAGE-001's one-pass job) both build
 * exactly this, so a job runs against the same database wiring, the same storage driver
 * and the same audit and outbox modules the API's own requests do; a second copy of this
 * call in `sweep.ts` would be the wiring defect the inbox session found in
 * `PortalInboxService`, one process over.
 *
 * Nothing here decides anything: every value is `packages/config`'s, already validated
 * and cross-checked at `loadEnv()`. See `main.ts` on why this file cannot reach `mysql2`.
 */
export function composeAppModule(env: Env): DynamicModule {
  // 57-13r. An explicit storage ceiling below a plan's allowance overrides that plan: said once,
  // at boot, so the operator sees the env value is what refuses those workspaces' uploads.
  const ceiling = env.STORAGE_ORG_BYTES_LIMIT_BYTES ?? null;
  const cut = plansCutByCeiling(ceiling, PLAN_LIMITS);
  if (cut.length > 0) {
    console.warn(
      `[storage] STORAGE_ORG_BYTES_LIMIT_BYTES=${String(ceiling)} is below the storage allowance of plans: ${cut.join(', ')}`,
    );
  }
  return AppModule.register({
    config: apiConfigFrom(env),
    database: DatabaseModule.forUrl({
      url: env.DATABASE_URL,
      connectionLimit: env.DATABASE_POOL_MAX,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
      guardMode: env.TENANT_GUARD_MODE,
      onConnectionError: (error) => {
        // A connection whose session state would not apply is destroyed rather than served
        // (see `connection.ts`). Silence here would present as the pool hanging. The driver
        // error can carry the connection config — DSN and credential — so it goes through the
        // same field-level redactor (`serializeForLog`) the tenant-guard event below does,
        // never raw to the log.
        console.error(
          '[database] connection rejected during session setup',
          serializeForLog(error),
        );
      },
      // ADR-0001 layer 3. The event carries a redacted statement shape and never a bound
      // value; OBS-001 routes it through the field-level redactor (`serializeForLog`) so any
      // future field a guard event grows cannot become a secret in the log, and later to the
      // metric and the alert. LOGQUIET-b: an audited escape once per fingerprint per start.
      onGuardEvent: createGuardEventLog((event) => {
        console.warn('[tenant-guard]', serializeForLog(event));
      }),
    }),
    mailer: MailerModule.forConfig({
      driver: env.EMAIL_DRIVER,
      fromAddress: env.EMAIL_FROM_ADDRESS,
      fromName: env.EMAIL_FROM_NAME,
      // Built from configuration, never from a request header — the link this produces
      // carries a credential and a `Host` header is attacker-writable.
      webPublicUrl: env.WEB_PUBLIC_URL,
      smtpHost: env.SMTP_HOST,
      smtpPort: env.SMTP_PORT,
      smtpSecure: env.SMTP_SECURE,
      smtpUsername: env.SMTP_USERNAME,
      smtpPassword: env.SMTP_PASSWORD,
      // 56-31. `MAIL_QUEUE=on` routes every message through `mail_queue` and the worker drainer
      // (lane order, shared hour window). Read here rather than in `packages/config` so the one
      // schema stays untouched this batch; off until the drainer runs beside this API on live.
      queue: process.env['MAIL_QUEUE']?.trim().toLowerCase() === 'on',
      // 56-26: the key company mail's Message-ID is signed with, so its bounce can be matched.
      bounceKey: deriveBounceKey(env.SESSION_SECRET),
      sendAs: env.EMAIL_SEND_AS,
      helloLogin: { username: env.SMTP_HELLO_USER, password: env.SMTP_HELLO_PASS },
      supportLogin: { username: env.SMTP_SUPPORT_USER, password: env.SMTP_SUPPORT_PASS },
    }),
    // FILE-001b. `local` is the production single-host driver (Hostinger shared hosting):
    // it stores under `STORAGE_LOCAL_ROOT`, which the module checks at boot is absolute and
    // outside every web root — the app's own directory, where the bundle and its served
    // static files live — and refuses to start otherwise. `filesystem` stays ADR-0002's
    // dev/e2e substitute under `STORAGE_FILESYSTEM_ROOT`. Both serve their part URLs under
    // `API_PUBLIC_URL` — from configuration, never from a `Host` header, for the reason the
    // mail link is. `s3` is unchanged.
    storage: StorageModule.forConfig({
      driver: env.STORAGE_DRIVER,
      root:
        env.STORAGE_DRIVER === 'local'
          ? (env.STORAGE_LOCAL_ROOT ?? '')
          : env.STORAGE_FILESYSTEM_ROOT,
      webRoots: [process.cwd()],
      signingSecret: env.STORAGE_LOCAL_SIGNING_SECRET,
      publicUrl: env.API_PUBLIC_URL,
      partSizeBytes: env.UPLOAD_PART_SIZE_BYTES,
    }),
    // FILE-002 slice B. `none` records `unscanned` and promotes nothing (decision F3);
    // `stub` is refused in production by `packages/config`; `clamav` dials the host named
    // here — from configuration, as every network address in this file is.
    scanner: ScannerModule.forConfig({
      driver: env.MALWARE_SCAN_DRIVER,
      host: env.CLAMAV_HOST,
      port: env.CLAMAV_PORT,
      timeoutMs: env.MALWARE_SCAN_TIMEOUT_MS,
    }),
  });
}
