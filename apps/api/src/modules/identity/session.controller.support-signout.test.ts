import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireRequestState } from '../../common/http/request-state.js';
import { registerSupportSignOutListener } from '../platform-admin/support/support-session.service.js';
import { SessionController } from './session.controller.js';

/**
 * Platform admin v2 (verifier, SPEC §3.2): signing out of a browser session, or revoking one's own
 * session from the device list, ends any Support session bound to that browser session. The
 * support module registers the listener; the controller only has to call it.
 */

const USER = '0199aa00-0000-7000-8000-0000000000a1';

function harness(revokeOne = true) {
  const sessions = {
    revoke: vi.fn(async () => true),
    clearedCookies: vi.fn(() => ['a=; Max-Age=0']),
  };
  const authentication = { revokeSession: vi.fn(async () => revokeOne) };
  const controller = new SessionController(sessions as never, {} as never, authentication as never);
  const request = { headers: {} };
  requireRequestState(request).correlationId = 'corr-1';
  const reply = { header: vi.fn() };
  return { controller, request, reply };
}

afterEach(() => registerSupportSignOutListener(null));

describe('sign-out ends the bound Support session', () => {
  it('tells the support module on DELETE current', async () => {
    const ended = vi.fn(async () => undefined);
    registerSupportSignOutListener({ browserSessionEnded: ended });
    const { controller, request, reply } = harness();
    await controller.signOut(
      { sessionId: 's-1', userId: USER } as never,
      request as never,
      reply as never,
    );
    expect(ended).toHaveBeenCalledWith(USER, 's-1', 'corr-1');
  });

  it('tells it for a revoked session of one’s own, never for a refused one', async () => {
    const ended = vi.fn(async () => undefined);
    registerSupportSignOutListener({ browserSessionEnded: ended });
    const ok = harness(true);
    await ok.controller.revokeOne(
      { sessionId: 's-1', userId: USER } as never,
      's-2',
      ok.request as never,
      ok.reply as never,
    );
    expect(ended).toHaveBeenCalledWith(USER, 's-2', 'corr-1');
    ended.mockClear();
    const refused = harness(false);
    await expect(
      refused.controller.revokeOne(
        { sessionId: 's-1', userId: USER } as never,
        's-x',
        refused.request as never,
        refused.reply as never,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(ended).not.toHaveBeenCalled();
  });

  it('never fails the sign-out when the support cleanup throws', async () => {
    registerSupportSignOutListener({
      browserSessionEnded: async () => {
        throw new Error('db down');
      },
    });
    const { controller, request, reply } = harness();
    await expect(
      controller.signOut(
        { sessionId: 's-1', userId: USER } as never,
        request as never,
        reply as never,
      ),
    ).resolves.toBeUndefined();
  });
});
