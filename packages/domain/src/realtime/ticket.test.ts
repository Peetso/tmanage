import { describe, expect, it } from 'vitest';
import { signRealtimeTicket, verifyRealtimeTicket } from './ticket.js';

const SECRET = 'a-session-secret-of-sufficient-length-for-the-test';
const NOW = new Date('2026-08-30T12:00:00.000Z');

const CLAIMS = {
  organizationId: '01920000-0000-7000-8000-00000000000a',
  userId: '01920000-0000-7000-8000-00000000000b',
  expiresAt: NOW.getTime() + 60_000,
};

describe('the realtime ticket', () => {
  it('round-trips its claims', () => {
    const token = signRealtimeTicket(CLAIMS, SECRET);
    expect(verifyRealtimeTicket(token, SECRET, NOW)).toEqual(CLAIMS);
  });

  it('answers null for expiry, tampering, a wrong secret, and garbage — indistinguishably', () => {
    const token = signRealtimeTicket(CLAIMS, SECRET);

    expect(verifyRealtimeTicket(token, SECRET, new Date(CLAIMS.expiresAt))).toBeNull();
    expect(verifyRealtimeTicket(token, 'another-secret-of-sufficient-length-here', NOW)).toBeNull();

    const [payload, signature] = token.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ o: CLAIMS.organizationId, u: CLAIMS.userId, e: CLAIMS.expiresAt + 1e7 }),
      'utf8',
    ).toString('base64url');
    expect(verifyRealtimeTicket(`${forged}.${signature}`, SECRET, NOW)).toBeNull();
    expect(verifyRealtimeTicket(`${payload}.`, SECRET, NOW)).toBeNull();
    expect(verifyRealtimeTicket('not-a-ticket', SECRET, NOW)).toBeNull();
    expect(verifyRealtimeTicket('', SECRET, NOW)).toBeNull();
  });

  it('binds the signature to the claims, not just to the shape', () => {
    const other = signRealtimeTicket({ ...CLAIMS, userId: CLAIMS.organizationId }, SECRET);
    const token = signRealtimeTicket(CLAIMS, SECRET);
    const [, otherSignature] = other.split('.') as [string, string];
    const [payload] = token.split('.') as [string, string];
    expect(verifyRealtimeTicket(`${payload}.${otherSignature}`, SECRET, NOW)).toBeNull();
  });
});
