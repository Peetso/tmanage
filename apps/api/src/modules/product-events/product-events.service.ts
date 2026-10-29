import { randomBytes } from 'node:crypto';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import type { RequestAdmission } from '../../common/http/rate-limiter.js';
import type {
  ProductEventsRepository,
  ScoreboardCountRow,
  ScoreboardTimerRow,
} from './product-events.repository.js';
import type { ProductEventPrincipalKind } from './product-events.registry.js';
import {
  EVENTS_PER_HOUR_PER_SESSION,
  K_ANONYMITY_FLOOR,
  hashActor,
  parseEventBatch,
} from './product-events.registry.js';

/** Weeks the scoreboard may look back: default 8, at most 26. */
export const SCOREBOARD_DEFAULT_WEEKS = 8;
export const SCOREBOARD_MAX_WEEKS = 26;

export interface ProductEventsScoreboardView {
  readonly since: string;
  readonly weeks: number;
  readonly kAnonymityFloor: number;
  readonly counts: readonly ScoreboardCountRow[];
  readonly timers: readonly ScoreboardTimerRow[];
}

export interface ProductEventsServiceOptions {
  readonly repository: ProductEventsRepository;
  /**
   * `PRODUCT_EVENTS_ACTOR_SALT`. Keyless is safe, not broken: without a salt of at least 16
   * characters the process draws a random one at start, so hashes are still unlinkable — they
   * only stop matching across a restart (fewer distinct-actor counts, never more disclosure).
   */
  readonly salt?: string | undefined;
  readonly now?: () => Date;
  readonly limiter?: RequestAdmission;
}

/** 55-21 — ingest (rate-limited, validated, hashed) and the platform scoreboard read. */
export class ProductEventsService {
  private readonly salt: string;
  private readonly now: () => Date;
  private readonly limiter: RequestAdmission;

  constructor(private readonly options: ProductEventsServiceOptions) {
    this.salt =
      typeof options.salt === 'string' && options.salt.length >= 16
        ? options.salt
        : randomBytes(32).toString('hex');
    this.now = options.now ?? (() => new Date());
    this.limiter =
      options.limiter ??
      createFixedWindowLimiter({ windowMs: 60 * 60 * 1000, max: EVENTS_PER_HOUR_PER_SESSION });
  }

  async ingest(
    context: TenantContext,
    principal: Principal,
    principalKind: ProductEventPrincipalKind,
    sessionId: string,
    body: unknown,
  ): Promise<{ accepted: number; droppedEvents: number; droppedProperties: number }> {
    if (!this.limiter(`product-events:${sessionId}`)) {
      throw new ApiError(429, 'rate_limited', 'Too many event batches; try again later.');
    }
    const now = this.now();
    const batch = parseEventBatch(body, now);
    await this.options.repository.insertBatch(
      context,
      { principalKind, actorHash: hashActor(this.salt, principal.membershipId, now) },
      batch.accepted,
    );
    return {
      accepted: batch.accepted.length,
      droppedEvents: batch.droppedEvents,
      droppedProperties: batch.droppedProperties,
    };
  }

  async scoreboard(correlationId: string, rawWeeks: unknown): Promise<ProductEventsScoreboardView> {
    const parsed = typeof rawWeeks === 'string' && rawWeeks !== '' ? Number(rawWeeks) : NaN;
    const weeks =
      Number.isInteger(parsed) && parsed >= 1 && parsed <= SCOREBOARD_MAX_WEEKS
        ? parsed
        : SCOREBOARD_DEFAULT_WEEKS;
    const since = new Date(this.now().getTime() - weeks * 7 * 24 * 60 * 60 * 1000);
    const { counts, timers } = await this.options.repository.scoreboard(correlationId, since);
    return {
      since: since.toISOString(),
      weeks,
      kAnonymityFloor: K_ANONYMITY_FLOOR,
      counts,
      timers,
    };
  }
}
