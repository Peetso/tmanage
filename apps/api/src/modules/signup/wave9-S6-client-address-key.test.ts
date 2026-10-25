import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { clientAddressKey, createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import type { SessionService } from '../identity/session.service.js';
import { ContactController } from '../public-site/contact.controller.js';
import type { MarketingLeadsRepository } from '../public-site/contact.repository.js';
import { PublicSignupController } from './public-signup.controller.js';
import type { PublicSignupService } from './public-signup.service.js';

/**
 * Wave 9 S6, audit run 1 NV03: the sign-up and contact-form limiters keyed every IPv6 address
 * separately, so one /64 (2^64 addresses) had no effective limit. Both now key on
 * `clientAddressKey`, which folds IPv6 to its /64 and IPv4-mapped IPv6 to the IPv4.
 */

const SAME_64 = [
  '2001:db8::1',
  '2001:db8::2',
  '2001:db8:0:0:ffff::3',
  '2001:0db8:0000:0000:1:2:3:4',
  '2001:db8::abcd%eth0',
  '2001:db8:0:0:9:9:9:9',
];

describe('clientAddressKey (NV03)', () => {
  it('six addresses in one /64 share one key; another /64 does not', () => {
    const keys = new Set(SAME_64.map(clientAddressKey));
    expect([...keys]).toEqual(['2001:db8:0:0::/64']);
    expect(clientAddressKey('2001:db8:0:1::1')).not.toBe(clientAddressKey('2001:db8::1'));
  });

  it('keeps IPv4 as it is and folds IPv4-mapped IPv6 to it', () => {
    expect(clientAddressKey('203.0.113.9')).toBe('203.0.113.9');
    expect(clientAddressKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientAddressKey('::ffff:cb00:7109')).toBe('203.0.113.9');
    expect(clientAddressKey(undefined)).toBe('unknown');
    expect(clientAddressKey('')).toBe('unknown');
    expect(clientAddressKey('x'.repeat(100))).toHaveLength(45);
  });
});

const fivePerWindow = () => createFixedWindowLimiter({ windowMs: 600_000, max: 5, now: () => 0 });

function requestFrom(ip: string) {
  const request = { headers: { 'user-agent': 'vitest' } as Record<string, string>, ip };
  ensureRequestState(request);
  return request;
}

describe('the public limiters share one budget per IPv6 /64 (NV03)', () => {
  it('public sign-up: the sixth address in one /64 gets 429; another /64 is admitted', async () => {
    const signUp = vi.fn(async () => ({
      userId: 'u',
      organizationId: 'o',
      slug: 'nile',
      organizationName: 'Nile',
    }));
    const start = vi.fn(async () => ({ cookies: [], csrfToken: 'c', expiresAt: new Date(0) }));
    const controller = new PublicSignupController(
      { signUp } as unknown as PublicSignupService,
      { start } as unknown as SessionService,
      fivePerWindow(),
      createFixedWindowLimiter({ windowMs: 600_000, max: 100 }),
    );
    const body = (i: number) => ({
      email: `person${i}@example.com`,
      displayName: 'P',
      password: 'x',
      organizationName: 'Org',
    });
    for (let i = 0; i < 5; i += 1) {
      await controller.signUp(body(i), requestFrom(SAME_64[i] as string), { header: vi.fn() });
    }
    await expect(
      controller.signUp(body(5), requestFrom(SAME_64[5] as string), { header: vi.fn() }),
    ).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
    expect(signUp).toHaveBeenCalledTimes(5);
    await expect(
      controller.signUp(body(6), requestFrom('2001:db8:0:1::1'), { header: vi.fn() }),
    ).resolves.toMatchObject({ status: 'authenticated' });
  });

  it('contact form: the sixth address in one /64 gets 429 and writes nothing', async () => {
    const insert = vi.fn(async () => ({ id: 'lead' }));
    const controller = new ContactController(
      { insert } as unknown as MarketingLeadsRepository,
      fivePerWindow(),
    );
    const body = { name: 'Ada', email: 'ada@example.com', message: 'A demo please.' };
    for (let i = 0; i < 5; i += 1) {
      await controller.submit({ ...body }, requestFrom(SAME_64[i] as string));
    }
    await expect(
      controller.submit({ ...body }, requestFrom(SAME_64[5] as string)),
    ).rejects.toMatchObject({ status: 429 });
    expect(insert).toHaveBeenCalledTimes(5);
    await expect(controller.submit({ ...body }, requestFrom('203.0.113.9'))).resolves.toBeDefined();
  });
});
