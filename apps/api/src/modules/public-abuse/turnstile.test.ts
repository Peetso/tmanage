import { describe, expect, it } from 'vitest';
import { TURNSTILE_VERIFY_URL, verifyTurnstile } from './turnstile.js';
import type { FetchLike } from './turnstile.js';

/** UNIT-52-25 — Turnstile's three outcomes, with a mocked `fetch`. */

const answering =
  (success: boolean): FetchLike =>
  async () => ({ ok: true, json: async () => ({ success }) });

describe('verifyTurnstile', () => {
  it('passes and fails on Cloudflare’s answer, posting to siteverify', async () => {
    let called = '';
    const spy: FetchLike = async (url, init) => {
      called = `${url} ${init.body.get('secret')} ${init.body.get('response')}`;
      return { ok: true, json: async () => ({ success: true }) };
    };
    expect(await verifyTurnstile({ secret: 's', token: 't', fetchImpl: spy })).toBe('pass');
    expect(called).toBe(`${TURNSTILE_VERIFY_URL} s t`);
    expect(await verifyTurnstile({ secret: 's', token: 't', fetchImpl: answering(false) })).toBe(
      'fail',
    );
    expect(await verifyTurnstile({ secret: 's', token: '', fetchImpl: answering(true) })).toBe(
      'fail',
    );
  });

  it('is unavailable when unconfigured, erroring or silent past the timeout', async () => {
    expect(await verifyTurnstile({ secret: null, token: 't' })).toBe('unavailable');
    const broken: FetchLike = async () => {
      throw new Error('ECONNRESET');
    };
    expect(await verifyTurnstile({ secret: 's', token: 't', fetchImpl: broken })).toBe(
      'unavailable',
    );
    const silent: FetchLike = () => new Promise(() => undefined);
    const started = Date.now();
    expect(
      await verifyTurnstile({ secret: 's', token: 't', fetchImpl: silent, timeoutMs: 50 }),
    ).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
