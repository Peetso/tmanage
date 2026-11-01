import { expect, it, vi } from 'vitest';
import { requireRequestState } from '../../common/http/request-state.js';
import { AuthenticationController } from './authentication.controller.js';

it('R12: a malformed client is ignored, the signal is stamped and the address recorded', async () => {
  const signInWithPassword = vi.fn(async (_: { context: unknown }) => ({
    status: 'mfa_required',
    expiresAt: new Date(),
  }));
  const record = vi.fn(async () => undefined);
  const ip = { classify: () => ({ ip: '198.51.100.1', networkKind: 'hosting' }), record };
  const auth = { signInWithPassword } as never;
  const ctrl = new AuthenticationController(auth, {} as never, undefined, undefined, ip as never);
  const request = { headers: { 'user-agent': 'python-requests/2.32' }, ip: '198.51.100.1' };
  requireRequestState(request);
  const body = { email: 'a@example.test', password: 'pw', client: { webdriver: 'y', formMs: 'x' } };
  await ctrl.signInWithPassword(body, request, { header: () => undefined });
  const reasons = ['ua_tool', 'hosting_ip', 'accept_language_missing'];
  const automation = { score: 65, reasons, clientHints: null };
  expect(signInWithPassword.mock.calls[0]?.[0].context).toMatchObject({ automation });
  expect(record).toHaveBeenCalledWith('198.51.100.1', expect.any(String));
});
