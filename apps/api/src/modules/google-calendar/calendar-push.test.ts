import { describe, expect, it, vi } from 'vitest';
import { hashSecret, newSecret, secretMatches } from './calendar-push.js';
import { CalendarFeedService, CalendarPushReceiver } from './calendar-sync.service.js';

const secret = newSecret();
const stored = { organizationId: 'o', id: 'c', watchTokenHash: hashSecret(secret) };
const db = (row: unknown) => ({
  bootstrapRead: vi.fn(async (_o: unknown, f: (d: unknown) => unknown) => f({})),
  row,
});
function receiver(row: unknown) {
  const pullSoon = vi.fn(async () => undefined);
  const database = db(row);
  const r = new CalendarPushReceiver(database as never, { pullSoon }, {
    findByWatchChannel: async () => row,
  } as never);
  return { r, pullSoon };
}
const google = (token: string, resource = 'res', state = 'exists') => ({
  'x-goog-channel-id': 'chan',
  'x-goog-channel-token': token,
  'x-goog-resource-id': resource,
  'x-goog-resource-state': state,
});

describe('53-14 calendar push verification', () => {
  it('a secret matches only its own hash', () => {
    expect(secretMatches(stored.watchTokenHash, secret)).toBe(true);
    expect(secretMatches(stored.watchTokenHash, newSecret())).toBe(false);
    expect(secretMatches(null, secret)).toBe(false);
  });

  it('Google: pulls only when the token and resource id match the stored channel', async () => {
    const { r, pullSoon } = receiver({ ...stored, provider: 'google', watchResourceId: 'res' });
    expect(await r.google(google(newSecret()), 'x')).toBe(401);
    expect(await r.google(google(secret, 'other'), 'x')).toBe(401);
    expect(await r.google(google(secret, 'res', 'sync'), 'x')).toBe(204);
    expect(pullSoon).not.toHaveBeenCalled();
    expect(await r.google(google(secret), 'x')).toBe(204);
    expect(pullSoon).toHaveBeenCalledTimes(1);
  });

  it('Graph: an entry with the wrong clientState pulls nothing', async () => {
    const { r, pullSoon } = receiver({ ...stored, provider: 'microsoft', watchResourceId: null });
    await r.microsoft({ value: [{ subscriptionId: 'sub', clientState: newSecret() }] }, 'x');
    expect(pullSoon).not.toHaveBeenCalled();
    await r.microsoft({ value: [{ subscriptionId: 'sub', clientState: secret }] }, 'x');
    expect(pullSoon).toHaveBeenCalledTimes(1);
  });

  it('ICS feed: a malformed or unknown address opens nothing', async () => {
    const database = db(null);
    const findByHash = vi.fn(async () => null);
    const feeds = new CalendarFeedService(
      database as never,
      {} as never,
      { apiPublicUrl: '', webPublicUrl: '' },
      { findByHash } as never,
      { resolve: vi.fn() } as never,
    );
    expect(await feeds.render('../etc', 'x')).toBeNull();
    expect(findByHash).not.toHaveBeenCalled();
    expect(await feeds.render(secret, 'x')).toBeNull();
    expect(findByHash).toHaveBeenCalledWith({}, hashSecret(secret));
  });
});
