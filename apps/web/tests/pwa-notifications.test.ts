import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxBundle } from '@/lib/api/inbox';
import {
  MAX_NOTICES_PER_POLL,
  requestNotificationPermission,
  selectInboxNotices,
} from '@/components/pwa/notifications';

function bundle(overrides: Partial<InboxBundle> = {}): InboxBundle {
  return {
    bundleId: 'b1',
    objectType: 'work_item',
    objectId: 'o1',
    title: 'Kitchen remodel',
    state: 'open',
    projectId: 'p1',
    count: 1,
    unreadCount: 1,
    types: ['comment'],
    latestAt: '2026-10-16T10:00:00.000Z',
    action: { kind: 'open' },
    ...overrides,
  };
}

describe('requestNotificationPermission (opt-in logic)', () => {
  afterEach(() => {
    // Remove any stub so the "unsupported" case sees jsdom's own (absent) Notification.
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'Notification');
    vi.restoreAllMocks();
  });

  it('is a guarded no-op when the Notification API is absent', async () => {
    expect('Notification' in window).toBe(false);
    await expect(requestNotificationPermission()).resolves.toBe('unsupported');
  });

  it('issues the browser request only when the API is present, returning its result', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted');
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission: 'default', requestPermission },
    });

    await expect(requestNotificationPermission()).resolves.toBe('granted');
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });
});

describe('selectInboxNotices (bridge dedupe/throttle)', () => {
  it('skips read bundles and ones already seen, and keys change with the timestamp', () => {
    const seen = new Set<string>(['work_item:o1:2026-10-16T10:00:00.000Z']);
    const page = {
      items: [
        bundle(), // already seen → skipped
        bundle({ objectId: 'o2', unreadCount: 0 }), // nothing unread → skipped
        bundle({ objectId: 'o1', latestAt: '2026-10-16T11:00:00.000Z' }), // same object, newer → new
      ],
    };

    const drafts = selectInboxNotices(page, seen);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.key).toBe('work_item:o1:2026-10-16T11:00:00.000Z');
  });

  it('caps a large backlog to the per-poll throttle', () => {
    const items = Array.from({ length: MAX_NOTICES_PER_POLL + 4 }, (_, index) =>
      bundle({ objectId: `o${index}` }),
    );
    expect(selectInboxNotices({ items }, new Set())).toHaveLength(MAX_NOTICES_PER_POLL);
  });
});
