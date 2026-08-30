import { z } from 'zod';

/**
 * Environment schema for every TManage process.
 *
 * Two rules govern this file:
 *
 * 1. **Fail loudly at boot.** A missing or malformed variable throws before the process
 *    serves a request. There are no silent fallbacks to an unsafe default — a mistyped
 *    `DATABASE_URL` must not quietly become localhost, and an absent `SESSION_SECRET`
 *    must not quietly become a constant.
 *
 * 2. **Development substitutes cannot reach production.** The `memory`, `filesystem`,
 *    `stub`, and `console` drivers exist for local work only (ADR-0002). When
 *    `NODE_ENV=production` they are rejected here, so the guarantee is a validation
 *    error rather than a code review that someone might skip.
 */

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} must not be empty`);

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();

/**
 * MySQL/MariaDB connection strings must be explicit about scheme so a typo cannot
 * silently work. The deployed database is Hostinger's MySQL-compatible MariaDB
 * (03-TECHNICAL-ARCHITECTURE §2); local development uses MariaDB via compose or an
 * embedded MySQL server (ADR-0002).
 */
const mysqlUrl = z
  .string()
  .trim()
  .refine(
    (v) => v.startsWith('mysql://') || v.startsWith('mariadb://'),
    'must be a mysql:// or mariadb:// connection string',
  );

/**
 * Placeholder secrets ship in `.env.example` so local setup is one copy command.
 * They must never authenticate anything real, so production rejects them by shape.
 */
const PLACEHOLDER_MARKERS = ['local_dev_only', 'change_me', 'changeme', 'example', 'placeholder'];

const secret = (label: string) =>
  z.string().min(32, `${label} must be at least 32 characters`).describe(label);

/** Comma-separated exact origins. Wildcards are never accepted — credentials are sent cross-origin. */
const originList = z
  .string()
  .trim()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(
    z
      .array(
        z
          .string()
          .url('each CORS origin must be an absolute URL')
          .refine((u) => !u.includes('*'), 'wildcard origins are not permitted'),
      )
      .min(1, 'at least one allowed origin is required'),
  );

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    /**
     * 50-BOOTSTRAP-DEPLOYMENT §9: "Add DEPLOYMENT_PROFILE=bootstrap|standard with schema
     * validation. It changes capacity/features, never authorization or data-integrity
     * rules."
     *
     * That constraint is why this value is read only by entitlement and feature-flag code.
     * Nothing in the authorization evaluator, the tenant guard, or any repository may
     * branch on it — a profile that could relax a permission would be a way to turn a
     * capacity setting into a security hole.
     */
    DEPLOYMENT_PROFILE: z.enum(['bootstrap', 'standard']).default('bootstrap'),

    // API
    API_PORT: port.default(4000),
    API_PUBLIC_URL: z.string().url(),
    WEB_PUBLIC_URL: z.string().url(),
    CORS_ALLOWED_ORIGINS: originList,

    // Database — two distinct users (ADR-0001 layer 2, 25-AUTH-AND-TENANT-ISOLATION §5).
    DATABASE_URL: mysqlUrl,
    DATABASE_MIGRATION_URL: mysqlUrl,
    // Hostinger's smallest Cloud plan has a tight connection allowance
    // (50-BOOTSTRAP §4: "a small bounded pool ... strict connection budgets matched to
    // the plan"), so this defaults low rather than to a typical server default.
    DATABASE_POOL_MAX: positiveInt.max(50).default(5),
    DATABASE_STATEMENT_TIMEOUT_MS: positiveInt.default(15_000),
    /**
     * ADR-0001 layer 3. `enforce` throws when a statement touches a tenant-owned table
     * without an `organization_id` predicate. `observe` only records a security event and
     * is intended for a documented incident, never as a default.
     */
    TENANT_GUARD_MODE: z.enum(['enforce', 'observe']).default('enforce'),

    // Redis-compatible
    REDIS_URL: z.string().trim().default('redis://localhost:6379'),
    QUEUE_DRIVER: z.enum(['redis', 'memory']).default('redis'),
    CACHE_DRIVER: z.enum(['redis', 'memory']).default('redis'),

    // Object storage
    STORAGE_DRIVER: z.enum(['s3', 'filesystem']).default('s3'),
    STORAGE_ENDPOINT: z.string().url().optional(),
    STORAGE_REGION: nonEmpty('STORAGE_REGION').default('us-east-1'),
    STORAGE_BUCKET: nonEmpty('STORAGE_BUCKET'),
    STORAGE_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
    STORAGE_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
    // 25-AUTH-AND-TENANT-ISOLATION §9 caps authorized download URLs at five minutes.
    STORAGE_DOWNLOAD_URL_TTL_SECONDS: positiveInt.max(300).default(300),
    STORAGE_UPLOAD_URL_TTL_SECONDS: positiveInt.max(3_600).default(900),
    STORAGE_FILESYSTEM_ROOT: z.string().default('.local/storage'),

    // Sessions and cryptography
    SESSION_COOKIE_NAME: nonEmpty('SESSION_COOKIE_NAME').default('tmanage_session'),
    SESSION_SECRET: secret('SESSION_SECRET'),
    SESSION_TTL_SECONDS: positiveInt.default(900),
    REFRESH_TTL_SECONDS: positiveInt.default(1_209_600),
    CSRF_SECRET: secret('CSRF_SECRET'),
    PASSWORD_ARGON2_MEMORY_KIB: positiveInt.default(19_456),
    PASSWORD_ARGON2_TIME_COST: positiveInt.default(2),
    PASSWORD_ARGON2_PARALLELISM: positiveInt.default(1),

    // ID-002's lockout window. `13-ENGINEERING-EXECUTION-SPEC` §1 assumes Redis for rate
    // limits; there is none on the shared host `50-BOOTSTRAP` targets, so this is counted
    // from `authentication_events`. Both values are per **user**, which is the limitation
    // recorded in `docs/implementation-status.md` rather than smoothed over here.
    AUTH_MAX_FAILURES_IN_WINDOW: positiveInt.default(5),
    AUTH_FAILURE_WINDOW_SECONDS: positiveInt.default(900),
    // The issuer an authenticator application shows beside the code. A brand string, not a
    // secret; it appears in the `otpauth://` URI and therefore in the QR code.
    AUTH_TOTP_ISSUER: nonEmpty('AUTH_TOTP_ISSUER').default('TManage'),

    // Invitations and client access
    INVITATION_TTL_HOURS: positiveInt.default(168),
    CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: positiveInt.default(180),

    // Idempotency
    IDEMPOTENCY_RETENTION_HOURS: positiveInt.default(24),

    // The outbox relay — PLAT-004, 24-EVENT-CATALOG §2.
    //
    // Batch size is capped low rather than high: 50-BOOTSTRAP §3's fallback runs the
    // dispatcher as controlled batches on a shared plan, and a batch is one transaction
    // holding row locks for its whole duration.
    OUTBOX_BATCH_SIZE: positiveInt.max(500).default(25),
    // After this many failed attempts an event is parked — reported, never claimed again
    // until an operator intervenes. §2's poison-event rule, without a second queue to lose.
    OUTBOX_MAX_ATTEMPTS: positiveInt.max(50).default(8),
    OUTBOX_POLL_INTERVAL_MS: positiveInt.default(5_000),
    // Exponential backoff: base * 2^(attempts-1), capped. §2 asks for exponential retry.
    OUTBOX_BACKOFF_BASE_MS: positiveInt.default(1_000),
    OUTBOX_BACKOFF_CAP_MS: positiveInt.default(900_000),

    // Realtime — RT-001, 13-ENGINEERING §6.
    //
    // 0 means the socket server does not start, which is the correct default on a host
    // that only runs the worker as controlled batches: a socket needs the persistent
    // process, and pretending otherwise would be a port nothing answers.
    REALTIME_PORT: z.coerce.number().int().min(0).max(65_535).default(0),
    // Sixty seconds is the intended order: the ticket authorizes the handshake only, and
    // every subscription is re-checked against current rows.
    REALTIME_TICKET_TTL_SECONDS: positiveInt.max(300).default(60),

    // Rate limiting
    RATE_LIMIT_WINDOW_SECONDS: positiveInt.default(60),
    RATE_LIMIT_MAX_REQUESTS: positiveInt.default(300),
    RATE_LIMIT_AUTH_MAX_REQUESTS: positiveInt.default(10),

    // Observability
    OTEL_SERVICE_NAME: nonEmpty('OTEL_SERVICE_NAME').default('tmanage-api'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
    OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(1),

    // Email
    EMAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
    EMAIL_FROM_ADDRESS: z.string().email(),
    EMAIL_FROM_NAME: nonEmpty('EMAIL_FROM_NAME').default('TManage'),

    // Files
    MALWARE_SCAN_DRIVER: z.enum(['stub', 'clamav']).default('stub'),
    MALWARE_SCAN_TIMEOUT_MS: positiveInt.default(30_000),
    UPLOAD_MAX_BYTES: positiveInt.default(104_857_600),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    // S3 driver needs credentials; the filesystem substitute does not.
    if (env.STORAGE_DRIVER === 's3') {
      if (!env.STORAGE_ACCESS_KEY_ID)
        fail('STORAGE_ACCESS_KEY_ID', 'required when STORAGE_DRIVER=s3');
      if (!env.STORAGE_SECRET_ACCESS_KEY)
        fail('STORAGE_SECRET_ACCESS_KEY', 'required when STORAGE_DRIVER=s3');
    }

    // The runtime and migration users must be distinct. MySQL has no row-level security,
    // so the credential boundary is one of the few controls that survives a bypass of
    // application code (ADR-0001 layer 2). A shared credential removes it entirely.
    if (env.DATABASE_URL === env.DATABASE_MIGRATION_URL) {
      fail(
        'DATABASE_MIGRATION_URL',
        'must differ from DATABASE_URL: the runtime user must not hold schema privileges',
      );
    }

    if (env.NODE_ENV !== 'production') return;

    // ── Production guardrails ────────────────────────────────────────────────
    const substitutes: ReadonlyArray<readonly [string, string, string]> = [
      ['QUEUE_DRIVER', env.QUEUE_DRIVER, 'memory'],
      ['CACHE_DRIVER', env.CACHE_DRIVER, 'memory'],
      ['STORAGE_DRIVER', env.STORAGE_DRIVER, 'filesystem'],
      ['MALWARE_SCAN_DRIVER', env.MALWARE_SCAN_DRIVER, 'stub'],
      ['EMAIL_DRIVER', env.EMAIL_DRIVER, 'console'],
    ];
    for (const [key, value, forbidden] of substitutes) {
      if (value === forbidden) {
        fail(key, `'${forbidden}' is a development substitute and is not permitted in production`);
      }
    }

    for (const key of ['SESSION_SECRET', 'CSRF_SECRET'] as const) {
      const value = env[key].toLowerCase();
      if (PLACEHOLDER_MARKERS.some((m) => value.includes(m))) {
        fail(key, 'looks like the .env.example placeholder; generate a real secret');
      }
    }

    if (env.SESSION_SECRET === env.CSRF_SECRET) {
      fail('CSRF_SECRET', 'must differ from SESSION_SECRET');
    }

    if (!env.API_PUBLIC_URL.startsWith('https://')) {
      fail('API_PUBLIC_URL', 'must use https in production');
    }
    if (!env.WEB_PUBLIC_URL.startsWith('https://')) {
      fail('WEB_PUBLIC_URL', 'must use https in production');
    }
    for (const origin of env.CORS_ALLOWED_ORIGINS) {
      if (!origin.startsWith('https://')) {
        fail('CORS_ALLOWED_ORIGINS', `origin ${origin} must use https in production`);
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Thrown at boot so the failure names every bad variable at once, not one per restart. */
export class EnvironmentValidationError extends Error {
  constructor(public readonly issues: readonly z.ZodIssue[]) {
    const detail = issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    super(`Invalid environment configuration:\n${detail}`);
    this.name = 'EnvironmentValidationError';
  }
}

/**
 * Parse and validate an environment bag.
 *
 * Deliberately takes `source` rather than reading `process.env` directly so tests can
 * exercise production guardrails without mutating global state.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) throw new EnvironmentValidationError(result.error.issues);
  return result.data;
}
