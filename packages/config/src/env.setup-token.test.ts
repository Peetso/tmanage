import { describe, expect, it } from 'vitest';
import { EnvironmentValidationError, loadEnv } from './env.js';

/** The same minimal valid development environment `env.test.ts` starts from. */
const devEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  API_PUBLIC_URL: 'http://localhost:4000',
  WEB_PUBLIC_URL: 'http://localhost:3000',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
  DATABASE_URL: 'mysql://tmanage_app:pw@localhost:3306/tmanage',
  DATABASE_MIGRATION_URL: 'mysql://tmanage_migrator:pw@localhost:3306/tmanage',
  STORAGE_BUCKET: 'tmanage-local',
  STORAGE_DRIVER: 'filesystem',
  SESSION_SECRET: 'a'.repeat(48),
  CSRF_SECRET: 'b'.repeat(48),
  STORAGE_LOCAL_SIGNING_SECRET: 'd'.repeat(48),
  AUTH_MFA_SEED_KEYS: `1:${'k'.repeat(43)}`,
  EMAIL_FROM_ADDRESS: 'no-reply@tmanage.example',
});

describe('SETUP_TOKEN', () => {
  it('is undefined when absent or empty, and the environment still loads', () => {
    expect(loadEnv(devEnv()).SETUP_TOKEN).toBeUndefined();
    expect(loadEnv({ ...devEnv(), SETUP_TOKEN: '' }).SETUP_TOKEN).toBeUndefined();
  });

  it('rejects a value shorter than 32 characters', () => {
    expect(() => loadEnv({ ...devEnv(), SETUP_TOKEN: 's'.repeat(10) })).toThrow(
      EnvironmentValidationError,
    );
  });

  it('accepts a 40-character value', () => {
    const token = 's'.repeat(40);
    expect(loadEnv({ ...devEnv(), SETUP_TOKEN: token }).SETUP_TOKEN).toBe(token);
  });
});
