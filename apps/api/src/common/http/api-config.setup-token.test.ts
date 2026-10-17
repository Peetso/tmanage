import { describe, expect, it } from 'vitest';
import { loadEnv } from '@tmanage/config';
import { apiConfigFrom } from './api-config.js';

/**
 * First-owner setup: `SETUP_TOKEN` is the only switch that registers `/setup`. The token is
 * laid onto the loaded environment rather than passed through `loadEnv`, so this suite pins
 * `apiConfigFrom` alone and does not depend on the schema change landing in the same order.
 */
const shippedEnv = () =>
  loadEnv({
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

describe('apiConfigFrom — the first-owner setup token', () => {
  it('is null when SETUP_TOKEN is absent, so the setup routes stay unregistered', () => {
    const env = { ...shippedEnv(), SETUP_TOKEN: undefined };
    expect(apiConfigFrom(env).setupToken).toBeNull();
  });

  it('carries the operator-set token through unchanged', () => {
    const token = 's'.repeat(40);
    expect(apiConfigFrom({ ...shippedEnv(), SETUP_TOKEN: token }).setupToken).toBe(token);
  });
});
