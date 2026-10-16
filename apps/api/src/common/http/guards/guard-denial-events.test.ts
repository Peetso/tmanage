import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { SessionAuthGuard } from './session-auth.guard.js';
import { CsrfGuard } from './csrf.guard.js';
import { CSRF_HEADER, mintCsrfToken } from '../csrf.js';
import { requireRequestState } from '../request-state.js';
import { GUARD_REFUSAL_ACTIONS, GUARD_REFUSAL_REASONS } from '../authentication-event-recorder.js';
import type {
  AuthenticationEventRecorder,
  GuardRefusal,
} from '../authentication-event-recorder.js';
import { SessionNotAuthenticatedError } from '../../../modules/identity/session.service.js';
import type { SessionService } from '../../../modules/identity/session.service.js';
import type { ApiConfig } from '../api-config.js';

/**
 * Status defect 4 — the two HTTP-guard denials now write one `authentication_events` row through
 * the recorder seam, only on a refusal, and never let it change the 401/403. The row-write itself
 * is the already-DB-proven `recordAuthenticationEvent`; these cases prove the guard invokes the
 * recorder with the right fixed reason.
 */

const SECRET = 'a-csrf-secret-value-used-for-the-hmac';
const config = { cookieName: 'tm_session', csrfSecret: SECRET } as unknown as ApiConfig;

/** A minimal `ExecutionContext` over a request, with an empty reflector (no `@Public()`). */
function contextFor(request: object): ExecutionContext {
  const handler = (): void => {};
  const cls = class {};
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
}

class RecordingRecorder implements AuthenticationEventRecorder {
  readonly calls: GuardRefusal[] = [];
  constructor(private readonly boom = false) {}
  recordGuardRefusal(refusal: GuardRefusal): void {
    if (this.boom) throw new Error('recorder is broken');
    this.calls.push(refusal);
  }
}

describe('SessionAuthGuard records the missing-session refusal', () => {
  const guard = (recorder: AuthenticationEventRecorder, authenticate: () => Promise<unknown>) =>
    new SessionAuthGuard(
      new Reflector(),
      { authenticate } as unknown as SessionService,
      config,
      recorder,
      // The Bearer path is never reached here — these requests carry no Authorization header —
      // so a stub authenticator that is never called satisfies the constructor (0202).
      { authenticate: () => Promise.reject(new Error('unused')) } as never,
    );

  it('writes exactly one missing_session event and still refuses 401', async () => {
    const recorder = new RecordingRecorder();
    const g = guard(recorder, () => Promise.reject(new SessionNotAuthenticatedError('no_cookie')));
    const request = { headers: { 'user-agent': 'probe/1' }, ip: '203.0.113.7' };

    await expect(g.canActivate(contextFor(request))).rejects.toMatchObject({ status: 401 });
    expect(recorder.calls).toEqual([
      {
        action: GUARD_REFUSAL_ACTIONS.session,
        reason: GUARD_REFUSAL_REASONS.missingSession,
        ip: '203.0.113.7',
        userAgent: 'probe/1',
        correlationId: expect.any(String),
      },
    ]);
  });

  it('writes no event on the happy path', async () => {
    const recorder = new RecordingRecorder();
    const g = guard(recorder, () => Promise.resolve({ sessionId: 's1', userId: 'u1' }));

    await expect(g.canActivate(contextFor({ headers: {} }))).resolves.toBe(true);
    expect(recorder.calls).toHaveLength(0);
  });

  it('still returns the 401 when the recorder throws', async () => {
    const g = guard(new RecordingRecorder(true), () =>
      Promise.reject(new SessionNotAuthenticatedError('session_revoked')),
    );
    await expect(g.canActivate(contextFor({ headers: {} }))).rejects.toMatchObject({ status: 401 });
  });
});

describe('CsrfGuard records the bad-CSRF refusal', () => {
  const guard = (recorder: AuthenticationEventRecorder) =>
    new CsrfGuard(new Reflector(), config, recorder);
  const mutation = (headers: Record<string, string>) => {
    const request = { method: 'POST', headers, ip: '198.51.100.9' };
    requireRequestState(request).session = { sessionId: 's1', userId: 'u1' };
    return request;
  };

  it('writes exactly one csrf_failed event and still refuses 403', () => {
    const recorder = new RecordingRecorder();
    expect(() =>
      guard(recorder).canActivate(contextFor(mutation({ 'user-agent': 'probe/2' }))),
    ).toThrow(expect.objectContaining({ status: 403 }));
    expect(recorder.calls).toEqual([
      {
        action: GUARD_REFUSAL_ACTIONS.csrf,
        reason: GUARD_REFUSAL_REASONS.csrfFailed,
        ip: '198.51.100.9',
        userAgent: 'probe/2',
        correlationId: expect.any(String),
      },
    ]);
  });

  it('writes no event when the token matches (happy path)', () => {
    const recorder = new RecordingRecorder();
    const request = mutation({ [CSRF_HEADER]: mintCsrfToken('s1', SECRET) });
    expect(guard(recorder).canActivate(contextFor(request))).toBe(true);
    expect(recorder.calls).toHaveLength(0);
  });
});
