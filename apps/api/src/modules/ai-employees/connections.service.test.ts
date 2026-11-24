import type { Principal } from '@tmanage/domain';
import { assertSafeAuditMetadata } from '@tmanage/domain';
import { describe, expect, it } from 'vitest';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { ApiError } from '../../common/http/errors.js';
import type { AiConnectorRecord } from '../oauth/ai-connectors.js';
import type { AgentKeyView } from '../personal-access-tokens/agent-keys.js';
import type { AiEmployeeRecord } from './ai-employees.repository.js';
import { AiEmployeeConnectionsService } from './connections.service.js';
import { AI_CONNECTOR_AUDIT } from './works-as.js';

/**
 * 60-07 (plan 60 v2 §4.5; S6b) — an AI employee's connections, with fakes (IP-14): the exact
 * answer the profile's Connections tab reads (keys and connectors in one list, the cap counted
 * over both), stopping a connector in every status, and the door (server switch off = 404 for
 * both routes; a token, the AI employee itself, or someone who is neither sponsor nor manager is
 * refused).
 */

const ORG = '00000000-0000-4000-8000-000000000001';
const SPONSOR_M = '0190a000-0000-7000-8000-0000000000a1';
const STRANGER_M = '0190a000-0000-7000-8000-0000000000a9';
const MAT = '0190a000-0000-7000-8000-0000000000e1';
const MAT_M = '0190a000-0000-7000-8000-0000000000e2';
const GRANT = '0190a000-0000-7000-8000-0000000000c1';
const T0 = new Date('2026-11-24T10:00:00.000Z');

const PERSON: Principal = { kind: 'internal' } as Principal;

function contextOf(membershipId: string, over: Record<string, unknown> = {}): TenantContext {
  return {
    organizationId: ORG,
    userId: 'user-x',
    membershipId,
    principalKind: 'internal',
    capabilities: ['people.view'],
    ...over,
  } as unknown as TenantContext;
}

function mat(status: AiEmployeeRecord['status'] = 'active'): AiEmployeeRecord {
  return {
    id: MAT,
    membershipId: MAT_M,
    userId: 'mat-user',
    sponsorMembershipId: SPONSOR_M,
    status,
  } as unknown as AiEmployeeRecord;
}

const KEY: AgentKeyView = {
  id: 'key-1',
  name: 'Agent key',
  tokenPrefix: 'tmanage_pat_k9Xw',
  createdAt: '2026-11-20T09:00:00.000Z',
  expiresAt: '2027-01-20T09:00:00.000Z',
  lastUsedAt: '2026-11-24T08:00:00.000Z',
  revokedAt: null,
  createdByMembershipId: SPONSOR_M,
  ipAllowlist: [],
  live: true,
};

const CONNECTOR: AiConnectorRecord = {
  grantId: GRANT,
  clientName: 'Claude',
  createdAt: new Date('2026-11-22T12:00:00.000Z'),
  authorizedByMembershipId: SPONSOR_M,
  authorizedByName: 'Peter Kamal',
  lastUsedAt: new Date('2026-11-24T09:56:00.000Z'),
};

function harness(input: { enabled?: boolean; row?: AiEmployeeRecord | null } = {}) {
  const audits: { action: string; objectId?: string; metadata?: unknown }[] = [];
  const revoked: string[] = [];
  const runner = {} as TenantQueryRunner;
  const service = new AiEmployeeConnectionsService({
    database: {
      read: (async (_c: unknown, work: (r: TenantQueryRunner) => Promise<unknown>) =>
        work(runner)) as never,
      transaction: (async (_c: unknown, work: (r: TenantQueryRunner) => Promise<unknown>) =>
        work(runner)) as never,
    },
    audit: {
      record: (async (_r: unknown, _c: unknown, event: (typeof audits)[number]) => {
        // The real write boundary refuses unsafe metadata; so does this fake.
        const { metadata } = event as { metadata?: unknown };
        if (metadata !== undefined) assertSafeAuditMetadata(metadata);
        audits.push(event);
        return {};
      }) as never,
    },
    repository: {
      findById: async (_r, _c, id) =>
        id === MAT ? (input.row === undefined ? mat() : input.row) : null,
    },
    agentKeys: {
      list: async () => [KEY, { ...KEY, id: 'key-old', live: false, revokedAt: KEY.createdAt }],
    },
    aiConnectors: {
      list: async () => [CONNECTOR],
      revoke: async (_r, _c, membershipId, grantId) => {
        if (membershipId !== MAT_M || grantId !== GRANT || revoked.includes(grantId)) return false;
        revoked.push(grantId);
        return true;
      },
    },
    names: async () => new Map([[SPONSOR_M, 'Peter Kamal']]),
    enabled: input.enabled ?? true,
    now: () => T0,
  });
  return { service, audits, revoked };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('expected a refusal');
}

