import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadEnv } from '@tmanage/config';
import { DatabaseModule } from './common/database/database.module.js';
import { AppModule } from './app.module.js';
import { apiConfigFrom } from './common/http/api-config.js';

/**
 * The API process entry point.
 *
 * `reflect-metadata` is imported here and only here — once, before any decorated class is
 * evaluated. Nest's decorators write to the metadata registry it installs, so importing it
 * late (or in several places) is how "Nest can't resolve dependencies" appears with no visible
 * cause. The database suite imports it in its own harness for the same reason.
 *
 * Nothing else in this file makes a decision. Everything that could be decided differently
 * lives in `packages/config` (validated, fails loudly at boot) or in `AppModule` (the pipeline
 * order). This is wiring.
 *
 * Note what this file cannot reach: `mysql2`, and the pool factory in
 * `common/database/connection.js`. ADR-0001 layer 4 permits a driver handle only under
 * `src/common/database/`, and the lint rule enforces it here as it does everywhere else — the
 * composition root is not an exception. `DatabaseModule.forUrl()` builds the pool inside that
 * boundary and hands back a module.
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: apiConfigFrom(env),
      database: DatabaseModule.forUrl({
        url: env.DATABASE_URL,
        connectionLimit: env.DATABASE_POOL_MAX,
        statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
        guardMode: env.TENANT_GUARD_MODE,
        onConnectionError: (error) => {
          // A connection whose session state would not apply is destroyed rather than served
          // (see `connection.ts`). Silence here would present as the pool hanging.
          console.error('[database] connection rejected during session setup', error);
        },
        onGuardEvent: (event) => {
          // ADR-0001 layer 3. The event carries a redacted statement shape and never a bound
          // value; OBS-001 will route this to the metric and the alert.
          console.warn('[tenant-guard]', JSON.stringify(event));
        },
      }),
    }),
    new FastifyAdapter({ trustProxy: true }),
  );

  /**
   * Credentials are sent cross-origin, so the origin list is exact — `packages/config` rejects
   * a wildcard outright, and `credentials: true` with `origin: '*'` is refused by browsers
   * anyway. `X-CSRF-Token` has to be allowed explicitly or the preflight fails and every
   * mutation from the web app breaks.
   */
  app.enableCors({
    origin: [...env.CORS_ALLOWED_ORIGINS],
    credentials: true,
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-correlation-id'],
    exposedHeaders: ['x-correlation-id'],
  });

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
}

bootstrap().catch((error: unknown) => {
  console.error('[api] failed to start', error);
  process.exitCode = 1;
});
