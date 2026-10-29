import { describe, expect, it } from 'vitest';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { PLATFORM_AUDIT_INSERT_SQL, PlatformAuditService } from './platform-audit.service.js';

/** The platform audit row carries who, what, where, what changed (redacted), from where and why. */

const ORG = '0199aa00-0000-7000-8000-0000000000c1';
const actor = {
  account: {
    userId: 'admin-1',
    email: 'peter@example.com',
    displayName: 'Peter',
    emailVerified: true,
    mfaEnabled: true,
  },
};

type Query = (sql: string, params: readonly unknown[]) => Promise<unknown>;

function harness() {
  const sent: { sql: string; params: readonly unknown[] }[] = [];
  const database = {
    identityTransaction: async <T>(_o: unknown, work: (tx: { query: Query }) => Promise<T>) =>
      work({
        query: async (sql, params) => {
          sent.push({ sql, params });
          return {};
        },
      }),
  } as unknown as TenantDatabase;
  return { service: new PlatformAuditService(database), sent };
}

const request = { ip: '198.51.100.7', headers: { 'user-agent': 'Safari' } };

describe('PlatformAuditService', () => {
  it('writes org, support session, redacted before/after, IP and device on the row', async () => {
    const { service, sent } = harness();
    await service.record({
      actor,
      action: 'platform.team_admin_updated',
      targetType: 'platform_admin',
      targetId: 'a1',
      targetLabel: 'sara@x.test',
      organizationId: ORG,
      supportSessionId: 'ss-1',
      before: { preset: 'support', refresh_token: 'r1' },
      after: { preset: 'auditor', api_secret: 's1' },
      reason: '  Moved to read-only  ',
      reasonRequired: true,
      request,
      correlationId: 'corr',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.sql).toBe(PLATFORM_AUDIT_INSERT_SQL);
    const params = sent[0]?.params ?? [];
    expect(params.slice(1)).toEqual([
      'admin-1',
      'peter@example.com',
      'platform.team_admin_updated',
      'platform_admin',
      'a1',
      'sara@x.test',
      ORG,
      'Moved to read-only',
      'corr',
      'ss-1',
      JSON.stringify({ preset: 'support', refresh_token: '[redacted]' }),
      JSON.stringify({ preset: 'auditor', api_secret: '[redacted]' }),
      '198.51.100.7',
      'Safari',
    ]);
  });

  it('makes the reason optional off the destructive list and required on it', async () => {
    const { service, sent } = harness();
    const base = {
      actor,
      action: 'platform.step_up',
      targetType: 'platform' as const,
      targetId: null,
      targetLabel: null,
      correlationId: 'c',
    };
    const written = await service.record({ ...base, reason: '   ', reasonRequired: false });
    expect(written.reason).toBeNull();
    await expect(
      service.record({ ...base, reason: '', reasonRequired: true }),
    ).rejects.toMatchObject({ status: 400 });
    // The refusal came before anything was written.
    expect(sent).toHaveLength(1);
  });
});
