import { Controller, Header, HttpCode, Inject, Optional, Post, Req } from '@nestjs/common';
import { uuidv7 } from '@tmanage/domain';
import { Public } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { requestState } from '../../common/http/request-state.js';
import { Throttle } from '../rate-limits/throttle-policies.js';
import { verifyWebhookSignature } from '../inbound-email/inbound-mail-rules.js';
import {
  INBOUND_WEBHOOK_DEPS,
  webhookSecret,
} from '../inbound-email/inbound-webhook.controller.js';
import type { InboundWebhookDeps } from '../inbound-email/inbound-webhook.controller.js';
import { MAIL_BOUNCES_SERVICE } from './mail-bounces.controller.js';
import type { MailBouncesService } from './mail-bounces.service.js';

/**
 * 56-26 — `POST /v1/public/inbound-email/bounces`: the forwarder of the sending mailbox posts each
 * bounce — and each feedback-loop spam complaint (ARF) — it receives as the raw message
 * (`Content-Type: message/rfc822`, at most 1 MiB), signed
 * exactly like the inbound-mail webhook — the same platform secret `INBOUND_EMAIL_WEBHOOK_SECRET`
 * and headers:
 *
 * - `x-inbound-timestamp: <unix seconds>` (±300 s) and
 *   `x-inbound-signature: v1=<hex HMAC-SHA256(secret, timestamp + '.' + rawBody)>`, compared in
 *   constant time (`verifyWebhookSignature`).
 *
 * The raw bytes are kept for this route by the inbound module's `preParsing` hook
 * (`captureInboundRawBody`); its `message/rfc822` parser (body limit `MAX_BOUNCE_BYTES`, 413 above)
 * refuses every other URL with 415.
 *
 * Answers: 404 when no secret of at least 32 characters is configured (the feature is off), 413
 * over 1 MiB, 401 for any signature miss (never says which), else 200 `{ status: 'accepted' }` —
 * the same answer whether the bytes were a report, matched one of our messages or suppressed an
 * address, so the response tells the caller nothing about any address or company.
 * `Cache-Control: no-store`. Nothing from the bounce is logged.
 */

interface BounceRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawBody?: Buffer;
}

const header = (request: BounceRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

@Controller('v1/public/inbound-email')
export class BounceIntakeController {
  constructor(
    @Inject(MAIL_BOUNCES_SERVICE) private readonly bounces: MailBouncesService,
    @Optional() @Inject(INBOUND_WEBHOOK_DEPS) private readonly deps: InboundWebhookDeps = {},
  ) {}

  @Post('bounces')
  @Public()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle('inbound_email_bounce', {
    perMinute: 120,
    perHour: 2_000,
    key: 'ip',
    onStoreError: 'open',
  })
  async receive(@Req() request: BounceRequest): Promise<{ readonly status: 'accepted' }> {
    const secret = webhookSecret(this.deps);
    if (secret === null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'bounce_intake_off');
    }
    const verdict = verifyWebhookSignature({
      rawBody: request.rawBody,
      signature: header(request, 'x-inbound-signature'),
      timestamp: header(request, 'x-inbound-timestamp'),
      secret,
      now: (this.deps.now ?? (() => new Date()))(),
    });
    if (verdict !== 'valid') {
      throw new ApiError(
        401,
        'unauthenticated',
        'The request signature is invalid',
        undefined,
        'invalid_signature',
      );
    }
    const correlationId = requestState(request)?.correlationId ?? uuidv7();
    await this.bounces.record(request.rawBody as Buffer, correlationId);
    return { status: 'accepted' };
  }
}
