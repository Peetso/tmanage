import { describe, expect, it } from 'vitest';
import type { CredentialsRepository } from '../../modules/identity/credentials.repository.js';
import { DatabaseMcpCallAuditor } from '../../modules/mcp/mcp-call-audit.js';
import type { MembershipResolver } from '../../modules/tenancy/membership-resolver.repository.js';
import type { TenantDatabase } from '../database/tenant-context.js';
import { DatabaseAuthenticationEventRecorder } from '../http/authentication-event-recorder.js';
import { AuditLossCounter } from './audit-loss.js';

/**
 * OWASP ASVS 5.0 V16 — the fail-open audit writers never lose a row silently: each loss is
 * counted per source for `/healthz/deep` (`audit_log`), which shows states only.
 */

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('lost audit rows (ASVS 5.0 V16)', () => {
  it('counts per source and reports states, ok until a row is lost', () => {
    const loss = new AuditLossCounter();
    expect(loss.check()).toEqual({
      state: 'ok',
      sources: { ai_turn: 'ok', mcp_tool_call: 'ok', auth_guard_refusal: 'ok' },
    });
    expect(loss.record('ai_turn', 3)).toBe(3);
    expect(loss.record('ai_turn')).toBe(4);
    expect(loss.record('ai_turn', -2)).toBe(4);
    expect(loss.check()).toEqual({
      state: 'rows_lost',
      sources: { ai_turn: 'rows_lost', mcp_tool_call: 'ok', auth_guard_refusal: 'ok' },
    });
  });

  it('a lost /mcp tool-call row is counted', async () => {
    const loss = new AuditLossCounter();
    const memberships = {
      resolve: () => Promise.reject(new Error('db down')),
    } as unknown as MembershipResolver;
    const live = new DatabaseMcpCallAuditor(
      {} as TenantDatabase,
      undefined,
      memberships,
      'mcp.tool_called' as never,
      loss,
    );
    live.record(
      {
        userId: 'u',
        organizationId: 'o',
        membershipId: 'm',
        clientId: 'pat:1',
        correlationId: 'c',
      },
      { tool: 't', opId: null, argsSha256: 'x', outcome: 'ok', latencyMs: 1 },
    );
    await settle();
    expect(loss.count('mcp_tool_call')).toBe(1);
  });

  it('a lost guard-refusal row is counted', async () => {
    const loss = new AuditLossCounter();
    const recorder = new DatabaseAuthenticationEventRecorder(
      {
        identityTransaction: () => Promise.reject(new Error('db down')),
      } as unknown as TenantDatabase,
      {} as CredentialsRepository,
      loss,
    );
    recorder.recordGuardRefusal({
      action: 'session.refused',
      reason: 'expired',
      correlationId: 'c',
    } as never);
    await settle();
    expect(loss.count('auth_guard_refusal')).toBe(1);
  });
});
