import { describe, expect, it } from 'vitest';
import { deliverPost, settle } from './channel-post-sweeper.js';
import type { ChannelPostDeps, ChannelPostStore, PostOutcome } from './channel-post-sweeper.js';
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

describe('channel posts after Slack and Teams were removed (FIX5)', () => {
  it('cancels a leftover staged post without reading the link or calling anybody', async () => {
    const touched: string[] = [];
    const outcomes: PostOutcome[] = [];
    const store = {
      loadLink: async () => (touched.push('loadLink'), null),
      loadEvent: async () => (touched.push('loadEvent'), null),
      orgSlug: async () => (touched.push('orgSlug'), null),
      saveLinkSecret: async () => void touched.push('saveLinkSecret'),
      finish: async (_org: string, _post: unknown, outcome: PostOutcome) => {
        outcomes.push(outcome);
        return { postStatus: 'cancelled' as const, nextAttemptAt: null, pause: null };
      },
    } as unknown as ChannelPostStore;
    const deps: ChannelPostDeps = {
      store,
      cipher: {
        decrypt: () => {
          throw new Error('must not decrypt');
        },
      } as unknown as ChannelPostDeps['cipher'],
      ownHosts: [],
      webBaseUrl: null,
      post: async () => {
        throw new Error('must not post');
      },
      botFetch: async () => {
        throw new Error('must not post');
      },
      retired: true,
    };
    const settled = await deliverPost(deps, 'org-1', {
      id: 'post-1',
      linkId: 'link-1',
      outboxEventId: 'event-1',
      eventKind: 'work.completed',
      locale: 'en',
      attempt: 0,
    });
    expect(settled.postStatus).toBe('cancelled');
    expect(outcomes).toEqual([
      { status: 'cancelled', responseCode: null, error: 'slack_teams_removed' },
    ]);
    expect(touched).toEqual([]);
  });
});
