import { z } from 'zod';
import { parseSeedKeys } from './seed-keys.js';
import { parseTrustedProxies } from './trusted-proxies.js';

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
 *    error rather than a code review that someone might skip. The `local` storage driver
 *    is not a substitute: it is the production driver for a single host (Hostinger
 *    shared hosting), with its root checked to sit outside any web root.
 */

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} must not be empty`);

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();

/**
 * FILE-001b. One multipart part, 8 MiB by default: above S3's 5 MiB minimum, small enough
 * that a retry is cheap. The one definition — `apps/api` reads it from here rather than
 * keeping a copy that could drift from the schema's default.
 */
export const UPLOAD_PART_SIZE_DEFAULT_BYTES = 8_388_608;
/**
 * The bounds on `UPLOAD_PART_SIZE_BYTES`. The part size is also the largest body the API's
 * transport buffers for one request, so the ceiling is a memory decision: 64 MiB. The floor
 * keeps a mistyped value from minting tens of thousands of parts for one file.
 */
export const UPLOAD_PART_SIZE_MIN_BYTES = 1_024;
export const UPLOAD_PART_SIZE_MAX_BYTES = 67_108_864;
/**
 * The largest part number the API's part route accepts (`upload-parts.controller.ts`). The
 * refinement below keeps `UPLOAD_MAX_BYTES / UPLOAD_PART_SIZE_BYTES` under it, so a session
 * is never minted a target the route would refuse.
 */
export const UPLOAD_MAX_PART_NUMBER = 99_999;

/**
 * ID-002's durable, per-**user** lockout threshold: this many `bad_password` rows inside
 * `AUTH_FAILURE_WINDOW_SECONDS` and the account is `locked_out`.
 *
 * Exported because `AUTH_ABUSE_MAX_PER_SOURCE_ACCOUNT_DEFAULT` below is only meaningful
 * relative to it, and two literals free to drift apart is exactly the failure the
 * refinement at the bottom of this file exists to refuse.
 */
export const AUTH_MAX_FAILURES_IN_WINDOW_DEFAULT = 5;
/**
 * Security audit 2026-09-12, finding C-1. The in-process budget for one source address
 * grinding one account (`RATE_LIMIT_AUTH_MAX_REQUESTS`), which **must stay strictly below**
 * `AUTH_MAX_FAILURES_IN_WINDOW_DEFAULT`.
 *
 * It shipped at 10 against a lockout threshold of 5, and ten is larger than five. That
 * inverted the whole point of the narrow key: five wrong passwords from one address sat
 * comfortably inside the budget and drove any *known* account into a 900-second
 * `locked_out`, renewably, for the price of five requests a quarter-hour from one IP. The
 * victim had no way out either — `confirmReauthentication` reads the *same*
 * `countRecentFailures` window, and re-authentication is the only gate to `setPassword`, so
 * a locked-out person could not change their password to escape.
 *
 * Four, not five: the relation has to be strict, or the budget is spent on the very attempt
 * that trips the lockout. Four is also comfortably above ordinary use — the source+account
 * key is the *narrow* one, and a person retyping their own password four times in five
 * minutes against one account is already unusual; the per-address ceiling they actually
 * live under is `RATE_LIMIT_AUTH_MAX_PER_SOURCE` (30).
 *
 * **What this does not fix, stated here so nobody reads it as solved.** The two windows are
 * different lengths — this budget is per `RATE_LIMIT_AUTH_WINDOW_SECONDS` (300 s) while the
 * lockout counts over `AUTH_FAILURE_WINDOW_SECONDS` (900 s) — so one address still gets
 * 4 × 3 = 12 admitted failures inside one lockout window, which is more than 5. The
 * single-address lockout is therefore made slower and noisier, **not impossible**: it now
 * costs a first window to arm instead of landing on the fifth request. Closing it properly
 * means not letting a *wrong* password deny a *right* one — verify first, and apply the
 * durable window only to the failing path — which is a behaviour change to
 * `authentication.service.ts`, not a number, and is recorded as the next item rather than
 * smuggled in here. No value of this constant closes it: the relation that would
 * (`budget × ceil(900/300) < 5`) forces it to 1, which refuses a real person their second
 * try, and success is not exempt from the count.
 */
export const AUTH_ABUSE_MAX_PER_SOURCE_ACCOUNT_DEFAULT = 4;

/**
 * Connection strings must be explicit about scheme so a typo cannot silently work — the
 * check exists to refuse a leftover `postgres://` URL at boot rather than at first query.
 *
 * The engine is MySQL: locally via `compose.yaml` or the embedded server (ADR-0002), and
 * deployed on Hostinger. `mariadb://` is still accepted as a spelling, not as a second
 * engine — a string written that way is handed to `mysql2` unchanged and connects to the
 * same MySQL server, so rejecting it would break a boot for no gain.
 */
