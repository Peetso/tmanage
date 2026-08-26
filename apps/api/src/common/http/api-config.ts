import { Global, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
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
}

export interface ApiConfigSource {
  readonly NODE_ENV: 'development' | 'test' | 'production';
  readonly SESSION_COOKIE_NAME: string;
  readonly SESSION_SECRET: string;
  readonly SESSION_TTL_SECONDS: number;
  readonly REFRESH_TTL_SECONDS: number;
  readonly CSRF_SECRET: string;
  readonly API_PUBLIC_URL: string;
  readonly AUTH_MAX_FAILURES_IN_WINDOW: number;
  readonly AUTH_FAILURE_WINDOW_SECONDS: number;
  readonly AUTH_TOTP_ISSUER: string;
  readonly CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: number;
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
    csrfCookieName: `${env.SESSION_COOKIE_NAME}_csrf`,
    allowDevelopmentSignIn: env.NODE_ENV !== 'production',
    maxFailuresInWindow: env.AUTH_MAX_FAILURES_IN_WINDOW,
    failureWindowSeconds: env.AUTH_FAILURE_WINDOW_SECONDS,
    totpIssuer: env.AUTH_TOTP_ISSUER,
    clientMembershipDefaultExpiryDays: env.CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS,
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
