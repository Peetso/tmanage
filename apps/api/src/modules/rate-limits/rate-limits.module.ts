import { Logger, Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { PublicAbuseModule } from '../public-abuse/public-abuse.module.js';
import {
  DurableRateLimiter,
  HOUR_MS,
  createAnonymousCircuitBreaker,
  createMemoryBucketStore,
} from './durable-rate-limiter.js';
import { ANONYMOUS_CIRCUIT_BREAKER, DURABLE_RATE_LIMITER } from './durable-throttle.guard.js';
import { OrgQuotaCountersRepository } from './org-quota-counters.repository.js';
import { OrgQuotaService } from './org-quotas.js';
import { RateLimitBucketsRepository } from './rate-limit-buckets.repository.js';

export const ORG_QUOTA_SERVICE = Symbol.for('tmanage.OrgQuotaService');

/** Anonymous requests per process per minute before anonymous routes degrade (members unaffected). */
export const DEFAULT_BREAKER_MAX_PER_MINUTE = 3_000;

/**
 * 52-21: buckets are kept 26 h, not the limiter's default 2 h, so the abuse engine's day windows
 * (`pub_form_ip` 20 / day, `pub_form_slug`) survive the sweep. Still inside 56-05's privacy rule
 * ("hashed with a daily pepper, kept ≤ 48 h").
 */
export const BUCKET_RETAIN_MS = 26 * HOUR_MS;

export interface RateLimitsModuleOptions {
  /**
   * The secret the daily pepper is derived from: `PUBLIC_LINK_PEPPER` when it is configured,
   * otherwise an existing server secret (the CSRF secret). Never a literal, never logged.
   */
  readonly secret: string;
  readonly breakerMaxPerMinute?: number;
  /** `RATE_LIMIT_SCALE`: multiplies every ceiling and the breaker. 1 in production. */
  readonly limitScale?: number;
}

/**
 * 56-05 wiring. Global so the guard registered in `AppModule` (first among the `APP_GUARD`s) and
 * any feature that spends a quota can inject the limiter and the quota service by token.
 *
 * Without a database (a unit composition) the limiter runs on the in-process store: it still
 * limits, it only forgets on restart — the keyless, safe degradation.
 */
@Module({})
export class RateLimitsModule {
  static register(options: RateLimitsModuleOptions): DynamicModule {
    const logger = new Logger('RateLimits');
    const limiter: Provider = {
      provide: DURABLE_RATE_LIMITER,
      inject: [{ token: TENANT_DATABASE, optional: true }],
      useFactory: (database: TenantDatabase | null | undefined) =>
        new DurableRateLimiter({
          store: database ? new RateLimitBucketsRepository(database) : createMemoryBucketStore(),
          secret: options.secret,
          retainMs: BUCKET_RETAIN_MS,
          ...(options.limitScale === undefined ? {} : { limitScale: options.limitScale }),
          onStoreError: (error, policy) =>
            logger.warn(
              `rate-limit store unavailable (policy ${policy}): ${error instanceof Error ? error.name : 'unknown'}`,
            ),
        }),
    };
    const breaker: Provider = {
      provide: ANONYMOUS_CIRCUIT_BREAKER,
      useFactory: () =>
        createAnonymousCircuitBreaker({
          maxPerMinute:
            (options.breakerMaxPerMinute ?? DEFAULT_BREAKER_MAX_PER_MINUTE) *
            Math.max(1, options.limitScale ?? 1),
        }),
    };
    const quotas: Provider = {
      provide: ORG_QUOTA_SERVICE,
      inject: [{ token: TENANT_DATABASE, optional: true }],
      useFactory: (database: TenantDatabase | null | undefined) =>
        database ? new OrgQuotaService(new OrgQuotaCountersRepository(database)) : null,
    };
    return {
      module: RateLimitsModule,
      global: true,
      // 52-21: the public-endpoint abuse engine rides these buckets; registered from here so
      // `app.module.ts` is untouched. Global itself, so the public doors inject its guard.
      imports: [
        PublicAbuseModule.register({
          secret: options.secret,
          ...(options.limitScale === undefined ? {} : { limitScale: options.limitScale }),
        }),
      ],
      providers: [limiter, breaker, quotas],
      exports: [DURABLE_RATE_LIMITER, ANONYMOUS_CIRCUIT_BREAKER, ORG_QUOTA_SERVICE],
    };
  }
}
