import { describe, expect, it, vi } from 'vitest';
import { SessionController } from './session.controller.js';
import { ReauthenticationRequiredError } from './authentication.service.js';
import type { AuthenticationService } from './authentication.service.js';
import type { SessionService, AuthenticatedSession } from './session.service.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import { ApiError } from '../../common/http/errors.js';

/**
 * `I-1`. The controller half of the session-revoke routes: what the HTTP surface does with the
 * service's answer.
 *
 * Three things are the controller's own responsibility and nothing else's, so they are proved
 * here rather than in the database suite: it forwards the `x-reauth-token` header and the
 * request's source address to the service; it turns "not this person's session" (a `false`
 * from the service) into a **404** that reveals nothing; and it turns the re-auth refusal into
 * a **403 `reauthentication_required`**, never a 401 or the generic `forbidden`.
 */

const SESSION: AuthenticatedSession = {
  userId: '0198f0aa-0000-7000-8000-000000000001',
  sessionId: '0198f0aa-0000-7000-8000-0000000000a1',
};
const TARGET = '0198f0aa-0000-7000-8000-0000000000b1';

interface Fakes {
  controller: SessionController;
  revokeSession: ReturnType<typeof vi.fn>;
  revokeOtherSessions: ReturnType<typeof vi.fn>;
}

function build(): Fakes {
  const revokeSession = vi.fn();
  const revokeOtherSessions = vi.fn();
  const authentication = { revokeSession, revokeOtherSessions } as unknown as AuthenticationService;
  const sessions = {} as unknown as SessionService;
  const config = {} as unknown as ApiConfig;
  const controller = new SessionController(sessions, config, authentication);
  return { controller, revokeSession, revokeOtherSessions };
}

const request = (headers: Record<string, string> = {}, ip?: string) => ({
  headers,
  ...(ip === undefined ? {} : { ip }),
});

describe('DELETE /v1/sessions/:sessionId', () => {
  it('forwards the reauth header and source address, and resolves on a real revoke', async () => {
    const { controller, revokeSession } = build();
    revokeSession.mockResolvedValue(true);

    await expect(
      controller.revokeOne(SESSION, TARGET, request({ 'x-reauth-token': 'proof' }, '203.0.113.9')),
    ).resolves.toBeUndefined();

    expect(revokeSession).toHaveBeenCalledTimes(1);
    const arg = revokeSession.mock.calls[0]![0] as {
      userId: string;
      sessionId: string;
      targetSessionId: string;
      reauthToken?: string;
      context: { ip: string | null; userAgent: string | null };
    };
    expect(arg.userId).toBe(SESSION.userId);
    expect(arg.sessionId).toBe(SESSION.sessionId);
    expect(arg.targetSessionId).toBe(TARGET);
    expect(arg.reauthToken).toBe('proof');
    expect(arg.context.ip).toBe('203.0.113.9');
  });

  it('passes undefined when the reauth header is absent', async () => {
    const { controller, revokeSession } = build();
    revokeSession.mockResolvedValue(true);

    await controller.revokeOne(SESSION, TARGET, request());

    const arg = revokeSession.mock.calls[0]![0] as { reauthToken?: string };
    expect(arg.reauthToken).toBeUndefined();
  });

  it('answers 404 when the session is not this person’s', async () => {
    const { controller, revokeSession } = build();
    revokeSession.mockResolvedValue(false);

    await expect(
      controller.revokeOne(SESSION, TARGET, request({ 'x-reauth-token': 'proof' })),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('turns a re-auth refusal into 403 reauthentication_required, carrying the reason to the log', async () => {
    const { controller, revokeSession } = build();
    revokeSession.mockRejectedValue(new ReauthenticationRequiredError('reauth_wrong_session'));

    const error = await controller
      .revokeOne(SESSION, TARGET, request({ 'x-reauth-token': 'proof' }))
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 403,
      code: 'reauthentication_required',
      auditCode: 'reauth_wrong_session',
    });
  });
});

describe('DELETE /v1/sessions', () => {
  it('forwards the reauth header and resolves', async () => {
    const { controller, revokeOtherSessions } = build();
    revokeOtherSessions.mockResolvedValue(2);

    await expect(
      controller.revokeOthers(SESSION, request({ 'x-reauth-token': 'proof' }, '203.0.113.9')),
    ).resolves.toBeUndefined();

    const arg = revokeOtherSessions.mock.calls[0]![0] as {
      userId: string;
      sessionId: string;
      reauthToken?: string;
      context: { ip: string | null };
    };
    expect(arg.userId).toBe(SESSION.userId);
    expect(arg.sessionId).toBe(SESSION.sessionId);
    expect(arg.reauthToken).toBe('proof');
    expect(arg.context.ip).toBe('203.0.113.9');
  });

  it('turns a re-auth refusal into 403 reauthentication_required', async () => {
    const { controller, revokeOtherSessions } = build();
    revokeOtherSessions.mockRejectedValue(new ReauthenticationRequiredError('reauth_required'));

    const error = await controller.revokeOthers(SESSION, request()).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: 'reauthentication_required' });
  });
});
