import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { ChatFrame } from '../src/lib/chat-socket';
import {
  MY_WORK_TOPIC,
  isWorkFrame,
  projectWorkTopic,
  useWorkLiveRefresh,
} from '../src/lib/use-work-live-refresh';

/** 53-01: boards, lists and My Day refetch on a work frame for a followed topic, debounced. */

function fakeSocket() {
  const listeners = new Set<(frame: ChatFrame) => void>();
  const watched: string[] = [];
  const unwatched: string[] = [];
  return {
    watched,
    unwatched,
    emit: (frame: ChatFrame) => listeners.forEach((l) => l(frame)),
    socket: {
      listen: (l: (frame: ChatFrame) => void) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      watch: (topic: string) => {
        watched.push(topic);
        return () => void unwatched.push(topic);
      },
    },
  };
}

const api = new ApiClient({
  baseUrl: 'https://api.example.test',
  csrfCookieName: 'c',
  fetch: (() => Promise.reject(new Error('no network'))) as typeof globalThis.fetch,
  readCsrfToken: () => undefined,
  newCorrelationId: () => 'x',
});

const frame = (eventType: string, topic: string): ChatFrame => ({
  type: 'event',
  eventType,
  conversationId: topic,
  objectId: 'w1',
});

afterEach(() => vi.useRealTimers());

describe('work live refresh (53-01)', () => {
  it('accepts only work events on a followed topic', () => {
    const topics = new Set([projectWorkTopic('p1'), MY_WORK_TOPIC]);
    expect(isWorkFrame(frame('work_item.updated.v1', 'project:p1'), topics)).toBe(true);
    expect(isWorkFrame(frame('work_item.commented.v1', 'me'), topics)).toBe(true);
    expect(isWorkFrame(frame('work_item.updated.v1', 'project:p2'), topics)).toBe(false);
    expect(isWorkFrame(frame('message.created.v1', 'project:p1'), topics)).toBe(false);
    expect(isWorkFrame({ type: 'subscribed', conversationId: 'project:p1' }, topics)).toBe(false);
  });

  it('subscribes to its topics, refetches once per burst, and unsubscribes on unmount', () => {
    vi.useFakeTimers();
    const fake = fakeSocket();
    const onChange = vi.fn();
    const { unmount } = renderHook(() =>
      useWorkLiveRefresh({
        api,
        organizationSlug: 'acme',
        topics: ['project:p1'],
        onChange,
        socket: fake.socket,
      }),
    );
    expect(fake.watched).toEqual(['project:p1']);
    fake.emit(frame('work_item.created.v1', 'project:p1'));
    fake.emit(frame('work_item.changed.v1', 'project:p1'));
    vi.advanceTimersByTime(500);
    expect(onChange).toHaveBeenCalledTimes(1);
    unmount();
    expect(fake.unwatched).toEqual(['project:p1']);
  });
});
