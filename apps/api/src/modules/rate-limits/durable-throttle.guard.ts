import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../../common/http/errors.js';
import { IS_PUBLIC } from '../../common/http/decorators.js';
import { clientAddressKey } from '../../common/http/rate-limiter.js';
import type {
  DurableRateLimiter,
  ThrottlePolicy,
  ThrottleSubject,
} from './durable-rate-limiter.js';
import {
  DEFAULT_PUBLIC_POLICY,
  PUBLIC_ROUTE_POLICIES,
  THROTTLE_POLICY,
} from './throttle-policies.js';

export const DURABLE_RATE_LIMITER = Symbol.for('tmanage.DurableRateLimiter');
export const ANONYMOUS_CIRCUIT_BREAKER = Symbol.for('tmanage.AnonymousCircuitBreaker');

/** The calm refusal the plan words (§56-05 UX flow); the client localises it by `rate_limited`. */
export const RATE_LIMITED_MESSAGE = 'Too many tries. Please wait a minute.';

interface RequestLike {
  readonly ip?: string;
  readonly params?: Record<string, unknown>;
  readonly headers?: Record<string, string | string[] | undefined>;
}
interface ReplyLike {
  header(name: string, value: string): unknown;
}

export interface CircuitBreakerLike {
  admit(at: Date): { admitted: boolean; retryAfterSeconds: number };
}

/**
 * 56-05 — the guard that charges every anonymous route to its durable budget.
 *
 * Registered first among the global guards, so a refused request costs one decision and nothing
 * else (no session lookup, no tenant resolution). It acts on:
 *
 * - a route with `@Throttle(...)` (handler wins over controller), whoever may call it;
 * - otherwise a `@Public()` route: its {@link PUBLIC_ROUTE_POLICIES} entry, else the default.
 *
 * A route behind a session with no `@Throttle` is passed straight through — members are not
 * limited here. A refusal is a 429 `rate_limited` with `Retry-After`; when the anonymous circuit
 * breaker is open, every anonymous route not marked `breakerExempt` is refused before the
 * database is asked anything.
 */
@Injectable()
export class DurableThrottleGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DURABLE_RATE_LIMITER) private readonly limiter: DurableRateLimiter,
    @Inject(ANONYMOUS_CIRCUIT_BREAKER) private readonly breaker: CircuitBreakerLike,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const explicit = this.reflector.getAllAndOverride<ThrottlePolicy | undefined>(
      THROTTLE_POLICY,
      targets,
    );
    const isPublic =
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets) === true;
    const policy = explicit ?? (isPublic ? policyForRoute(context) : undefined);
    if (policy === undefined) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<RequestLike>();
    const reply = http.getResponse<ReplyLike>();

    if (isPublic && policy.breakerExempt !== true) {
      const breaker = this.breaker.admit(new Date());
      if (!breaker.admitted) refuse(reply, breaker.retryAfterSeconds);
    }

    const decision = await this.limiter.check(policy, subjectOf(request, policy));
    if (!decision.admitted) refuse(reply, decision.retryAfterSeconds);
    return true;
  }
}

export function policyForRoute(context: ExecutionContext): ThrottlePolicy {
  const key = `${context.getClass().name}.${context.getHandler().name}`;
  return PUBLIC_ROUTE_POLICIES[key] ?? DEFAULT_PUBLIC_POLICY;
}

/** The raw key values this request offers. The address is what `trustProxy` resolved. */
export function subjectOf(request: RequestLike, policy: ThrottlePolicy): ThrottleSubject {
  const param = request.params?.[policy.linkParam ?? 'token'];
  const authorization = request.headers?.['authorization'];
  const bearer = typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/iu, '') : '';
  return {
    ip: clientAddressKey(request.ip),
    link: typeof param === 'string' ? param.slice(0, 512) : undefined,
    token: bearer === '' ? undefined : bearer.slice(0, 512),
  };
}

function refuse(reply: ReplyLike, retryAfterSeconds: number): never {
  reply.header('retry-after', String(retryAfterSeconds));
  throw new ApiError(429, 'rate_limited', RATE_LIMITED_MESSAGE);
}