/**
 * The user a connection string names, for the checks that are about *who* connects.
 * `DATABASE_URL !== DATABASE_MIGRATION_URL` compares strings, and one credential with a
 * query string appended passes it; the user is what the privilege boundary is made of.
 * A string the URL parser refuses is compared whole, so an odd but working DSN is not
 * refused for being odd.
 */
function databaseUser(url: string): string {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return url;
  }
}

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
/**
 * Path segments that name a web root on common hosts. `STORAGE_LOCAL_ROOT` may contain none
 * of them, so a stored object can never be served directly by the web server.
 */
const WEB_ROOT_SEGMENTS: ReadonlySet<string> = new Set([
  'public_html',
  'public',
  'www',
  'wwwroot',
  'htdocs',
  'httpdocs',
  'html',
  'static',
  '.next',
  'out',
]);

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

/**
 * The default session cookie name. Exported because the browser derives the readable CSRF
 * cookie's name from it (`${SESSION_COOKIE_NAME}_csrf`) and must default to the same value:
 * review finding D02 (2026-09-05) was the two defaults disagreeing. `apps/web` cannot import
 * this package into a browser bundle, so it carries a copy and a test holds the two equal.
 */
export const SESSION_COOKIE_NAME_DEFAULT = 'tmanage_session';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /**
     * The development sign-in route (`POST /v1/dev/sessions`, a session for any user id with no
     * password) needs this positive opt-in. Default `false`, so a deployment whose NODE_ENV is
     * missing or mistyped does NOT expose it (pre-launch security review 2026-10-17, HIGH); and
     * `true` is refused outright in production. Local development and the e2e stack set it.
     */
    ALLOW_DEV_SIGN_IN: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
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
    /**
     * D09. The peers whose `X-Forwarded-*` headers are believed — a comma-separated list of
     * addresses and CIDR ranges — and nobody else's. **Unset means trust nobody**, so an
     * origin with no proxy in front of it reads the socket peer and gets the truth without
     * configuring anything; an operator who does run behind a proxy names it.
     *
     * The parsed value is handed to Fastify's `trustProxy` as it stands (`false`, or the
     * list): see `trusted-proxies.ts` for why the shape is the two Fastify forms rather than
     * a hop count, and why a malformed list fails here instead of quietly becoming `false`.
     */
    TRUSTED_PROXY_ADDRESSES: z
      .string()
      .default('')
      .transform((value, ctx) => {
        try {
          return parseTrustedProxies(value);
        } catch (error) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof Error ? error.message : 'is not a valid address list',
          });
          return z.NEVER;
        }
      }),

    // Database — two distinct users (ADR-0001 layer 2, 25-AUTH-AND-TENANT-ISOLATION §5).
    DATABASE_URL: mysqlUrl,
    DATABASE_MIGRATION_URL: mysqlUrl,
    /**
     * The relay's own credential — `tmanage_worker` in `scripts/db/users.sql`, which can
     * mark outbox rows and append audit rows and delete nothing (`25-AUTH-AND-TENANT-
     * ISOLATION` §2, §10: background work under minimal privileges). Optional outside
     * production, where the worker falls back to `DATABASE_URL` and says so at boot;
     * required in production, where the fallback would be the API's user doing the
     * worker's job. Security review 2026-09-04.
     */
    WORKER_DATABASE_URL: mysqlUrl.optional(),
    /**
     * Single-database-user hosting. Hostinger's shared plans give a database exactly ONE user,
     * so the three-credential split above cannot be provisioned there. `true` is the explicit
     * acknowledgement that the runtime, migration and worker connections are the same user —
     * which removes ADR-0001 layer 2 (the credential boundary) and nothing else: every other
     * guardrail, production ones included, still applies. Default `false`, under which the
     * distinct-user checks stand exactly as before. The Hostinger bundle sets it, and says so
     * at boot, only when it was given a single credential.
     */
    DATABASE_SINGLE_USER: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
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
    STORAGE_DRIVER: z.enum(['s3', 'filesystem', 'local']).default('s3'),
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
    /**
     * The production root for `STORAGE_DRIVER=local` (one host, no object store). Required
     * when that driver is named; must be absolute and outside `public_html` and any other
     * web root, so a stored object is never served by the web server without the API's
     * permission checks. Checked by shape here and again on disk at API boot by
     * `prepareLocalStorageRoot`.
     */
    STORAGE_LOCAL_ROOT: z.string().optional(),
    /**
     * FILE-001b. Signs the part URLs the API serves itself when `STORAGE_DRIVER=filesystem`
     * (ADR-0002's local substitute) or `STORAGE_DRIVER=local` (the single-host production
     * driver). Its own secret, never `SESSION_SECRET` or `CSRF_SECRET`:
     * the URL authorizes an anonymous byte sink, and a key shared with a session credential
     * would make one leak two. Required by the `superRefine` below exactly when the
     * filesystem or local driver is named — the s3 credentials pattern.
     */
    STORAGE_LOCAL_SIGNING_SECRET: secret('STORAGE_LOCAL_SIGNING_SECRET').optional(),
    /**
     * FILE-001. The pooled storage quota one organization may reserve against, in bytes.
     * 50-BOOTSTRAP §5's private-alpha value (500 MB) is the default; `49-PRICING` §3's plan
     * entitlements replace this variable when `organization_entitlements` exists (ENT-001).
     * One seam reads it: `storageLimitsFor` in the API's files module.
     */
    STORAGE_ORG_BYTES_LIMIT_BYTES: positiveInt.default(524_288_000),
    /**
     * FILE-003. How long a rejected / quarantined object's bytes are kept before the
     * retention-lifecycle job deletes the provider bytes and gives the counted bytes back —
     * `49-PRICING` §5's "recoverable trash until its documented expiry". The pack names no
     * value (decision F4 is delegated); thirty days is the default, long enough for a
     * disputed rejection to be looked at and short enough that a tenant is not billed for
     * quarantined evidence indefinitely. `FILE_RETENTION_*` so a later object class (aborted
     * parts, derived previews) adds its own window as a sibling rather than a schema change.
     */
    FILE_RETENTION_REJECTED_DAYS: positiveInt.default(30),

    // Sessions and cryptography
    SESSION_COOKIE_NAME: nonEmpty('SESSION_COOKIE_NAME').default(SESSION_COOKIE_NAME_DEFAULT),
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
    AUTH_MAX_FAILURES_IN_WINDOW: positiveInt.default(AUTH_MAX_FAILURES_IN_WINDOW_DEFAULT),
    AUTH_FAILURE_WINDOW_SECONDS: positiveInt.default(900),
    // The issuer an authenticator application shows beside the code. A brand string, not a
    // secret; it appears in the `otpauth://` URI and therefore in the QR code.
    AUTH_TOTP_ISSUER: nonEmpty('AUTH_TOTP_ISSUER').default('TManage'),
    /**
     * D07. The keys TOTP seeds are encrypted with, `<version>:<base64url 32 bytes>` entries
     * separated by `;` — `seed-keys.ts` owns the format and this validates with that same
     * parser, so what boots is exactly what the cipher will accept.
     *
     * Required in **every** environment, unlike the storage signing secret's driver
     * condition. Making it optional would mean a fallback, and the only fallbacks available
     * are storing plaintext again or inventing a key that changes on restart — the first
     * undoes D07 silently, the second locks every enrolled user out just as silently.
     */
    AUTH_MFA_SEED_KEYS: z.string().superRefine((value, ctx) => {
      try {
        parseSeedKeys(value);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : 'is not a valid key list',
        });
      }
    }),

    /**
     * 56-02. The FieldCipher keyring: `<id>:<base64 32 bytes>` entries separated by `;`, highest id
     * active (`openssl rand -base64 32`). Optional: without it FieldCipher reports "disabled" and
     * every feature that would store a recoverable secret refuses instead of storing plaintext.
     */
    FIELD_CIPHER_KEYS: z
      .string()
      .optional()
      .refine(
        (value) =>
          value === undefined ||
          value.trim() === '' ||
          value
            .trim()
            .split(';')
            .every((entry) =>
              /^[1-9]\d{0,8}:(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9_-]{43})$/.test(entry.trim()),
            ),
        {
          message:
            'entries must be <id>:<32-byte key from `openssl rand -base64 32`>, ";"-separated',
        },
      ),

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
    // H2 (L5, NFR-06): a realtime frame waits on average half a poll, so 5 s gave p95 4.5 s
    // against a 1 s target (250 ms measured p95 251 ms). A few light reads a second when idle.
    OUTBOX_POLL_INTERVAL_MS: positiveInt.default(500),
    // Exponential backoff: base * 2^(attempts-1), capped. §2 asks for exponential retry.
    OUTBOX_BACKOFF_BASE_MS: positiveInt.default(1_000),
    OUTBOX_BACKOFF_CAP_MS: positiveInt.default(900_000),

    // Is the relay draining? — the worker/outbox audit's CRITICAL-2.
    //
    // A healthy idle worker and a dead one produce the same logs (none) and the same
    // `relay:once` exit code (0). What separates them is how old the oldest undelivered
    // event is, and how long ago a batch last finished. Both are thresholds rather than
    // alarms: the worker reports the numbers, and cron's or a monitor's own failure
    // reporting is the alarm.
    //
    // 900 s is deliberately several times the loop's poll interval *and* comfortably more
    // than a sensible cron period, so a single slow batch or a skipped tick is not a page.
    // Tighten it wherever delivery latency actually matters.
    OUTBOX_BACKLOG_MAX_AGE_SECONDS: positiveInt.default(900),
    OUTBOX_HEARTBEAT_MAX_AGE_SECONDS: positiveInt.default(900),
    // Where a completed batch records the time, for a later `relay:status` — or any monitor
    // that can stat a file — to read. Absent means no heartbeat is kept, which is honest on
    // a host with no writable path and leaves backlog age as the only reading.
    // Empty means "keep no heartbeat", the same "absent means off" shape `OTEL_EXPORTER_URL` uses
    // for a disabled exporter — normalised to `undefined` so the worker has one absence to test.
    //
    // `.env.example` ships a real path (`var/worker-heartbeat.json`) rather than an empty one:
    // shipped empty, the reading that separates "drained and idle" from "dead with an empty
    // queue" was absent from the default deployment, so a relay that died on Friday with a
    // drained queue reported ok all weekend. The *schema* default stays absent on purpose —
    // making "unconfigured" degraded would delete the `heartbeatConfigured` distinction that
    // CRITICAL-A turns on, and page every host that legitimately keeps no heartbeat.
    OUTBOX_HEARTBEAT_FILE: z
      .string()
      .trim()
      .transform((value) => (value === '' ? undefined : value))
      .optional(),

    // Realtime — RT-001, 13-ENGINEERING §6.
    //
    // 0 means the socket server does not start, which is the correct default on a host
    // that only runs the worker as controlled batches: a socket needs the persistent
    // process, and pretending otherwise would be a port nothing answers.
    REALTIME_PORT: z.coerce.number().int().min(0).max(65_535).default(0),
    // Sixty seconds is the intended order: the ticket authorizes the handshake only, and
    // every subscription is re-checked against current rows.
    REALTIME_TICKET_TTL_SECONDS: positiveInt.max(300).default(60),
    // Where a browser reaches the socket — a deployment fact the API serves beside the
    // ticket, never something the client guesses. Absent means "no live socket here",
    // which is the truth wherever the worker runs as controlled batches.
    REALTIME_PUBLIC_URL: z
      .string()
      .trim()
      .refine(
        (v) => v.startsWith('ws://') || v.startsWith('wss://'),
        'must be a ws:// or wss:// URL',
      )
      .optional(),

    // Rate limiting
    RATE_LIMIT_WINDOW_SECONDS: positiveInt.default(60),
    RATE_LIMIT_MAX_REQUESTS: positiveInt.default(300),
    // The public contact form's per-address budget (pre-launch security review 2026-10-17, §3):
    // a person sends one or two; the ceiling only has to stop a script filling marketing_leads.
    RATE_LIMIT_CONTACT_MAX_REQUESTS: positiveInt.default(5),
    RATE_LIMIT_CONTACT_WINDOW_SECONDS: positiveInt.default(600),
    /**
     * One-time install secret for the first-owner setup (no public sign-up exists). Set it in
     * hPanel, open /setup, create the first owner, then delete the variable and restart. With
     * it unset the setup routes are not registered at all. Empty (hPanel's blank field) means
     * unset, the same "absent means off" shape `OUTBOX_HEARTBEAT_FILE` uses.
     */
    SETUP_TOKEN: z
      .string()
      .transform((value) => (value === '' ? undefined : value))
      .pipe(secret('SETUP_TOKEN').optional())
      .optional(),
    /**
     * Public self-service sign-up (/sign-up). ON when unset — Peter opened it for testing on
     * 2026-10-18. `off` (or false / 0 / no) removes the API routes (404) and the web links.
     */
    /**
     * "Continue with Google" (OpenID Connect, scopes openid email profile). Both set = the
     * button shows and /v1/auth/google/* exists; either unset (or blank) = no button, routes 404.
     * The OAuth client must list <WEB_PUBLIC_URL>/v1/auth/google/callback as a redirect URI.
     */
    GOOGLE_CLIENT_ID: z
      .string()
      .optional()
      .transform((value) =>
        value === undefined || value.trim() === '' ? undefined : value.trim(),
      ),
    GOOGLE_CLIENT_SECRET: z
      .string()
      .optional()
      .transform((value) =>
        value === undefined || value.trim() === '' ? undefined : value.trim(),
      ),
    /**
     * Platform admin (/platform): the comma list of verified emails that may operate the whole
     * TManage service. Compared case-insensitively. Unset or empty = the feature is off (404).
     * No organization role ever reaches it.
     */
    PLATFORM_ADMIN_EMAILS: z
      .string()
      .optional()
      .transform((value) => (value === undefined || value.trim() === '' ? undefined : value)),
    /**
     * C10. Operator alerts: the comma list of addresses (the owner(s) of the account that runs
     * this TManage service) mailed on an unhandled server error or a failed background job, at
     * most once per 15 minutes per kind, through the app's own mailer. Unset or empty = off.
     */
    ALERT_EMAILS: z
      .string()
      .optional()
      .transform((value) => (value === undefined || value.trim() === '' ? undefined : value)),
    PUBLIC_SIGNUP: z
      .string()
      .optional()
      .transform(
        (value) => !['off', 'false', '0', 'no'].includes((value ?? '').trim().toLowerCase()),
      ),
    /**
     * D08. The sign-in abuse control's budgets, one shared window, one number per key:
     * `RATE_LIMIT_AUTH_MAX_REQUESTS` bounds source+account (one address grinding one
     * account), `RATE_LIMIT_AUTH_MAX_PER_SOURCE` bounds the address across every account it
     * names, and `RATE_LIMIT_AUTH_MAX_GLOBAL` bounds every address together — the one an
     * attacker rotating addresses cannot evade.
     *
     * `RATE_LIMIT_AUTH_MAX_REQUESTS` is the one of the four that is **not** free to choose:
     * it must stay strictly below `AUTH_MAX_FAILURES_IN_WINDOW`, and the refinement at the
     * bottom of this file refuses to boot a configuration where it is not. See
     * `AUTH_ABUSE_MAX_PER_SOURCE_ACCOUNT_DEFAULT` at the top of this file for why (audit
     * C-1), including what the relation still does not buy.
     *
     * These are ceilings for the bootstrap profile, not a traffic plan: they are set where
     * ordinary use never reaches them, and lowering them is a deliberate act. The per-source
     * default is 30 rather than 5 because success is not exempt from the count, so a real
     * person retyping a password must not be able to reach it.
     *
     * What that 30 actually buys: 30 charges per address per five minutes across all four
     * authentication routes together — password, MFA, recovery, reauthentication — which is
     * roughly fifteen complete MFA sign-ins. The arithmetic is worth doing out loud, because
     * "30 attempts" reads as thirty sign-ins and is not: a person with a second factor spends
     * **two** charges to sign in once, the password post and the completion post, so 30 is
     * 15 complete logins and not 30; changing a password on top of that spends a third on
     * `/v1/auth/reauth`. Wherever egress is shared it is a per-office ceiling and not a
     * per-person one — fifteen complete logins per five minutes for everything behind the
     * address. It self-heals the moment the window turns, and it is the number an operator
     * behind NAT should expect to raise.
     *
     * The global budget is unevadable in both directions, and that cuts against the
     * deployment as much as for it: nobody can rotate addresses past it, and anybody who
     * spends it refuses everybody — password, MFA, recovery and reauthentication alike —
     * until the window turns. That is why it is 3000 (about ten a second) rather than 600.
     *
     * A twenty-source spray is still cheap, and D09 did not make it expensive: it made
     * `request.ip` *authentic* (`TRUSTED_PROXY_ADDRESSES` above), not *scarce*. A caller on a
     * single IPv6 /64 has 2^64 real addresses to spray from, and a caller behind a **badly
     * configured** trusted proxy still writes the value outright — one that forwards their
     * `X-Forwarded-For` untouched, one that prepends its own observation instead of appending
     * it, or a trusted range wide enough to contain them. (An *appending* proxy is the safe
     * shape, not the dangerous one; `docs/runbooks/deploy.md` has the measured table.) At 600
     * that spray buys a repeatable authentication outage for about two
     * requests a second; at 3000 the same outage costs an attacker real sustained traffic,
     * while the Argon2 and log cost the budget exists to bound is still bounded.
     */
    RATE_LIMIT_AUTH_MAX_REQUESTS: positiveInt.default(AUTH_ABUSE_MAX_PER_SOURCE_ACCOUNT_DEFAULT),
    RATE_LIMIT_AUTH_WINDOW_SECONDS: positiveInt.default(300),
    RATE_LIMIT_AUTH_MAX_PER_SOURCE: positiveInt.default(30),
    RATE_LIMIT_AUTH_MAX_GLOBAL: positiveInt.default(3000),

    // Observability
    //
    // OBS-001 owns exactly two exporter variables — `OTEL_ENABLED` and `OTEL_EXPORTER_URL` below —
    // and no more. The OTel-standard names (`OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
    // `OTEL_TRACES_SAMPLER_ARG`) were declared here before the exporter existed and were read
    // nowhere: no `tracer` or boot guard consumed them, so an operator setting the standard
    // endpoint got a boot pass and no export — a silent config trap. They are removed until the
    // OpenTelemetry SDK follow-up lands and can read whichever name it standardises on; OBS-001
    // itself names none, so nothing here keeps a dead alias alive.
    /**
     * OBS-001. The trace-export master switch, off by default. Not `z.coerce.boolean()` — that is
     * `Boolean(value)`, so the string `"false"` would coerce to `true` (the SMTP_SECURE reasoning
     * above); the enum makes `OTEL_ENABLED=false` mean no. When it is on, `OTEL_EXPORTER_URL` is
     * required by the `superRefine` below, so an enabled exporter with nowhere to send spans is a
     * loud boot failure rather than telemetry that silently disappears.
     */
    OTEL_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    /** Where spans are exported when `OTEL_ENABLED=true`. Absent (and unused) when disabled. */
    OTEL_EXPORTER_URL: z.string().url().optional(),

    // Email
    EMAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
    EMAIL_FROM_ADDRESS: z.string().email(),
    EMAIL_FROM_NAME: nonEmpty('EMAIL_FROM_NAME').default('TManage'),
    // The SMTP submission endpoint the `smtp` driver dials. Optional here and required by
    // the `superRefine` below exactly when EMAIL_DRIVER=smtp — the s3 credentials pattern.
    // 587 is RFC 6409 submission; Hostinger's mail service (the 50-BOOTSTRAP host) uses it
    // with STARTTLS, and 465 with SMTP_SECURE=true is the implicit-TLS alternative.
    SMTP_HOST: nonEmpty('SMTP_HOST').optional(),
    SMTP_PORT: port.default(587),
    SMTP_USERNAME: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    /**
     * Implicit TLS from the first byte (port 465). `false` means the connection starts in
     * plain text and upgrades via STARTTLS when the server offers it.
     *
     * Not `z.coerce.boolean()`, deliberately: that is `Boolean(value)`, so the string
     * `"false"` would coerce to `true` — a mail credential sent down a connection the
     * operator explicitly marked insecure-first. The enum makes `SMTP_SECURE=false` mean no.
     */
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    // Files. FILE-002 slice B: `none` is a real member, legal in production — the honest
    // bootstrap value (`50-BOOTSTRAP` §39: scanning "feature-flagged or processed
    // conservatively"). Under it the scan pass records every verified version `unscanned`
    // once and leaves the asset at `scanning`: nothing becomes `ready`, nothing is
    // promoted, nothing is served. `stub` marks everything clean and stays a development
    // substitute; `clamav` dials a clamd at CLAMAV_HOST:CLAMAV_PORT (INSTREAM).
    MALWARE_SCAN_DRIVER: z.enum(['none', 'stub', 'clamav']).default('stub'),
    /** One object's whole scan — connect, stream, reply. The connect alone is capped separately. */
    MALWARE_SCAN_TIMEOUT_MS: positiveInt.default(30_000),
    CLAMAV_HOST: nonEmpty('CLAMAV_HOST').optional(),
    CLAMAV_PORT: port.default(3310),
    UPLOAD_MAX_BYTES: positiveInt.default(104_857_600),
    /**
     * FILE-001b. The size of one multipart part, `UPLOAD_PART_SIZE_DEFAULT_BYTES` (8 MiB)
     * by default, bounded because the API buffers one part per request. Configurable so a
     * harness can drive a real multipart upload at a small size; the database suite sets
     * its sixteen bytes directly on `ApiConfig`, below this floor, and the real size is
     * proved once, in the browser journey (E2E-12a).
     */
    UPLOAD_PART_SIZE_BYTES: positiveInt
      .min(UPLOAD_PART_SIZE_MIN_BYTES)
      .max(UPLOAD_PART_SIZE_MAX_BYTES)
      .default(UPLOAD_PART_SIZE_DEFAULT_BYTES),
    /**
     * Security review 2026-09-04. How many `reserved` upload sessions one person may hold
     * open at once in one organization. The quota bounds the bytes, not the count: without
     * this, one account with `file.upload` could open one-byte reservations without end,
     * each a provider upload and a directory (`26-THREAT-MODELS` §5 "quota abuse"). The
     * twenty-first is refused 429 and recorded; a completion, a cancel or the sweep makes
     * room. Nothing in the pack names a value; twenty is a person, not a script.
     */
    UPLOAD_MAX_OPEN_SESSIONS_PER_USER: positiveInt.default(20),
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
    // The filesystem and local drivers sign their own URLs, so they need a key of their own.
    if (
      (env.STORAGE_DRIVER === 'filesystem' || env.STORAGE_DRIVER === 'local') &&
      !env.STORAGE_LOCAL_SIGNING_SECRET
    ) {
      fail('STORAGE_LOCAL_SIGNING_SECRET', `required when STORAGE_DRIVER=${env.STORAGE_DRIVER}`);
    }
    // The local driver's root must be absolute and outside any web root. This is the shape
    // check; `prepareLocalStorageRoot` re-checks the resolved directory on disk at API boot.
    if (env.STORAGE_DRIVER === 'local') {
      const root = env.STORAGE_LOCAL_ROOT;
      if (root === undefined || root.trim() === '') {
        fail('STORAGE_LOCAL_ROOT', 'required when STORAGE_DRIVER=local');
      } else {
        const segments = root.split(/[\\/]/);
        if (!/^\//.test(root) && !/^[A-Za-z]:[\\/]/.test(root)) {
          fail('STORAGE_LOCAL_ROOT', 'must be an absolute path');
        }
        if (root.includes('\0')) {
          fail('STORAGE_LOCAL_ROOT', 'must not contain a NUL byte');
        }
        if (segments.includes('..')) {
          fail('STORAGE_LOCAL_ROOT', "must not contain a '..' segment");
        }
        if (segments.some((segment) => WEB_ROOT_SEGMENTS.has(segment.toLowerCase()))) {
          fail('STORAGE_LOCAL_ROOT', 'must be outside public_html and any web root');
        }
      }
    }
    // A file at the upload ceiling must fit in the part numbers the part route accepts.
    if (Math.ceil(env.UPLOAD_MAX_BYTES / env.UPLOAD_PART_SIZE_BYTES) > UPLOAD_MAX_PART_NUMBER) {
      const floor = Math.ceil(env.UPLOAD_MAX_BYTES / UPLOAD_MAX_PART_NUMBER);
      fail(
        'UPLOAD_PART_SIZE_BYTES',
        `must be at least ${floor} for UPLOAD_MAX_BYTES=${env.UPLOAD_MAX_BYTES}: a file at the ceiling may have at most ${UPLOAD_MAX_PART_NUMBER} parts`,
      );
    }

    // The smtp driver needs a host; the console substitute needs nothing. Credentials are a
    // pair or absent — a username with no password is a misconfiguration that would
    // otherwise surface as an authentication refusal at the first send rather than at boot.
    if (env.EMAIL_DRIVER === 'smtp' && !env.SMTP_HOST) {
      fail('SMTP_HOST', 'required when EMAIL_DRIVER=smtp');
    }
    if (env.MALWARE_SCAN_DRIVER === 'clamav' && !env.CLAMAV_HOST) {
      fail('CLAMAV_HOST', 'required when MALWARE_SCAN_DRIVER=clamav');
    }
    if (env.SMTP_USERNAME !== undefined && env.SMTP_PASSWORD === undefined) {
      fail('SMTP_PASSWORD', 'required when SMTP_USERNAME is set');
    }
    if (env.SMTP_PASSWORD !== undefined && env.SMTP_USERNAME === undefined) {
      fail('SMTP_USERNAME', 'required when SMTP_PASSWORD is set');
    }

    // Security audit 2026-09-12, C-1. The narrow abuse budget must stop one address
    // *before* that address can reach the durable per-user lockout, or the lockout stops
    // being a protection and becomes a remotely triggered outage the account holder cannot
    // clear: `confirmReauthentication` reads the same counter, so a locked-out person
    // cannot even change their password to escape it.
    //
    // Checked in every environment, not only production. A development or test deployment
    // with the inverted relation is where the inversion gets copied from, and this is the
    // relation `id-002-credentials.db.test.ts` already asserts of its own literals — here it
    // is asserted of the configuration that actually boots.
    if (env.RATE_LIMIT_AUTH_MAX_REQUESTS >= env.AUTH_MAX_FAILURES_IN_WINDOW) {
      fail(
        'RATE_LIMIT_AUTH_MAX_REQUESTS',
        `must be strictly below AUTH_MAX_FAILURES_IN_WINDOW (${env.RATE_LIMIT_AUTH_MAX_REQUESTS} >= ${env.AUTH_MAX_FAILURES_IN_WINDOW}): one address could then drive any known account into the ${env.AUTH_FAILURE_WINDOW_SECONDS}s lockout, which the account holder cannot clear`,
      );
    }

    // OBS-001. An enabled exporter with no endpoint would accept every span and drop it —
    // telemetry that looks configured and silently goes nowhere. Fail loudly at boot instead,
    // in every environment (a misconfigured dev deployment is where the mistake is copied from).
    if (env.OTEL_ENABLED && !env.OTEL_EXPORTER_URL) {
      fail(
        'OTEL_EXPORTER_URL',
        'is required when OTEL_ENABLED=true: an enabled exporter with no endpoint drops every span',
      );
    }

    // The runtime and migration users must be distinct. MySQL has no row-level security,
    // so the credential boundary is one of the few controls that survives a bypass of
    // application code (ADR-0001 layer 2). A shared credential removes it entirely.
    if (!env.DATABASE_SINGLE_USER && env.DATABASE_URL === env.DATABASE_MIGRATION_URL) {
      fail(
        'DATABASE_MIGRATION_URL',
        'must differ from DATABASE_URL: the runtime user must not hold schema privileges',
      );
    }

    if (env.NODE_ENV !== 'production') return;

    // The password-less development sign-in can never be switched on in production.
    if (env.ALLOW_DEV_SIGN_IN) {
      fail('ALLOW_DEV_SIGN_IN', 'must not be true in production: it mints a session for any user');
    }

    // ── Production guardrails ────────────────────────────────────────────────
    // Two URLs differing is not two users differing. The string check above is what the
    // e2e stack relies on (one embedded root credential, a driver parameter appended —
    // `e2e/setup/stack.ts`), so the user comparison is a production guardrail: there the
    // boundary is real, and `?x=1` must not be how it is passed.
    if (!env.DATABASE_SINGLE_USER) {
      if (databaseUser(env.DATABASE_URL) === databaseUser(env.DATABASE_MIGRATION_URL)) {
        fail(
          'DATABASE_MIGRATION_URL',
          'must name a different database user from DATABASE_URL, not the same user twice',
        );
      }
      if (env.WORKER_DATABASE_URL === undefined) {
        fail(
          'WORKER_DATABASE_URL',
          'is required in production: the relay runs as its own least-privilege user (25 §10)',
        );
      } else {
        const worker = databaseUser(env.WORKER_DATABASE_URL);
        if (worker === databaseUser(env.DATABASE_URL)) {
          fail('WORKER_DATABASE_URL', 'must name a different database user from DATABASE_URL');
        }
        if (worker === databaseUser(env.DATABASE_MIGRATION_URL)) {
          fail('WORKER_DATABASE_URL', 'must not name the migration user');
        }
      }
    }
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

    // The signing secret is in both loops: production refuses the filesystem driver above,
    // but the `local` driver uses this secret in production, and an operator who leaves it
    // in a production `.env` copied from staging is told either way. Checked only when present.
    const secrets: ReadonlyArray<readonly [string, string | undefined]> = [
      ['SESSION_SECRET', env.SESSION_SECRET],
      ['CSRF_SECRET', env.CSRF_SECRET],
      ['STORAGE_LOCAL_SIGNING_SECRET', env.STORAGE_LOCAL_SIGNING_SECRET],
      // D07. The example key is a real, working 32-byte key — it has to be, or local
      // development would not start — so nothing else would stop it encrypting production
      // seeds. `local_dev_only` is spelled inside its base64url text for exactly this check.
      ['AUTH_MFA_SEED_KEYS', env.AUTH_MFA_SEED_KEYS],
      // The install token is a credential too while it is set: a copied placeholder or a reused
      // session secret would let anyone who knows one of them create the first owner.
      ['SETUP_TOKEN', env.SETUP_TOKEN],
      // 56-02. Compared as a whole by the pairwise check below; a key reused inside another
      // keyring is caught by the worker/API at start with `sharedKeyIds` (field-cipher.ts).
      ['FIELD_CIPHER_KEYS', env.FIELD_CIPHER_KEYS],
    ];
    for (const [key, value] of secrets) {
      if (value === undefined) continue;
      if (PLACEHOLDER_MARKERS.some((m) => value.toLowerCase().includes(m))) {
        fail(key, 'looks like the .env.example placeholder; generate a real secret');
      }
    }

    // All pairs distinct, not only the first two: three credentials with one value are
    // one credential.
    secrets.forEach(([key, value], index) => {
      if (value === undefined) return;
      for (const [other, otherValue] of secrets.slice(0, index)) {
        if (value === otherValue) fail(key, `must differ from ${other}`);
      }
    });

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
