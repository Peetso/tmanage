import { Body, Controller, HttpCode, Inject, Post, Res } from '@nestjs/common';
import { Public } from '../../common/http/decorators.js';
import type { ThrottleLimits } from '../rate-limits/durable-rate-limiter.js';
import { Throttle } from '../rate-limits/throttle-policies.js';
import type { PublicRecordVerdictView } from './approval-record-verify.js';
import type { ApprovalRecordVerifyService } from './approval-record-verify.service.js';

/** Slice-private token, so `tokens.ts` stays untouched. */
export const APPROVAL_RECORD_VERIFY_SERVICE = Symbol.for('tmanage.ApprovalRecordVerify');

/**
 * A person checks one or two certificates; a script guessing IDs needs millions. 10 a minute and
 * 60 an hour per IP, closed when the bucket store is down (no unlimited guessing during an outage).
 */
export const RECORD_VERIFY_LIMITS: ThrottleLimits = {
  perMinute: 10,
  perHour: 60,
  key: 'ip',
  onStoreError: 'closed',
};

interface HeaderReply {
  header(name: string, value: string): unknown;
}

/**
 * 52-19 (web half) — the public "Verify this approval record" check behind `/verify`.
 *
 * `@Public()`: whoever holds a certificate may check it, with no account. It changes nothing, so
 * skipping CSRF costs nothing. POST rather than GET so the fingerprint is never in a URL, an access
 * log or a referrer. The answer is never cached or indexed; see the service for what it reveals.
 */
@Controller('v1/public/approval-records')
export class ApprovalRecordVerifyController {
  constructor(
    @Inject(APPROVAL_RECORD_VERIFY_SERVICE) private readonly service: ApprovalRecordVerifyService,
  ) {}

  @Post('verify')
  @Public()
  @HttpCode(200)
  @Throttle('approval_record_verify', RECORD_VERIFY_LIMITS)
  async verify(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<PublicRecordVerdictView> {
    reply.header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex, nofollow');
    reply.header('referrer-policy', 'no-referrer');
    return this.service.verify(body);
  }
}
