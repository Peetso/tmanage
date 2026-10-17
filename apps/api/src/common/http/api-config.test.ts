import { describe, expect, it } from 'vitest';
import { loadEnv } from '@tmanage/config';
import { apiConfigFrom } from './api-config.js';

/**
 * Security audit 2026-09-12, finding C-1 — the lockout denial of service, pinned on the
 * **shipped** configuration.
 *
 * `packages/config`'s own suite proves the schema refuses an inverted pair. This file proves
 * the other half, which is where C-1 actually bit: the two numbers only meet in
 * `apiConfigFrom`, as `authAbuseMaxPerSourceAccount` and `maxFailuresInWindow`, and it is
 * that pair — not the environment variables — that the identity module is constructed from
 * (`identity.module.ts:71-72`, `authentication.service.ts:349,660`).
 *
 * Nothing below chooses a number for either budget. The environment bag names neither
 * `RATE_LIMIT_AUTH_MAX_REQUESTS` nor `AUTH_MAX_FAILURES_IN_WINDOW`, so both arrive from the
 * schema defaults exactly as they do at boot. That is the whole point: the existing
 * `id-002-credentials.db.test.ts:677` asserts this same inequality of literals it declared
 * itself, so it passed while the product shipped 10 against 5.
 */
const shippedEnv = (overrides: NodeJS.ProcessEnv = {}) =>
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
    ...overrides,
  });

/**
 * Pre-launch security review 2026-10-17, HIGH — the fail-open NODE_ENV. The password-less
 * `POST /v1/dev/sessions` used to be registered whenever NODE_ENV was not `production`, so a
 * deployment that left NODE_ENV out booted with it. It now needs ALLOW_DEV_SIGN_IN=true.
 * `allowDevelopmentSignIn` is the one value `app.module.ts` reads to choose
 * `IdentityModule.registerWithDevelopmentSignIn()` over `IdentityModule.register()`, so a false
 * here means the route is not registered at all.
 */
describe('apiConfigFrom — the contact form budget (pre-launch review §3)', () => {
  it('ships 5 submissions per address per 10 minutes, and an operator may change it', () => {
    const shipped = apiConfigFrom(shippedEnv());
    expect(shipped.contactMaxPerWindow).toBe(5);
    expect(shipped.contactWindowMs).toBe(600_000);
    expect(
      apiConfigFrom(shippedEnv({ RATE_LIMIT_CONTACT_MAX_REQUESTS: '20' })).contactMaxPerWindow,
    ).toBe(20);
  });
});

describe('apiConfigFrom — the development sign-in needs an explicit opt-in', () => {
  it('is off when NODE_ENV is missing entirely (the schema defaults it to development)', () => {
    const env = shippedEnv({ NODE_ENV: undefined });
    expect(env.NODE_ENV).toBe('development');
    expect(apiConfigFrom(env).allowDevelopmentSignIn).toBe(false);
  });

  it('is off in development unless ALLOW_DEV_SIGN_IN=true', () => {
    expect(apiConfigFrom(shippedEnv()).allowDevelopmentSignIn).toBe(false);
    expect(apiConfigFrom(shippedEnv({ ALLOW_DEV_SIGN_IN: 'false' })).allowDevelopmentSignIn).toBe(
      false,
    );
    expect(apiConfigFrom(shippedEnv({ ALLOW_DEV_SIGN_IN: 'true' })).allowDevelopmentSignIn).toBe(
      true,
    );
  });

  it('stays off in production even for a bag that skipped the schema and opted in', () => {
    const env = { ...shippedEnv({ ALLOW_DEV_SIGN_IN: 'true' }), NODE_ENV: 'production' as const };
    expect(apiConfigFrom(env).allowDevelopmentSignIn).toBe(false);
  });
});

describe('apiConfigFrom — lockout denial of service (audit C-1)', () => {
  it('resolves a per-source-account budget strictly below the lockout threshold', () => {
    const config = apiConfigFrom(shippedEnv());

    // The property C-1 names. If this fails, one address can spend the failure that locks a
    // known account before the abuse control turns it away — and the account holder cannot
    // clear it, because `confirmReauthentication` reads the same counter and re-auth is the
    // only gate to `setPassword`. Do not relax it; change the default back.
    expect(config.authAbuseMaxPerSourceAccount).toBeLessThan(config.maxFailuresInWindow);
  });

  it('keeps the lockout itself intact — this is a budget change, not a weakening', () => {
    const config = apiConfigFrom(shippedEnv());

    // The account protection must survive the fix. A threshold that drifted upward, or a
    // window that shrank to nothing, would satisfy the inequality above by removing the
    // lockout rather than by bounding the attacker.
    expect(config.maxFailuresInWindow).toBe(5);
    expect(config.failureWindowSeconds).toBe(900);
    expect(config.authAbuseWindowSeconds).toBe(300);
  });

  it('holds the same relation on the fallback path, where the schema never ran', () => {
    // `apiConfigFrom` accepts a hand-built source bag — a caller that never went through
    // `loadEnv`, so the cross-field refinement never saw it. The four abuse budgets are
    // optional there and fall back to constants, and the fallback constant is the one that
    // could silently reintroduce C-1. It is read from `packages/config`, so it cannot.
    const { RATE_LIMIT_AUTH_MAX_REQUESTS: _omitted, ...withoutBudget } = shippedEnv();
    const config = apiConfigFrom(withoutBudget);

    expect(config.authAbuseMaxPerSourceAccount).toBeLessThan(config.maxFailuresInWindow);
  });

  it('carries an operator-supplied budget through unchanged', () => {
    // The mapping must not clamp or reinterpret a value the schema already admitted;
    // refusing a bad pair is the schema's job, and doing it twice differently is how the
    // two layers drift.
    const config = apiConfigFrom({ ...shippedEnv(), RATE_LIMIT_AUTH_MAX_REQUESTS: 2 });

    expect(config.authAbuseMaxPerSourceAccount).toBe(2);
  });
});
