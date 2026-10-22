import { describe, expect, it } from 'vitest';
import {
  argsSha256,
  canonicalizeArgs,
  InternalGrantStore,
  INTERNAL_GRANT_TTL_MS,
  isInProcessRequest,
} from './internal-grant.js';
import type { InternalGrantPayload } from './internal-grant.js';

/**
 * The one-time internal grant — MCP connector S6, architecture B3 (`T-B3-*`). The store is the
 * single security primitive that lets the MCP endpoint execute a tool call without forwarding the
 * AI client's own token: it hands out a nonce that redeems at most once, within 30 seconds, for
 * the principal the outer request already proved.
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

describe('InternalGrantStore', () => {
  it('redeems a freshly minted nonce for its payload', () => {
    const store = new InternalGrantStore();
    const nonce = store.mint(PAYLOAD);
    expect(nonce).toMatch(/^[0-9a-f]{64}$/); // 256 bits, hex
    expect(store.consume(nonce)).toEqual(PAYLOAD);
  });

  it('refuses a second use of the same nonce — single use (T-B3-02)', () => {
    const store = new InternalGrantStore();
    const nonce = store.mint(PAYLOAD);
    expect(store.consume(nonce)).toEqual(PAYLOAD);
    expect(store.consume(nonce)).toBeUndefined();
  });

  it('refuses an expired nonce and does not leave it redeemable (T-B3-02)', () => {
    let now = 1_000;
    const store = new InternalGrantStore(() => now);
    const nonce = store.mint(PAYLOAD);
    now += INTERNAL_GRANT_TTL_MS + 1;
    expect(store.consume(nonce)).toBeUndefined();
    // And it was dropped, not merely refused once.
    now = 1_000;
    expect(store.consume(nonce)).toBeUndefined();
  });

  it('refuses an unknown nonce', () => {
    const store = new InternalGrantStore();
    expect(store.consume('deadbeef')).toBeUndefined();
  });

  it('prunes expired grants on the next mint so an idle process does not accumulate them', () => {
    let now = 0;
    const store = new InternalGrantStore(() => now);
    store.mint(PAYLOAD);
    expect(store.size).toBe(1);
    now += INTERNAL_GRANT_TTL_MS + 1;
    store.mint(PAYLOAD);
    expect(store.size).toBe(1);
  });
});

describe('isInProcessRequest', () => {
  class MockSocket {}
  class Socket {}

  it('accepts a Fastify inject (MockSocket)', () => {
    expect(isInProcessRequest({ socket: new MockSocket() })).toBe(true);
  });

  it('refuses a real network socket (T-B3-01)', () => {
    expect(isInProcessRequest({ socket: new Socket() })).toBe(false);
  });

  it('fails closed on an absent or unrecognised socket', () => {
    expect(isInProcessRequest({})).toBe(false);
    expect(isInProcessRequest(null)).toBe(false);
    expect(isInProcessRequest(undefined)).toBe(false);
  });
});

describe('args hashing (architecture B6 — a hash is recorded, never the arguments)', () => {
  it('is independent of key order', () => {
    expect(canonicalizeArgs({ a: 1, b: 2 })).toBe(canonicalizeArgs({ b: 2, a: 1 }));
    expect(argsSha256({ a: 1, b: { c: 3, d: 4 } })).toBe(argsSha256({ b: { d: 4, c: 3 }, a: 1 }));
  });

  it('changes when a value changes, and is a 64-char hex digest', () => {
    expect(argsSha256({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(argsSha256({ a: 1 })).not.toBe(argsSha256({ a: 2 }));
  });
});
