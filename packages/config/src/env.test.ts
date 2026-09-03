import { describe, expect, it } from 'vitest';
import { EnvironmentValidationError, loadEnv } from './env.js';

/**
 * A minimal valid development environment. Individual tests override single keys so a
 * failure names exactly one cause.
 */
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
  EMAIL_FROM_ADDRESS: 'no-reply@tmanage.example',
});

const prodEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...devEnv(),
  NODE_ENV: 'production',
  API_PUBLIC_URL: 'https://api.tmanage.example',
  WEB_PUBLIC_URL: 'https://app.tmanage.example',
  CORS_ALLOWED_ORIGINS: 'https://app.tmanage.example',
  STORAGE_DRIVER: 's3',
  STORAGE_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  STORAGE_SECRET_ACCESS_KEY: 'secret-example',
  QUEUE_DRIVER: 'redis',
  CACHE_DRIVER: 'redis',
  MALWARE_SCAN_DRIVER: 'clamav',
  EMAIL_DRIVER: 'smtp',
  SMTP_HOST: 'smtp.tmanage.example',
  SMTP_USERNAME: 'no-reply@tmanage.example',
  SMTP_PASSWORD: 'mail-credential-example',
  ...overrides,
});

/**
 * Collect the offending environment variable name from every validation issue.
 *
 * Only the first path segment is kept: issues raised inside a transformed list carry the
 * element index too (`CORS_ALLOWED_ORIGINS.0`), and assertions should read as the variable
 * a developer has to go fix.
 */
const issuePaths = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvironmentValidationError) {
      return error.issues.map((i) => String(i.path[0] ?? '(root)'));
    }
    throw error;
  }
  throw new Error('expected loadEnv to throw');
};

