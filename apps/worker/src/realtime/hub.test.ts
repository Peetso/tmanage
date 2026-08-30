import { describe, expect, it } from 'vitest';
import { RealtimeHub } from './hub.js';
import type { RealtimeEventFrame } from './hub.js';

const frame = (conversationId: string): RealtimeEventFrame => ({
  type: 'event',
  eventType: 'message.created.v1',
  conversationId,
  objectId: 'msg-1',
  sequence: 7,
  patch: { parentMessageId: null },
});

describe('the realtime hub', () => {
  it('routes by organization AND conversation — same channel id, other tenant, silence', () => {
    const hub = new RealtimeHub();
    const heard: string[] = [];
    hub.subscribe('org-a', 'conv-1', () => heard.push('a'));
    hub.subscribe('org-b', 'conv-1', () => heard.push('b'));

    expect(hub.publish('org-a', 'conv-1', frame('conv-1'))).toBe(1);
    expect(heard).toEqual(['a']);
  });

  it('unsubscribe is complete: no frames after, and the room empties', () => {
    const hub = new RealtimeHub();
    const heard: RealtimeEventFrame[] = [];
    const unsubscribe = hub.subscribe('org-a', 'conv-1', (event) => heard.push(event));
    hub.publish('org-a', 'conv-1', frame('conv-1'));
    unsubscribe();
    hub.publish('org-a', 'conv-1', frame('conv-1'));

    expect(heard).toHaveLength(1);
    expect(hub.subscriberCount('org-a', 'conv-1')).toBe(0);
  });

  it('one listener throwing costs nobody else their frame', () => {
    const hub = new RealtimeHub();
    const heard: string[] = [];
    hub.subscribe('org-a', 'conv-1', () => {
      throw new Error('dead socket');
    });
    hub.subscribe('org-a', 'conv-1', () => heard.push('alive'));

    expect(hub.publish('org-a', 'conv-1', frame('conv-1'))).toBe(2);
    expect(heard).toEqual(['alive']);
  });
});
