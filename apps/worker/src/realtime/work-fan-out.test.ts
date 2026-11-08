import { describe, expect, it } from 'vitest';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import {
  checkWorkTopicSubscription,
  hubTopicFor,
  isWorkTopic,
  workTopicVerdict,
} from '../common/database/work-topic-store.js';
import type { OutboxHandler } from '../outbox/dispatcher.js';
import { RealtimeHub } from './hub.js';
import type { RealtimeEventFrame } from './hub.js';
import { WORK_FRAME_EVENT_TYPES, createWorkFanOut, withWorkFanOut } from './work-fan-out.js';

/** 53-01: work events reach the project's and the people's topics; subscriptions are gated. */

const ORG = 'org-1';

function txReturning(rows: unknown[]): WorkerTransaction & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    query: async (text: string) => {
      sql.push(text);
      return rows;
    },
  } as unknown as WorkerTransaction & { sql: string[] };
}

function event(type: string, payload: Record<string, unknown>): ClaimedOutboxEvent {
  return { id: 'e1', organizationId: ORG, type, payload } as unknown as ClaimedOutboxEvent;
}

function listen(hub: RealtimeHub, key: string): RealtimeEventFrame[] {
  const got: RealtimeEventFrame[] = [];
  hub.subscribe(ORG, key, (frame) => got.push(frame));
  return got;
}

describe('work fan-out (53-01)', () => {
  it('frames the project, the project it left, and each related person as `me`', async () => {
    const hub = new RealtimeHub();
    const project = listen(hub, 'project:p2');
    const previous = listen(hub, 'project:p1');
    const owner = listen(hub, 'user:u-owner');
    const named = listen(hub, 'user:u-new');
    const fanOut = createWorkFanOut(hub);

    await fanOut(
      event('work_item.changed.v1', {
        workItemId: 'w1',
        projectId: 'p2',
        previousProjectId: 'p1',
        userIds: ['u-new'],
      }),
      txReturning([{ user_id: 'u-owner' }]),
      {} as never,
    );

    expect(project[0]).toMatchObject({
      eventType: 'work_item.changed.v1',
      conversationId: 'project:p2',
      objectId: 'w1',
    });
    expect(previous).toHaveLength(1);
    expect(owner[0]).toMatchObject({
      conversationId: 'me',
      objectId: 'w1',
      patch: { projectId: 'p2' },
    });
    expect(named).toHaveLength(1);
  });

  it('skips an unreadable payload instead of failing the event', async () => {
    const fanOut = createWorkFanOut(new RealtimeHub());
    await expect(
      fanOut(event('work_item.updated.v1', { nope: 1 }), txReturning([]), {} as never),
    ).resolves.toBeUndefined();
  });

  it('runs after the consumer already registered for each work event type', async () => {
    const order: string[] = [];
    const first: OutboxHandler = async () => void order.push('notice');
    const second: OutboxHandler = async () => void order.push('frame');
    const both =
      (a: OutboxHandler, b: OutboxHandler): OutboxHandler =>
      async (e, tx, fx) => {
        await a(e, tx, fx);
        await b(e, tx, fx);
      };
    const composed = withWorkFanOut({ 'work_item.comment_created.v1': first }, second, both);
    await composed['work_item.comment_created.v1']!(event('x', {}), txReturning([]), {} as never);
    expect(order).toEqual(['notice', 'frame']);
    for (const type of WORK_FRAME_EVENT_TYPES) expect(composed[type]).toBeTypeOf('function');
  });
});

describe('work topic subscriptions (53-01)', () => {
  it('maps `me` to the subscriber’s own user topic and recognises project topics', () => {
    expect(hubTopicFor('me', 'u1')).toBe('user:u1');
    expect(hubTopicFor('project:p1', 'u1')).toBe('project:p1');
    expect(isWorkTopic('project:p1')).toBe(true);
    expect(isWorkTopic('0190-conversation')).toBe(false);
  });

  it('needs work.read, and org-wide scope or a project membership for a project topic', () => {
    expect(workTopicVerdict({ role: 'member', has_org_wide_scope: 0, on_project: 1 }, true)).toBe(
      true,
    );
    expect(workTopicVerdict({ role: 'member', has_org_wide_scope: 0, on_project: 0 }, true)).toBe(
      false,
    );
    expect(
      workTopicVerdict({ role: 'member', has_org_wide_scope: 0, on_project: null }, false),
    ).toBe(true);
    expect(
      workTopicVerdict({ role: 'client_member', has_org_wide_scope: 0, on_project: 1 }, true),
    ).toBe(false);
    expect(workTopicVerdict(undefined, false)).toBe(false);
  });

  it('refuses somebody else’s personal topic without reading a row', async () => {
    const tx = txReturning([{ role: 'owner', has_org_wide_scope: 1, on_project: null }]);
    const verdict = await checkWorkTopicSubscription(tx, {
      organizationId: ORG,
      userId: 'u1',
      topic: 'user:u2',
    });
    expect(verdict.allowed).toBe(false);
    expect(tx.sql).toHaveLength(0);
    const own = await checkWorkTopicSubscription(tx, {
      organizationId: ORG,
      userId: 'u1',
      topic: 'me',
    });
    expect(own.allowed).toBe(true);
  });
});
