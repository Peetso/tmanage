import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import {
  GuardRefusalSampler,
  REFUSAL_ROWS_PER_WINDOW,
  REFUSAL_WINDOW_MS,
  SessionAuthGuard,
} from './session-auth.guard.js';
import type {
  AuthenticationEventRecorder,
  GuardRefusal,
} from '../authentication-event-recorder.js';
import { SessionNotAuthenticatedError } from '../../../modules/identity/session.service.js';
import type { SessionService } from '../../../modules/identity/session.service.js';
import type { ApiConfig } from '../api-config.js';

/**
 * NV02 — anonymous refusals no longer launch one unbounded, detached `authentication_events`
 * insert each. 2000 refused requests produce at most the per-window cap of insert calls, and
 * every one of them is still a 401.
 */

const config = { cookieName: 'tm_session' } as unknown as ApiConfig;

function contextFor(request: object): ExecutionContext {
  const handler = (): void => {};
  const cls = class {};
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
}

class CountingRecorder implements AuthenticationEventRecorder {
  readonly calls: GuardRefusal[] = [];
  recordGuardRefusal(refusal: GuardRefusal): void {
    this.calls.push(refusal);
  }
}

function guardWith(recorder: AuthenticationEventRecorder): SessionAuthGuard {
  return new SessionAuthGuard(
    new Reflector(),
    {
      authenticate: () => Promise.reject(new SessionNotAuthenticatedError('no_cookie')),
    } as unknown as SessionService,
    config,
    recorder,
    { authenticate: () => Promise.reject(new Error('unused')) } as never,
  );
}

describe('NV02 — SessionAuthGuard coalesces anonymous refusal rows', () => {
  it('2000 refusals from one address write one row, and all are 401', async () => {
    const recorder = new CountingRecorder();
    const guard = guardWith(recorder);
    for (let i = 0; i < 2000; i += 1) {
      await expect(
        guard.canActivate(contextFor({ headers: {}, ip: '203.0.113.7' })),
      ).rejects.toMatchObject({ status: 401 });
    }
    expect(recorder.calls).toHaveLength(1);
  });

  it('2000 refusals from 2000 addresses write at most the global cap', async () => {
    const recorder = new CountingRecorder();
    const guard = guardWith(recorder);
    for (let i = 0; i < 2000; i += 1) {
      await expect(
        guard.canActivate(contextFor({ headers: {}, ip: `10.0.${i >> 8}.${i & 255}` })),
      ).rejects.toMatchObject({ status: 401 });
    }
    expect(recorder.calls.length).toBeLessThanOrEqual(REFUSAL_ROWS_PER_WINDOW);
    expect(recorder.calls.length).toBeGreaterThan(0);
  });

  it('admits the address again in the next window', () => {
    let now = 0;
    const sampler = new GuardRefusalSampler(() => now);
    expect(sampler.admit('198.51.100.1')).toBe(true);
    expect(sampler.admit('198.51.100.1')).toBe(false);
    now += REFUSAL_WINDOW_MS;
    expect(sampler.admit('198.51.100.1')).toBe(true);
    expect(sampler.suppressed).toBe(1);
  });
});
