import { describe, expect, it } from 'vitest';
import { lastValueFrom, of, throwError } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { ApiError } from './errors.js';
import {
  IdempotencyReplayInterceptor,
  IdempotencyStore,
} from './idempotency-replay.interceptor.js';
import { ensureRequestState } from './request-state.js';
import type { TenantContext } from '../database/tenant-context.js';

/** 53-16: an offline replay of a comment or time entry must never write twice. */

const KEY = 'offline-0123456789abcdef';

function contextFor(
  tenant: { organizationId: string; membershipId: string },
  headers: Record<string, string>,
  body: unknown,
): ExecutionContext {
  const request = {
    headers,
    method: 'POST',
    url: '/v1/organizations/acme/work-items/w1/comments',
    body,
  };
  // What `TenantContextGuard` leaves on a guarded request: only the scope fields are read here.
  (ensureRequestState(request) as { tenant?: TenantContext }).tenant =
    tenant as unknown as TenantContext;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function counting(): { handler: CallHandler; calls: () => number } {
  let calls = 0;
  return {
    handler: {
      handle: () => {
        calls += 1;
        return of({ id: `c${calls}` });
      },
    },
    calls: () => calls,
  };
}

describe('IdempotencyStore', () => {
  it('runs the write once and answers a repeat with the first result', async () => {
    const store = new IdempotencyStore();
    let runs = 0;
    const perform = async () => ({ id: `c${++runs}` });
    const first = await store.run('scope', '{"body":"hi"}', perform);
    const second = await store.run('scope', '{"body":"hi"}', perform);
    expect(first).toEqual({ id: 'c1' });
    expect(second).toEqual({ id: 'c1' });
    expect(runs).toBe(1);
  });

  it('refuses the same key with a different body (422)', async () => {
    const store = new IdempotencyStore();
    await store.run('scope', 'a', async () => 1);
    await expect(store.run('scope', 'b', async () => 2)).rejects.toMatchObject({ status: 422 });
  });

  it('forgets a failed attempt so the retry runs', async () => {
    const store = new IdempotencyStore();
    await expect(
      store.run('scope', 'a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.run('scope', 'a', async () => 'ok')).toBe('ok');
  });

  it('keeps scopes apart, so another member never receives a stored answer', async () => {
    const store = new IdempotencyStore();
    expect(await store.run('org:m1:key', 'a', async () => 'mine')).toBe('mine');
    expect(await store.run('org:m2:key', 'a', async () => 'theirs')).toBe('theirs');
  });

  it('expires entries after a day', async () => {
    let now = 0;
    const store = new IdempotencyStore(() => now);
    await store.run('s1', 'a', async () => 1);
    now = 25 * 60 * 60 * 1000;
    expect(await store.run('s1', 'a', async () => 2)).toBe(2);
  });
});

describe('IdempotencyReplayInterceptor', () => {
  it('passes a request without the header straight through', async () => {
    const interceptor = new IdempotencyReplayInterceptor(new IdempotencyStore());
    const { handler, calls } = counting();
    const context = contextFor({ organizationId: 'o', membershipId: 'm' }, {}, { body: 'x' });
    await lastValueFrom(interceptor.intercept(context, handler));
    await lastValueFrom(interceptor.intercept(context, handler));
    expect(calls()).toBe(2);
  });

  it('answers a replay under the same key without running the write again', async () => {
    const interceptor = new IdempotencyReplayInterceptor(new IdempotencyStore());
    const { handler, calls } = counting();
    const scope = { organizationId: 'o', membershipId: 'm' };
    const headers = { 'idempotency-key': KEY };
    const first = await lastValueFrom(
      interceptor.intercept(contextFor(scope, headers, { body: 'x' }), handler),
    );
    const replay = await lastValueFrom(
      interceptor.intercept(contextFor(scope, headers, { body: 'x' }), handler),
    );
    expect(replay).toEqual(first);
    expect(calls()).toBe(1);
    // The same key from another member of the workspace is a different request.
    await lastValueFrom(
      interceptor.intercept(
        contextFor({ organizationId: 'o', membershipId: 'other' }, headers, { body: 'x' }),
        handler,
      ),
    );
    expect(calls()).toBe(2);
  });

  it('refuses a malformed key with 400', () => {
    const interceptor = new IdempotencyReplayInterceptor(new IdempotencyStore());
    const context = contextFor(
      { organizationId: 'o', membershipId: 'm' },
      { 'idempotency-key': 'short' },
      {},
    );
    expect(() => interceptor.intercept(context, { handle: () => throwError(() => 0) })).toThrow(
      ApiError,
    );
  });
});
