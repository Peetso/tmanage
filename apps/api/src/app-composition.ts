import type { DynamicModule } from '@nestjs/common';
import type { Env } from '@tmanage/config';
import { DatabaseModule } from './common/database/database.module.js';
import { MailerModule } from './common/email/mailer.module.js';
import { StorageModule } from './common/storage/storage.module.js';
import { ScannerModule } from './common/scan/scanner.module.js';
import { AppModule } from './app.module.js';
import { apiConfigFrom } from './common/http/api-config.js';
import { serializeForLog } from './common/observability/logger.js';

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
      onGuardEvent: (event) => {
        // ADR-0001 layer 3. The event carries a redacted statement shape and never a bound
        // value; OBS-001 routes it through the field-level redactor (`serializeForLog`) so any
        // future field a guard event grows cannot become a secret in the log, and later to the
        // metric and the alert.
        console.warn('[tenant-guard]', serializeForLog(event));
      },
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
    }),
    // FILE-001b. `filesystem` is ADR-0002's local substitute and serves its own part
    // URLs under `API_PUBLIC_URL` — from configuration, never from a `Host` header, for
    // the reason the mail link is. `s3` still refuses at the first provider call (FILE-003).
    storage: StorageModule.forConfig({
      driver: env.STORAGE_DRIVER,
      root: env.STORAGE_FILESYSTEM_ROOT,
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
