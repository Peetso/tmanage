import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../common/http/errors.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import type { SessionService } from '../identity/session.service.js';
import { FirstOwnerController } from './first-owner.controller.js';
import { FirstOwnerSetupUnavailableError, type FirstOwnerService } from './first-owner.service.js';

/** First-owner setup's HTTP layer, proved without a database: the service and sessions are spies. */

const RESULT = {
  userId: '0199aa00-0000-7000-8000-0000000000a1',
  organizationId: '0199aa00-0000-7000-8000-0000000000a2',
  slug: 'acme',
  workspaceId: '0199aa00-0000-7000-8000-0000000000a3',
};

function harness(options: { admit?: boolean; available?: boolean; setupError?: Error } = {}) {
  const isAvailable = vi.fn(async () => options.available ?? true);
  const setup = vi.fn(async () => {
    if (options.setupError) throw options.setupError;
    return RESULT;
  });
  const start = vi.fn(async () => ({
    cookies: ['tm_access=a; HttpOnly', 'tm_refresh=r; HttpOnly'],
    csrfToken: 'csrf-1',
    expiresAt: new Date('2026-10-18T00:00:00.000Z'),
  }));
  const controller = new FirstOwnerController(
    { isAvailable, setup } as unknown as FirstOwnerService,
    { start } as unknown as SessionService,
    () => options.admit ?? true,
  );
  const request = {
    headers: { 'user-agent': 'vitest' } as Record<string, string | string[] | undefined>,
    ip: '203.0.113.7',
  };
  ensureRequestState(request);
  const header = vi.fn();
  return { controller, isAvailable, setup, start, request, reply: { header } };
}

const BODY = { token: 'not-logged', email: 'owner@example.com' } as never;

describe('FirstOwnerController', () => {
  it('refuses with 429 before the service when admission is refused', async () => {
    const { controller, setup, request, reply } = harness({ admit: false });
    const error = await controller.setup(BODY, request, reply).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(429);
    expect((error as ApiError).code).toBe('rate_limited');
    expect(setup).not.toHaveBeenCalled();
  });

  it('answers 404 not_found once setup is unavailable', async () => {
    const { controller, start, request, reply } = harness({
      setupError: new FirstOwnerSetupUnavailableError(),
    });
    await expect(controller.setup(BODY, request, reply)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('starts a session, sets its cookies and returns the organization slug', async () => {
    const { controller, start, request, reply } = harness();
    const view = await controller.setup(BODY, request, reply);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ userId: RESULT.userId, userAgent: 'vitest' }),
    );
    expect(reply.header).toHaveBeenCalledWith('set-cookie', [
      'tm_access=a; HttpOnly',
      'tm_refresh=r; HttpOnly',
    ]);
    expect(view).toEqual({
      status: 'authenticated',
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-18T00:00:00.000Z',
      organizationSlug: 'acme',
    });
  });

  it('GET answers 404 when setup is not available', async () => {
    const { controller, request } = harness({ available: false });
    await expect(controller.availability(request)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });
});
