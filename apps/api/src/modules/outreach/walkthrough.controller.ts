import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { Public } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { Throttle } from '../rate-limits/throttle-policies.js';
import type { ThrottleLimits } from '../rate-limits/durable-rate-limiter.js';
import { MAX_WALKTHROUGH_BYTES } from './walkthrough-content.js';
import type { WalkthroughService } from './walkthrough.service.js';

export const WALKTHROUGH_SERVICE = Symbol.for('tmanage.WalkthroughService');

/** LANE-Q budget per source address: a visitor books once or twice, a script hits the wall. */
export const WALKTHROUGH_SUBMIT_LIMITS: ThrottleLimits = {
  perMinute: 3,
  perHour: 10,
  key: 'ip',
  onStoreError: 'closed',
};

interface PublicRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

interface PublicReply {
  header(name: string, value: string): unknown;
}

/** The acknowledgement: a reference to quote, and nothing that was stored. */
export interface WalkthroughSubmitView {
  readonly reference: string;
}

/**
 * LANE-Q — `POST /v1/public/walkthrough-requests` → `{ reference }`. No session, no tenant, no CSRF
 * (it establishes no authority). Rate-limited per source address by the durable limiter
 * (`walkthrough_submit`, closed when the store fails). Never cached, never indexed, no referrer.
 */
@Controller('v1/public/walkthrough-requests')
export class PublicWalkthroughController {
  constructor(@Inject(WALKTHROUGH_SERVICE) private readonly service: WalkthroughService) {}

  @Post()
  @Public()
  @Throttle('walkthrough_submit', WALKTHROUGH_SUBMIT_LIMITS)
  @HttpCode(201)
  async submit(
    @Body() body: unknown,
    @Req() request: PublicRequest,
    @Res({ passthrough: true }) reply: PublicReply,
  ): Promise<WalkthroughSubmitView> {
    reply.header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex');
    reply.header('referrer-policy', 'no-referrer');
    const fields =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Readonly<Record<string, unknown>>)
        : {};
    if (Buffer.byteLength(JSON.stringify(fields), 'utf8') > MAX_WALKTHROUGH_BYTES) {
      throw new ApiError(400, 'validation_failed', 'The request is too long.', [
        { field: 'body', message: `at most ${String(MAX_WALKTHROUGH_BYTES)} bytes` },
      ]);
    }
    const acceptLanguage = request.headers['accept-language'];
    const result = await this.service.submit({
      body: fields,
      ip: request.ip,
      acceptLanguage: typeof acceptLanguage === 'string' ? acceptLanguage : undefined,
      correlationId: requireRequestState(request).correlationId,
    });
    if (result.kind === 'rate_limited') {
      reply.header('retry-after', String(result.retryAfterSeconds));
      throw new ApiError(429, 'rate_limited', 'Too many requests. Try again later.');
    }
    return { reference: result.reference };
  }
}
