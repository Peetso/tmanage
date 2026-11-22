import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@tmanage/config';
import { describe, expect, it } from 'vitest';
import { composeAppModule } from './app-composition.js';

/**
 * Deploy 2d511faa, 2026-11-22: the live API crashed on boot with Nest's
 * `UnknownDependenciesException` (`PlatformAdminGuard` needs `PLATFORM_ADMIN_ALLOWLIST`, which
 * `NetworkAccessModule` did not import). Every unit suite passed, because each one builds only its
 * own module with hand-made fakes; nothing in the pre-deploy gate built the module graph a
 * deployment builds.
 *
 * This builds exactly that graph: `composeAppModule` is the function `main.ts` and `sweep.ts` call,
 * from an `Env` validated by the same `loadEnv`. `compile()` resolves and instantiates every
 * provider (so a missing provider, a missing export or a broken factory fails here) but runs no
 * lifecycle hook and opens no socket. The database pool is created lazily and never queried, so
 * no server is needed: the URL below points at a port nobody listens on.
 */
const bootEnv = () =>
  loadEnv({
    // `production` would demand the real mail, storage, scanner and least-privilege database
    // drivers; development builds the same modules (the development sign-in stays off without
    // ALLOW_DEV_SIGN_IN), so the graph checked here is the deployed one.
    NODE_ENV: 'development',
    API_PUBLIC_URL: 'https://boot.example',
    WEB_PUBLIC_URL: 'https://boot.example',
    CORS_ALLOWED_ORIGINS: 'https://boot.example',
    DATABASE_URL: 'mysql://tmanage_app:pw@127.0.0.1:1/tmanage',
    DATABASE_MIGRATION_URL: 'mysql://tmanage_migrator:pw@127.0.0.1:1/tmanage',
    STORAGE_BUCKET: 'tmanage-boot',
    STORAGE_DRIVER: 'filesystem',
    SESSION_SECRET: 'a'.repeat(48),
    CSRF_SECRET: 'b'.repeat(48),
    STORAGE_LOCAL_SIGNING_SECRET: 'd'.repeat(48),
    AUTH_MFA_SEED_KEYS: `1:${'k'.repeat(43)}`,
    EMAIL_FROM_ADDRESS: 'no-reply@boot.example',
  });

describe('the deployed application module graph', () => {
  it('resolves every provider of the production composition (no missing dependency)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [composeAppModule(bootEnv())],
    }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 120_000);
});
