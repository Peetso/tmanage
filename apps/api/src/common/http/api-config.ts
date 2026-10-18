import { Global, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import {
  AUTH_ABUSE_MAX_PER_SOURCE_ACCOUNT_DEFAULT,
  parseSeedKeys,
  UPLOAD_PART_SIZE_DEFAULT_BYTES,
} from '@tmanage/config';
import type { SeedKeyring } from '@tmanage/config';
import { API_CONFIG } from './tokens.js';
import type { SessionServiceOptions } from '../../modules/identity/session.service.js';

/**
 * The settings the HTTP layer needs, resolved once at boot from `packages/config`.
 *
 * A narrow, explicit shape rather than the whole `Env` object. The guards and controllers can
 * then be constructed in a test with three fields instead of forty, and — more usefully — the
 * type says exactly which environment variables the request pipeline depends on.
 */
export interface ApiConfig extends SessionServiceOptions {
  /** `CSRF_SECRET`. Required by `packages/config` to differ from `SESSION_SECRET` in production. */
  readonly csrfSecret: string;
  /**
   * D07. `AUTH_MFA_SEED_KEYS`, parsed once at boot into the keyring the identity module's
   * seed cipher encrypts and decrypts TOTP seeds with. Parsed here rather than where it is
   * used so a malformed list is a boot failure, not the first enrolment's failure — and
   * kept as the keyring rather than the string so nothing downstream re-parses it.
   */
  readonly mfaSeedKeys: SeedKeyring;
  /**
   * The cookie the client reads the CSRF token from. Derived from `SESSION_COOKIE_NAME` so the
   * three cookies of one session share a prefix and cannot be configured out of alignment.
   */
  readonly csrfCookieName: string;
  /**
   * Whether the dev-only sign-in route exists at all.
   *
   * False in production, and the route is then **not registered** rather than registered and
   * refusing — see `identity.module.ts`.
   */
  readonly allowDevelopmentSignIn: boolean;
  /** `POST /public/site/contact` submissions admitted per address per window; absent = module default. */
  readonly contactMaxPerWindow?: number;
  readonly contactWindowMs?: number;
  /**
   * The one-time install secret that unlocks `/setup` (first-owner creation on an empty install).
   * `null` or absent = the setup routes are not registered at all. Never log or expose it.
   * Optional so the suites' hand-built `ApiConfig` literals keep compiling.
   */
  readonly setupToken?: string | null;
  /**
   * `PUBLIC_SIGNUP`. True registers the public sign-up routes; false (or absent, as in the
   * suites' hand-built literals) leaves them unregistered, so they 404.
   */
  readonly publicSignup?: boolean;
  /** ID-002. The lockout window, counted from `authentication_events` because there is no Redis. */
  readonly maxFailuresInWindow: number;
  readonly failureWindowSeconds: number;
  /** The issuer an authenticator application shows beside the code. */
  readonly totpIssuer: string;
  /**
   * CLIENT-001. How many days a client grant lasts when nobody states an expiry.
   *
   * A bounded grant is the default and an open-ended one is a deliberate act, which is the
   * whole reason `client_memberships.expires_at` exists. The number is `49-PRICING`'s policy,
   * so it lives in configuration rather than in the service that applies it.
   */
  readonly clientMembershipDefaultExpiryDays: number;
  /**
   * RT-001. How long a realtime ticket verifies. The ticket authorizes only the socket
   * handshake — every subscription is re-checked against current rows — so seconds is the
   * right order of magnitude and 300 is `packages/config`'s ceiling.
   */
  readonly realtimeTicketTtlSeconds: number;
  /**
   * RT-001. Where a browser reaches the socket, served beside the ticket. `null` means no
   * live socket exists in this deployment — the batch-mode truth — and screens then keep
   * their reload behaviour rather than dialing a port nothing answers.
   */
  readonly realtimeSocketUrl: string | null;
  /**
   * FILE-001. The three numbers an upload session is measured against: the pooled
   * organization quota (`STORAGE_ORG_BYTES_LIMIT_BYTES`), the largest single upload
   * (`UPLOAD_MAX_BYTES`, 50-BOOTSTRAP §5's 100 MB) and how long the presigned targets and
   * the session itself live (`STORAGE_UPLOAD_URL_TTL_SECONDS`). Configuration rather than
   * constants because `49-PRICING` §2 forbids hard-coding a limit, and rather than an
   * entitlement row because that table does not exist yet (ENT-001).
   */
  readonly storageOrgBytesLimit: number;
  readonly uploadMaxBytes: number;
  readonly uploadUrlTtlSeconds: number;
  /**
   * FILE-003. How many days a rejected / quarantined object's bytes are kept before the
   * retention-lifecycle job (`quarantine-cleanup.ts`) deletes the provider bytes and
   * decrements the counter. `49-PRICING` §5's documented expiry; the one seam that reads it
   * is the cleanup job's cutoff.
   */
  readonly fileRetentionRejectedDays: number;
  /**
   * FILE-001b. The size of one multipart part (`UPLOAD_PART_SIZE_BYTES`).
   * `packages/config`'s `UPLOAD_PART_SIZE_DEFAULT_BYTES` is the default — one definition,
   * read by the schema and by this file, so nothing here can drift from it; a suite lowers
   * it to drive a real multipart upload through the API in a few hundred bytes. The
   * transport's body limit is derived from it.
   */
  readonly uploadPartSizeBytes: number;
  /**
   * Security review 2026-09-04. `reserved` sessions one person may hold open at once in an
   * organization (`UPLOAD_MAX_OPEN_SESSIONS_PER_USER`); the next is 429 `rate_limited` with
   * an `upload_session.refused` row. The quota bounds bytes; this bounds the count.
   */
  readonly uploadMaxOpenSessionsPerUser: number;
  /**
   * D08. The four numbers `sign-in-abuse-control.ts` is built from: the window every budget
   * shares, and one budget per key — the address, the address-and-account pair, and every
   * address together. They bound the cost of an attempt *before* the user is read, which is
   * the one thing `maxFailuresInWindow` above cannot do: that counter is per user, and a
   * spray across accounts nobody has never reaches it.
   */
  readonly authAbuseWindowSeconds: number;
  readonly authAbuseMaxPerSource: number;
  readonly authAbuseMaxPerSourceAccount: number;
  readonly authAbuseMaxGlobal: number;
}

export interface ApiConfigSource {
  readonly NODE_ENV: 'development' | 'test' | 'production';
  /** The explicit opt-in for the development sign-in route; absent means off. */
  readonly ALLOW_DEV_SIGN_IN?: boolean;
  readonly RATE_LIMIT_CONTACT_MAX_REQUESTS?: number;
  readonly RATE_LIMIT_CONTACT_WINDOW_SECONDS?: number;
  /** First-owner setup secret; absent or empty = setup routes off. `| undefined` for EOPT. */
  readonly SETUP_TOKEN?: string | undefined;
  /** Public self-service sign-up; `packages/config` defaults it to true. */
  readonly PUBLIC_SIGNUP?: boolean;
  readonly SESSION_COOKIE_NAME: string;
  readonly SESSION_SECRET: string;
  readonly SESSION_TTL_SECONDS: number;
  readonly REFRESH_TTL_SECONDS: number;
  readonly CSRF_SECRET: string;
  /**
   * D07. Required rather than optional: a default would be a key nobody chose, and every
   * seed encrypted under it would be unreadable after the next restart that used a real one.
   */
  readonly AUTH_MFA_SEED_KEYS: string;
  readonly API_PUBLIC_URL: string;
  readonly AUTH_MAX_FAILURES_IN_WINDOW: number;
  readonly AUTH_FAILURE_WINDOW_SECONDS: number;
  readonly AUTH_TOTP_ISSUER: string;
  readonly CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: number;
  /** Optional so the suites' hand-built bags keep compiling; the default matches the env's. */
  readonly REALTIME_TICKET_TTL_SECONDS?: number;
  /** `| undefined` explicitly: `loadEnv`'s optional field arrives that way under EOPT. */
  readonly REALTIME_PUBLIC_URL?: string | undefined;
  /** FILE-001. Optional for the same reason as the realtime keys; defaults match the env's. */
  readonly STORAGE_ORG_BYTES_LIMIT_BYTES?: number;
  readonly UPLOAD_MAX_BYTES?: number;
  readonly STORAGE_UPLOAD_URL_TTL_SECONDS?: number;
  readonly UPLOAD_PART_SIZE_BYTES?: number;
  readonly UPLOAD_MAX_OPEN_SESSIONS_PER_USER?: number;
  /** FILE-003. Optional for the same reason as the storage keys above; the default matches the env's. */
  readonly FILE_RETENTION_REJECTED_DAYS?: number;
  /** D08. Optional for the same reason as the keys above; the defaults match the env's. */
  readonly RATE_LIMIT_AUTH_WINDOW_SECONDS?: number;
  readonly RATE_LIMIT_AUTH_MAX_PER_SOURCE?: number;
  readonly RATE_LIMIT_AUTH_MAX_REQUESTS?: number;
  readonly RATE_LIMIT_AUTH_MAX_GLOBAL?: number;
}

/**
 * The one path the refresh cookie is sent to.
 *
 * Scoping it keeps the long-lived credential out of every ordinary request, so an ordinary
 * request cannot leak it through a log, a proxy, or a crash report. It is a constant rather
 * than a setting because it has to match the route the controller declares, and two places
 * free to disagree is how a sign-out leaves a working refresh cookie behind.
 */
export const REFRESH_COOKIE_PATH = '/v1/sessions/refresh';

export function apiConfigFrom(env: ApiConfigSource): ApiConfig {
  return {
    cookieName: env.SESSION_COOKIE_NAME,
    sessionSecret: env.SESSION_SECRET,
    accessTtlSeconds: env.SESSION_TTL_SECONDS,
    refreshTtlSeconds: env.REFRESH_TTL_SECONDS,
    refreshCookiePath: REFRESH_COOKIE_PATH,
    // Plain HTTP is only ever local. `packages/config` already refuses a non-https
    // `API_PUBLIC_URL` in production, so this cannot silently be false there.
    secureCookies: env.API_PUBLIC_URL.startsWith('https://'),
    csrfSecret: env.CSRF_SECRET,
    // `packages/config` has already validated this string with the same parser, so a throw
    // here means a caller that built its own bag — which is a boot failure worth having.
    mfaSeedKeys: parseSeedKeys(env.AUTH_MFA_SEED_KEYS),
    csrfCookieName: `${env.SESSION_COOKIE_NAME}_csrf`,
    // A positive opt-in AND not production — never merely "NODE_ENV is not production", which
    // a missing or mistyped NODE_ENV satisfies (pre-launch security review 2026-10-17, HIGH).
    allowDevelopmentSignIn: env.ALLOW_DEV_SIGN_IN === true && env.NODE_ENV !== 'production',
    ...(env.RATE_LIMIT_CONTACT_MAX_REQUESTS === undefined
      ? {}
      : { contactMaxPerWindow: env.RATE_LIMIT_CONTACT_MAX_REQUESTS }),
    ...(env.RATE_LIMIT_CONTACT_WINDOW_SECONDS === undefined
      ? {}
      : { contactWindowMs: env.RATE_LIMIT_CONTACT_WINDOW_SECONDS * 1_000 }),
    setupToken: env.SETUP_TOKEN && env.SETUP_TOKEN.length > 0 ? env.SETUP_TOKEN : null,
    publicSignup: env.PUBLIC_SIGNUP === true,
    maxFailuresInWindow: env.AUTH_MAX_FAILURES_IN_WINDOW,
    failureWindowSeconds: env.AUTH_FAILURE_WINDOW_SECONDS,
    totpIssuer: env.AUTH_TOTP_ISSUER,
    clientMembershipDefaultExpiryDays: env.CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS,
    realtimeTicketTtlSeconds: env.REALTIME_TICKET_TTL_SECONDS ?? 60,
    realtimeSocketUrl: env.REALTIME_PUBLIC_URL ?? null,
    storageOrgBytesLimit: env.STORAGE_ORG_BYTES_LIMIT_BYTES ?? 524_288_000,
    uploadMaxBytes: env.UPLOAD_MAX_BYTES ?? 104_857_600,
    uploadUrlTtlSeconds: env.STORAGE_UPLOAD_URL_TTL_SECONDS ?? 900,
    fileRetentionRejectedDays: env.FILE_RETENTION_REJECTED_DAYS ?? 30,
    uploadPartSizeBytes: env.UPLOAD_PART_SIZE_BYTES ?? UPLOAD_PART_SIZE_DEFAULT_BYTES,
    uploadMaxOpenSessionsPerUser: env.UPLOAD_MAX_OPEN_SESSIONS_PER_USER ?? 20,
    authAbuseWindowSeconds: env.RATE_LIMIT_AUTH_WINDOW_SECONDS ?? 300,
    authAbuseMaxPerSource: env.RATE_LIMIT_AUTH_MAX_PER_SOURCE ?? 30,
    // Audit C-1: the fallback reads `packages/config`'s constant rather than repeating the
    // number, because a literal here could drift back above `AUTH_MAX_FAILURES_IN_WINDOW`
    // without the schema's refinement ever seeing it — this branch is taken exactly when a
    // caller builds its own source bag and the schema never ran.
    authAbuseMaxPerSourceAccount:
      env.RATE_LIMIT_AUTH_MAX_REQUESTS ?? AUTH_ABUSE_MAX_PER_SOURCE_ACCOUNT_DEFAULT,
    authAbuseMaxGlobal: env.RATE_LIMIT_AUTH_MAX_GLOBAL ?? 3000,
  };
}

/**
 * `ApiConfig`, made reachable from every module.
 *
 * `@Global` for the same reason `DatabaseModule` is: the guards live in the root module while
 * the services that need the same settings live in feature modules, and Nest scopes a provider
 * to the module that declares it unless told otherwise. Without this, `IdentityModule` cannot
 * see a token the root module provides — which is exactly the failure this module was added to
 * fix, and it surfaces as a resolution error naming an index rather than a name.
 *
 * Registering it once, globally, also means there is a single `ApiConfig` instance per
 * application: two modules each constructing their own from the same environment would be two
 * objects free to drift the moment one of them gained a default.
 */
@Global()
@Module({})
export class ApiConfigModule {
  static forConfig(config: ApiConfig): DynamicModule {
    const provider = { provide: API_CONFIG, useValue: config };
    return { module: ApiConfigModule, providers: [provider], exports: [provider] };
  }
}
