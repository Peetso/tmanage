import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../common/http/errors.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import { ContactController } from './contact.controller.js';
import type { MarketingLeadsRepository } from './contact.repository.js';

/**
 * x161 — the public contact / lead intake, proved without a database.
 *
 * `POST /public/site/contact` is the module's only unauthenticated write, so the properties under
 * test are the ones the untrusted-input boundary owns: a valid submission writes exactly one lead,
 * every bad input is a 400 that reaches the repository not at all, and there is no read path. The
 * repository is a spy so "no write on a rejected input" is a fact about the call, not a mock of one.
 */

function harness() {
  const insert = vi.fn(async () => ({ id: '0199aa00-0000-7000-8000-0000000000f0' }));
  const repository = { insert } as unknown as MarketingLeadsRepository;
  const controller = new ContactController(repository);
  const request = { headers: {} as Record<string, string | string[] | undefined> };
  ensureRequestState(request);
  return { controller, insert, request };
}

const VALID = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  message: 'We would like a demo for our studio of six.',
};

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
