import { describe, expect, it, vi } from 'vitest';
import { OriginTlsMonitor, originTlsState, parseOriginAddress } from './origin-tls.js';
import type { OriginTlsReading } from './origin-tls.js';

const NOW = new Date('2026-10-29T08:00:00.000Z');
const DAY = 24 * 60 * 60 * 1_000;

function cert(daysLeft: number): OriginTlsReading {
  return {
    issuer: 'CN=CloudFlare Origin Certificate, O=CloudFlare, Inc.',
    subject: 'CN=CloudFlare Origin Certificate',
    notAfter: new Date(NOW.getTime() + daysLeft * DAY + 60_000).toISOString(),
    daysLeft,
  };
}

describe('origin TLS (56-30)', () => {
  it('reads not_configured without an address, fail when unreadable or ≤ 14 days, ok above', () => {
    expect(originTlsState(undefined, NOW)).toBe('not_configured');
    expect(originTlsState(null, NOW)).toBe('fail');
    expect(originTlsState(cert(14), NOW)).toBe('fail');
    expect(originTlsState(cert(15), NOW)).toBe('ok');
    expect(parseOriginAddress('[::1]:8443')).toEqual({ host: '::1', port: 8443 });
    expect(parseOriginAddress('203.0.113.7')).toEqual({ host: '203.0.113.7', port: 443 });
  });

  it('daysLeft=10 is fail with exactly one origin_tls:expiring alert per UTC day, one handshake per hour', async () => {
    const notify = vi.fn(() => Promise.resolve('sent'));
    const read = vi.fn(() => Promise.resolve(cert(10)));
    const monitor = new OriginTlsMonitor({ address: '127.0.0.1:443' }, () => ({ notify }), read);
    const first = await monitor.check(NOW);
    expect(first).toMatchObject({ state: 'fail', daysLeft: 10 });
    await monitor.check(new Date(NOW.getTime() + 30 * 60_000));
    await monitor.check(new Date(NOW.getTime() + 2 * 60 * 60_000));
    expect(read).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('origin_tls:expiring', { detail: 'daysLeft=10' });
    await monitor.check(new Date(NOW.getTime() + DAY));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('daysLeft=400 is ok and alerts nobody; no address never dials', async () => {
    const notify = vi.fn(() => Promise.resolve('sent'));
    const read = vi.fn(() => Promise.resolve(cert(400)));
    const ok = await new OriginTlsMonitor({ address: 'x:443' }, () => ({ notify }), read).check(
      NOW,
    );
    expect(ok.state).toBe('ok');
    expect(notify).not.toHaveBeenCalled();
    const off = await new OriginTlsMonitor({}, () => ({ notify }), read).check(NOW);
    expect(off).toEqual({ state: 'not_configured' });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
