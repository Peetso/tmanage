import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { SessionAuthGuard } from './session-auth.guard.js';
import { requireRequestState } from '../request-state.js';
import { INTERNAL_GRANT_HEADER, InternalGrantStore } from '../../../modules/mcp/internal-grant.js';
import type { InternalGrantPayload } from '../../../modules/mcp/internal-grant.js';

/**
 * The MCP connector's one-time internal grant, at the guard (MCP connector S6, architecture B3).
 *
 * `SessionAuthGuard` turns the `x-tmanage-internal-grant` nonce into the principal the outer MCP
 * request already proved — but only on an in-process inject, and only while the nonce is live and
 * unused. These are the `T-B3-*` controls at their enforcement point.
 */

const PAYLOAD: InternalGrantPayload = {
  grantId: 'pat:t1',
  userId: '0198f4a2-1c00-7000-8000-00000000000c',
  membershipId: '0198f4a2-1c00-7000-8000-00000000000d',
  organizationId: '0198f4a2-1c00-7000-8000-00000000000e',
  clientId: 'pat:t1',
  clientName: 'AI assistant',
  opId: 'GET /v1/organizations',
};

class MockSocket {} // what fastify.inject (light-my-request) presents
class Socket {} // what a real TCP connection presents

function guardWith(store: InternalGrantStore): SessionAuthGuard {
  const guard = new SessionAuthGuard(
    { getAllAndOverride: () => false } as never,
    { authenticate: vi.fn() } as never,
    { cookieName: 'tm' } as never,
    { recordGuardRefusal: vi.fn() } as never,
    { authenticate: vi.fn() } as never,
  );
  (guard as unknown as { internalGrants: InternalGrantStore }).internalGrants = store;
  return guard;
}

function contextFor(request: unknown): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function requestWith(
  nonce: string,
  socket: object,
): { headers: Record<string, string>; raw: unknown } {
  return { headers: { [INTERNAL_GRANT_HEADER]: nonce }, raw: { socket } };
}

describe('SessionAuthGuard — internal grant branch', () => {
  it('redeems a live nonce on an inject and becomes the bound-token principal', async () => {
    const store = new InternalGrantStore();
    const nonce = store.mint(PAYLOAD);
    const request = requestWith(nonce, new MockSocket());

    await expect(guardWith(store).canActivate(contextFor(request))).resolves.toBe(true);

    const state = requireRequestState(request);
    expect(state.authScheme).toBe('ai_grant');
    expect(state.session).toEqual({ sessionId: 'ai:pat:t1', userId: PAYLOAD.userId });
    expect(state.personalAccessToken).toEqual({
      organizationId: PAYLOAD.organizationId,
      membershipId: PAYLOAD.membershipId,
    });
    expect(state.aiGrant).toEqual({
      grantId: PAYLOAD.grantId,
      clientId: PAYLOAD.clientId,
      clientName: PAYLOAD.clientName,
      opId: PAYLOAD.opId,
    });
  });

  it('refuses the header on a real network request even with a live nonce (T-B3-01)', async () => {
    const store = new InternalGrantStore();
    const nonce = store.mint(PAYLOAD);
    const request = requestWith(nonce, new Socket());

    await expect(guardWith(store).canActivate(contextFor(request))).rejects.toMatchObject({
      status: 401,
      auditCode: 'internal_grant_from_network',
    });
    // The nonce was not even looked at, let alone consumed, from the network.
    expect(store.consume(nonce)).toEqual(PAYLOAD);
  });

  it('refuses an unknown or already-used nonce on an inject (T-B3-02)', async () => {
    const store = new InternalGrantStore();
    const used = store.mint(PAYLOAD);
    store.consume(used); // spend it
    const request = requestWith(used, new MockSocket());

    await expect(guardWith(store).canActivate(contextFor(request))).rejects.toMatchObject({
      status: 401,
      auditCode: 'internal_grant_invalid',
    });
  });
});