describe('loadEnv', () => {
  it('accepts a minimal development environment and applies documented defaults', () => {
    const env = loadEnv(devEnv());

    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.SESSION_TTL_SECONDS).toBe(900);
    expect(env.IDEMPOTENCY_RETENTION_HOURS).toBe(24);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['http://localhost:3000']);
    // 50-BOOTSTRAP §9: bootstrap is the owner's funded environment, so it is the default.
    expect(env.DEPLOYMENT_PROFILE).toBe('bootstrap');
    // ADR-0001 layer 3 is on unless deliberately turned down.
    expect(env.TENANT_GUARD_MODE).toBe('enforce');
    // 50-BOOTSTRAP §4: a small bounded pool matched to the plan's connection allowance.
    expect(env.DATABASE_POOL_MAX).toBe(5);
  });

  it('rejects a PostgreSQL connection string — the engine is MySQL/MariaDB', () => {
    // Guards against a regression to the pre-2026-08-16 pack revision.
    expect(
      issuePaths(() =>
        loadEnv({ ...devEnv(), DATABASE_URL: 'postgresql://u:p@localhost:5432/tmanage' }),
      ),
    ).toContain('DATABASE_URL');
  });

  it('accepts a mariadb:// scheme as well as mysql://', () => {
    expect(() =>
      loadEnv({
        ...devEnv(),
        DATABASE_URL: 'mariadb://tmanage_app:pw@localhost:3306/tmanage',
        DATABASE_MIGRATION_URL: 'mariadb://tmanage_migrator:pw@localhost:3306/tmanage',
      }),
    ).not.toThrow();
  });

  it('rejects an unknown deployment profile rather than defaulting silently', () => {
    expect(issuePaths(() => loadEnv({ ...devEnv(), DEPLOYMENT_PROFILE: 'enterprise' }))).toContain(
      'DEPLOYMENT_PROFILE',
    );
  });

  it('reports every invalid variable in one error rather than one per restart', () => {
    const paths = issuePaths(() =>
      loadEnv({ ...devEnv(), API_PUBLIC_URL: 'not-a-url', DATABASE_URL: 'sqlite://x/y' }),
    );

    expect(paths).toContain('API_PUBLIC_URL');
    expect(paths).toContain('DATABASE_URL');
  });

  it('rejects a missing required variable instead of inventing a default', () => {
    const { DATABASE_URL: _omitted, ...withoutDatabase } = devEnv();

    expect(issuePaths(() => loadEnv(withoutDatabase))).toContain('DATABASE_URL');
  });

  describe('database user separation (ADR-0001 layer 2, 25-AUTH-AND-TENANT-ISOLATION §5)', () => {
    it('rejects a runtime user that is also the migration user', () => {
      const shared = 'mysql://tmanage_app:pw@localhost:3306/tmanage';

      expect(
        issuePaths(() =>
          loadEnv({ ...devEnv(), DATABASE_URL: shared, DATABASE_MIGRATION_URL: shared }),
        ),
      ).toContain('DATABASE_MIGRATION_URL');
    });
  });

  describe('storage', () => {
    it('requires credentials for the s3 driver', () => {
      const paths = issuePaths(() => loadEnv({ ...devEnv(), STORAGE_DRIVER: 's3' }));

      expect(paths).toContain('STORAGE_ACCESS_KEY_ID');
      expect(paths).toContain('STORAGE_SECRET_ACCESS_KEY');
    });

    it('does not require credentials for the filesystem substitute', () => {
      expect(() => loadEnv({ ...devEnv(), STORAGE_DRIVER: 'filesystem' })).not.toThrow();
    });

    it("defaults the organization storage quota to 50-BOOTSTRAP §5's 500 MB", () => {
      expect(loadEnv(devEnv()).STORAGE_ORG_BYTES_LIMIT_BYTES).toBe(524_288_000);
      expect(
        issuePaths(() => loadEnv({ ...devEnv(), STORAGE_ORG_BYTES_LIMIT_BYTES: '0' })),
      ).toContain('STORAGE_ORG_BYTES_LIMIT_BYTES');
    });

    it('caps authorized download URL lifetime at the five-minute spec limit', () => {
      expect(
        issuePaths(() => loadEnv({ ...devEnv(), STORAGE_DOWNLOAD_URL_TTL_SECONDS: '3600' })),
      ).toContain('STORAGE_DOWNLOAD_URL_TTL_SECONDS');
    });
  });

  describe('email', () => {
    it('requires a host for the smtp driver', () => {
      expect(issuePaths(() => loadEnv({ ...devEnv(), EMAIL_DRIVER: 'smtp' }))).toContain(
        'SMTP_HOST',
      );
    });

    it('requires nothing beyond the from-address for the console substitute', () => {
      expect(() => loadEnv({ ...devEnv(), EMAIL_DRIVER: 'console' })).not.toThrow();
    });

    it('refuses half a credential pair', () => {
      expect(
        issuePaths(() => loadEnv({ ...devEnv(), SMTP_USERNAME: 'no-reply@tmanage.example' })),
      ).toContain('SMTP_PASSWORD');
      expect(issuePaths(() => loadEnv({ ...devEnv(), SMTP_PASSWORD: 'pw' }))).toContain(
        'SMTP_USERNAME',
      );
    });

    it('reads SMTP_SECURE=false as false — the z.coerce.boolean trap this schema avoids', () => {
      expect(loadEnv({ ...devEnv(), SMTP_SECURE: 'false' }).SMTP_SECURE).toBe(false);
      expect(loadEnv({ ...devEnv(), SMTP_SECURE: 'true' }).SMTP_SECURE).toBe(true);
      // Anything that is not exactly true/false is a validation error, never a guess.
      expect(issuePaths(() => loadEnv({ ...devEnv(), SMTP_SECURE: 'yes' }))).toContain(
        'SMTP_SECURE',
      );
    });
  });

  describe('CORS', () => {
    it('rejects wildcard origins because the API is called with credentials', () => {
      expect(issuePaths(() => loadEnv({ ...devEnv(), CORS_ALLOWED_ORIGINS: '*' }))).toContain(
        'CORS_ALLOWED_ORIGINS',
      );
    });

    it('parses a comma-separated list into exact origins', () => {
      const env = loadEnv({
        ...devEnv(),
        CORS_ALLOWED_ORIGINS: 'http://localhost:3000, http://localhost:3001',
      });

      expect(env.CORS_ALLOWED_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:3001']);
    });
  });

  describe('production guardrails (ADR-0002)', () => {
    it('accepts a fully provisioned production environment', () => {
      expect(() => loadEnv(prodEnv())).not.toThrow();
    });

    it.each([
      ['QUEUE_DRIVER', 'memory'],
      ['CACHE_DRIVER', 'memory'],
      ['STORAGE_DRIVER', 'filesystem'],
      ['MALWARE_SCAN_DRIVER', 'stub'],
      ['EMAIL_DRIVER', 'console'],
    ])('refuses the %s development substitute "%s" in production', (key, value) => {
      expect(issuePaths(() => loadEnv(prodEnv({ [key]: value })))).toContain(key);
    });

    it.each(['SESSION_SECRET', 'CSRF_SECRET'])('refuses a placeholder %s in production', (key) => {
      const placeholder = `local_dev_only_${'x'.repeat(40)}`;

      expect(issuePaths(() => loadEnv(prodEnv({ [key]: placeholder })))).toContain(key);
    });

    it('refuses reusing one secret for both session and CSRF', () => {
      const same = 'c'.repeat(48);

      expect(
        issuePaths(() => loadEnv(prodEnv({ SESSION_SECRET: same, CSRF_SECRET: same }))),
      ).toContain('CSRF_SECRET');
    });

    it.each([
      ['API_PUBLIC_URL', { API_PUBLIC_URL: 'http://api.tmanage.example' }],
      ['WEB_PUBLIC_URL', { WEB_PUBLIC_URL: 'http://app.tmanage.example' }],
      ['CORS_ALLOWED_ORIGINS', { CORS_ALLOWED_ORIGINS: 'http://app.tmanage.example' }],
    ])('requires https for %s in production', (key, override) => {
      expect(issuePaths(() => loadEnv(prodEnv(override)))).toContain(key);
    });

    it('permits the same substitutes outside production', () => {
      expect(() =>
        loadEnv({
          ...devEnv(),
          QUEUE_DRIVER: 'memory',
          CACHE_DRIVER: 'memory',
          STORAGE_DRIVER: 'filesystem',
          MALWARE_SCAN_DRIVER: 'stub',
          EMAIL_DRIVER: 'console',
        }),
      ).not.toThrow();
    });
  });
});
