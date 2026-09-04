import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadEnv } from '@tmanage/config';
import { createPartAdmission } from '@tmanage/storage';
import { createFastifyAdapter } from './common/http/fastify-adapter.js';
import { composeAppModule } from './app-composition.js';

/**
 * The API process entry point.
 *
 * `reflect-metadata` is imported here and only here — once, before any decorated class is
 * evaluated. Nest's decorators write to the metadata registry it installs, so importing it
 * late (or in several places) is how "Nest can't resolve dependencies" appears with no visible
 * cause. The database suite imports it in its own harness for the same reason, and so does
 * `sweep.ts`, which is a second process rather than a second import.
 *
 * Nothing else in this file makes a decision. Everything that could be decided differently
 * lives in `packages/config` (validated, fails loudly at boot) or in `AppModule` (the pipeline
 * order); the module itself is composed in `app-composition.ts`, shared with `sweep.ts`. This
 * is wiring.
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
    composeAppModule(env),
    // The octet-stream parser for the part route rides on the adapter, with its own body
    // limit — see `fastify-adapter.ts` on why the global limit stays at Fastify's default.
    createFastifyAdapter({
      trustProxy: true,
      uploadPartSizeBytes: env.UPLOAD_PART_SIZE_BYTES,
      // The same secret the filesystem driver signs with; with no local transport there is
      // no admission and the part route reads no body at all.
      admitPart:
        env.STORAGE_DRIVER === 'filesystem' && env.STORAGE_LOCAL_SIGNING_SECRET
          ? createPartAdmission(env.STORAGE_LOCAL_SIGNING_SECRET)
          : undefined,
    }),
  );

  /**
   * Credentials are sent cross-origin, so the origin list is exact — `packages/config` rejects
   * a wildcard outright, and `credentials: true` with `origin: '*'` is refused by browsers
   * anyway. `X-CSRF-Token` has to be allowed explicitly or the preflight fails and every
   * mutation from the web app breaks. `ETag` is exposed because the browser collects one
   * per uploaded part and hands them all to `complete` (FILE-001b) — a header the browser
   * cannot read is a completion it cannot make.
   */
  app.enableCors({
    origin: [...env.CORS_ALLOWED_ORIGINS],
    credentials: true,
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-correlation-id'],
    exposedHeaders: ['x-correlation-id', 'etag'],
  });

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
}

bootstrap().catch((error: unknown) => {
  console.error('[api] failed to start', error);
  process.exitCode = 1;
});
