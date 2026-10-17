import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../common/http/errors.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import { ContactController } from './contact.controller.js';
import type { MarketingLeadsRepository } from './contact.repository.js';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import { CONTACT_MAX_PER_WINDOW, CONTACT_WINDOW_MS } from './contact.module.js';

/**
 * x161 — the public contact / lead intake, proved without a database.
 *
 * `POST /public/site/contact` is the module's only unauthenticated write, so the properties under
 * test are the ones the untrusted-input boundary owns: a valid submission writes exactly one lead,
 * every bad input is a 400 that reaches the repository not at all, and there is no read path. The
 * repository is a spy so "no write on a rejected input" is a fact about the call, not a mock of one.
 */

function harness(admit: (key: string) => boolean = () => true) {
  const insert = vi.fn(async () => ({ id: '0199aa00-0000-7000-8000-0000000000f0' }));
  const repository = { insert } as unknown as MarketingLeadsRepository;
  const controller = new ContactController(repository, admit);
  const request = {
    headers: {} as Record<string, string | string[] | undefined>,
    ip: '203.0.113.7',
  };
  ensureRequestState(request);
  return { controller, insert, request };
}

const VALID = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  message: 'We would like a demo for our studio of six.',
};

describe('ContactController.submit rate limit (pre-launch security review §3)', () => {
  it('admits the window, then refuses the next submission from that address with a 429 and no write', async () => {
    let clock = 0;
    const limiter = createFixedWindowLimiter({
      windowMs: CONTACT_WINDOW_MS,
      max: CONTACT_MAX_PER_WINDOW,
      now: () => clock,
    });
    const { controller, insert, request } = harness(limiter);

    for (let i = 0; i < CONTACT_MAX_PER_WINDOW; i += 1) {
      await controller.submit({ ...VALID }, request);
    }
    expect(insert).toHaveBeenCalledTimes(CONTACT_MAX_PER_WINDOW);

    const refused = await controller.submit({ ...VALID }, request).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(429);
    expect((refused as ApiError).code).toBe('rate_limited');
    expect(insert).toHaveBeenCalledTimes(CONTACT_MAX_PER_WINDOW);

    // Another address has its own window; the same address is admitted again once it ends.
    await controller.submit({ ...VALID }, { ...request, ip: '198.51.100.9' });
    clock += CONTACT_WINDOW_MS;
    await controller.submit({ ...VALID }, request);
    expect(insert).toHaveBeenCalledTimes(CONTACT_MAX_PER_WINDOW + 2);
  });

  it('counts a malformed submission too, so invalid floods are refused before validation', async () => {
    const { controller, insert, request } = harness(() => false);
    const refused = await controller.submit({}, request).catch((error: unknown) => error);
    expect((refused as ApiError).status).toBe(429);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('ContactController.submit', () => {
  it('writes exactly one lead for a valid submission and reflects nothing stored', async () => {
    const { controller, insert, request } = harness();

    const view = await controller.submit({ ...VALID }, request);

    expect(view).toEqual({ status: 'received' });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        message: 'We would like a demo for our studio of six.',
        source: 'contact_form',
      }),
    );
    // The response carries no id and no stored value.
    expect(Object.keys(view)).toEqual(['status']);
  });

  it('trims fields and stores the trimmed value', async () => {
    const { controller, insert, request } = harness();
    await controller.submit(
      { name: '  Ada  ', email: '  ada@example.com  ', message: '  hello  ' },
      request,
    );
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Ada', email: 'ada@example.com', message: 'hello' }),
    );
  });

  it.each([
    ['empty body', {}],
    ['empty name', { ...VALID, name: '   ' }],
    ['empty message', { ...VALID, message: '' }],
    ['non-string name', { ...VALID, name: 42 }],
    ['malformed email — no @', { ...VALID, email: 'ada.example.com' }],
    ['malformed email — no domain dot', { ...VALID, email: 'ada@example' }],
    ['over-length name', { ...VALID, name: 'a'.repeat(201) }],
    ['over-length email', { ...VALID, email: `${'a'.repeat(250)}@e.com` }],
    ['over-length message', { ...VALID, message: 'a'.repeat(4001) }],
  ])('rejects %s with 400 and never writes', async (_label, body) => {
    const { controller, insert, request } = harness();

    await expect(controller.submit(body as never, request)).rejects.toMatchObject({
      status: 400,
      code: 'validation_failed',
    });
    await expect(controller.submit(body as never, request)).rejects.toBeInstanceOf(ApiError);
    expect(insert).not.toHaveBeenCalled();
  });

  it('exposes only the write handler — there is no read endpoint on this controller', () => {
    const handlers = Object.getOwnPropertyNames(ContactController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(handlers).toEqual(['submit']);
  });
});
