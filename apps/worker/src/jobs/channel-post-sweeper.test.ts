import { describe, expect, it } from 'vitest';
import { settle } from './channel-post-sweeper.js';
import { WEBHOOK_BREAKER_THRESHOLD, decideAfterAttempt } from './webhook-retry-sweeper.js';

describe('channel post settlement (R15-c)', () => {
  const now = new Date('2026-11-02T12:00:00.000Z');
  const failure = { status: 'failure' as const, responseCode: 500, error: 'x' };

  it('retries in place below the breaker and pauses the link at 20 failures', () => {
    expect(settle(failure, decideAfterAttempt(failure, 1, 3), now)).toMatchObject({
      postStatus: 'staged',
      pause: null,
    });
    expect(settle(failure, decideAfterAttempt(failure, 2, WEBHOOK_BREAKER_THRESHOLD), now)).toEqual(
      {
        postStatus: 'failed',
        nextAttemptAt: null,
        pause: 'breaker_20_failures',
      },
    );
  });
});
