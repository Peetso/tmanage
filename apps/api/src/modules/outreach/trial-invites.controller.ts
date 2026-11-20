import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import { Public } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { requireRequestState } from '../../common/http/request-state.js';
import type { ThrottleLimits } from '../rate-limits/durable-rate-limiter.js';
import { Throttle } from '../rate-limits/throttle-policies.js';
import type { TrialInviteView, TrialInvites } from './trial-invites.js';

export const TRIAL_INVITES = Symbol.for('tmanage.TrialInvites');

/** LANE-Q: a person opens their link once or twice; a scanner guessing tokens hits the wall. */
export const TRIAL_INVITE_LIMITS: ThrottleLimits = {
  perMinute: 10,
  perHour: 60,
  key: 'ip',
  onStoreError: 'closed',
};

interface PublicReply {
  header(name: string, value: string): unknown;
}

/**
 * LANE-Q — `GET /v1/public/trial-invites/:token` -> `{ company, email, language }`, the sign-up
 * form's pre-fill for a personal trial link. 404 for anything else, with the reason (`expired`,
 * `used`, `invalid`) in the details so the page can say which. Never cached, never indexed, no
 * referrer (the token is in the path).
 */
@Controller('v1/public/trial-invites')
export class PublicTrialInvitesController {
  constructor(@Inject(TRIAL_INVITES) private readonly invites: TrialInvites) {}

  @Get(':token')
  @Public()
  @Throttle('trial_invite_view', TRIAL_INVITE_LIMITS)
  async view(
    @Param('token') token: string,
    @Req() request: object,
    @Res({ passthrough: true }) reply: PublicReply,
  ): Promise<TrialInviteView> {
    reply.header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex');
    reply.header('referrer-policy', 'no-referrer');
    const found = await this.invites.lookup(token, requireRequestState(request).correlationId);
    if (found.kind !== 'valid') {
      throw new ApiError(404, 'not_found', 'This trial link cannot be used.', [
        { field: 'token', message: found.kind },
      ]);
    }
    return { company: found.company, email: found.email, language: found.language };
  }
}