describe('GET …/ai-employees/:id/connections', () => {
  it('answers live keys and connectors in one list, newest first, the cap over both', async () => {
    const view = await harness().service.list(contextOf(SPONSOR_M), PERSON, MAT);
    // The exact JSON the profile's Connections tab (S6b) reads.
    expect(JSON.parse(JSON.stringify(view))).toEqual({
      connections: [
        {
          id: GRANT,
          kind: 'connector',
          name: 'Claude',
          tokenPrefix: null,
          addedBy: { membershipId: SPONSOR_M, displayName: 'Peter Kamal' },
          createdAt: '2026-11-22T12:00:00.000Z',
          lastUsedAt: '2026-11-24T09:56:00.000Z',
          expiresAt: null,
          live: true,
        },
        {
          id: 'key-1',
          kind: 'key',
          name: 'Agent key',
          tokenPrefix: 'tmanage_pat_k9Xw',
          addedBy: { membershipId: SPONSOR_M, displayName: 'Peter Kamal' },
          createdAt: '2026-11-20T09:00:00.000Z',
          lastUsedAt: '2026-11-24T08:00:00.000Z',
          expiresAt: '2027-01-20T09:00:00.000Z',
          live: true,
        },
      ],
      limit: 3,
      live: 2,
      canCreate: true,
    });
  });

  it('a retired AI employee lists its connections but cannot get a new one', async () => {
    const view = await harness({ row: mat('retired') }).service.list(
      contextOf(SPONSOR_M),
      PERSON,
      MAT,
    );
    expect(view).toMatchObject({ live: 2, canCreate: false });
  });
});

describe('DELETE …/ai-employees/:id/connections/connectors/:grantId', () => {
  it('stops the connector now, audited; a second time or another grant is 404', async () => {
    const { service, audits, revoked } = harness();
    await service.revokeConnector(contextOf(SPONSOR_M), PERSON, MAT, GRANT);
    expect(revoked).toEqual([GRANT]);
    expect(audits).toEqual([
      expect.objectContaining({
        action: AI_CONNECTOR_AUDIT.revoked,
        objectId: MAT,
        metadata: { grant_id: GRANT },
      }),
    ]);
    const twice = await refusal(service.revokeConnector(contextOf(SPONSOR_M), PERSON, MAT, GRANT));
    expect([twice.status, twice.auditCode]).toEqual([404, 'ai_employee:connector_not_found']);
    const other = await refusal(
      service.revokeConnector(contextOf(SPONSOR_M), PERSON, MAT, 'someone-elses-grant'),
    );
    expect(other.status).toBe(404);
    expect(audits).toHaveLength(1);
  });

  it('works in every status, a retired AI employee included', async () => {
    for (const status of ['paused', 'retired'] as const) {
      const { service, revoked } = harness({ row: mat(status) });
      await service.revokeConnector(contextOf(SPONSOR_M), PERSON, MAT, GRANT);
      expect(revoked, status).toEqual([GRANT]);
    }
  });
});

describe('the door (both routes)', () => {
  const calls = (
    service: AiEmployeeConnectionsService,
    context: TenantContext,
    principal = PERSON,
  ) => [
    service.list(context, principal, MAT),
    service.revokeConnector(context, principal, MAT, GRANT),
  ];

  it('is 404 for everyone while the server switch is off, before anything is read', async () => {
    const { service, revoked } = harness({ enabled: false, row: null });
    for (const call of calls(service, contextOf(SPONSOR_M))) {
      const off = await refusal(call);
      expect([off.status, off.auditCode]).toEqual([404, 'feature.ai_employees_off']);
    }
    expect(revoked).toEqual([]);
  });

  it('refuses a token, a client and the AI employee itself (person session only)', async () => {
    const { service } = harness();
    for (const context of [
      contextOf(SPONSOR_M, { actorChannel: 'ai_assistant' }),
      contextOf(SPONSOR_M, { principalKind: 'client' }),
    ]) {
      for (const call of calls(service, context)) {
        const refused = await refusal(call);
        expect([refused.status, refused.auditCode]).toEqual([
          403,
          'ai_employee:person_session_only',
        ]);
      }
    }
  });

  it('refuses someone who is neither the sponsor nor a manager; another workspace’s id is 404', async () => {
    const { service, revoked } = harness();
    for (const call of calls(service, contextOf(STRANGER_M))) {
      const refused = await refusal(call);
      expect([refused.status, refused.auditCode]).toEqual([403, 'ai_employee:not_sponsor']);
    }
    const manager = contextOf(STRANGER_M, { capabilities: ['people.view', 'ai_employee.manage'] });
    await expect(service.list(manager, PERSON, MAT)).resolves.toMatchObject({ live: 2 });
    const foreign = await refusal(
      service.list(contextOf(SPONSOR_M), PERSON, '0190a000-0000-7000-8000-0000000000ff'),
    );
    expect(foreign.status).toBe(404);
    expect(revoked).toEqual([]);
  });
});
