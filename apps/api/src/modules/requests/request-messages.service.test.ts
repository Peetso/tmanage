import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { RequestMessagesService } from './request-messages.service.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ClientRequestRow, RequestMessageRow } from '../../common/database/schema.js';

/** 0212 — the client <-> studio thread, database-free, with the real `authorize`. */
const ORG = 'org-1';
const context = { organizationId: ORG } as unknown as TenantContext;
const request = {
  id: 'req-1',
  organizationId: ORG,
  projectId: 'proj-1',
  clientOrganizationId: 'corg-1',
  state: 'submitted',
} as unknown as ClientRequestRow;
const base = { organizationId: ORG, membershipStatus: 'active', hasOrgWideScope: false } as const;
const team = {
  ...base,
  userId: 'u1',
  kind: 'internal',
  role: 'owner',
  membershipId: 'm1',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
} as unknown as Principal;
const clientOf = (corg: string) =>
  ({
    ...base,
    userId: 'u2',
    kind: 'client',
    role: 'client_admin',
    membershipId: 'm2',
    clientOrganizationId: corg,
    projectIds: ['proj-1'],
  }) as unknown as Principal;

function harness() {
  const rows: RequestMessageRow[] = [];
  const events: unknown[] = [];
  const db = {
    read: (_c: unknown, w: (r: unknown) => unknown) => w({}),
    transaction: (_c: unknown, w: (r: unknown) => unknown) => w({}),
  } as unknown as TenantDatabase;
  const repo = {
    listForRequest: async (_r: unknown, _c: unknown, _id: string, visibleOnly: boolean) =>
      rows.filter((m) => !visibleOnly || m.clientVisible),
    create: async (
      _r: unknown,
      _c: unknown,
      i: Omit<RequestMessageRow, 'id' | 'organizationId' | 'createdAt'>,
    ) => {
      const row = {
        ...i,
        id: `msg-${rows.length + 1}`,
        organizationId: ORG,
        createdAt: new Date(),
      } as RequestMessageRow;
      rows.push(row);
      return row;
    },
  };
  const service = new RequestMessagesService(
    db,
    { findById: async () => request } as never,
    repo as never,
    { append: async (_t: unknown, _c: unknown, e: unknown) => void events.push(e) } as never,
  );
  return { service, rows, events };
}

describe('RequestMessagesService', () => {
  it('a client sees only client-visible messages and replies visibly, with an outbox event', async () => {
    const { service, rows, events } = harness();
    await service.postForTeam(context, team, 'req-1', { body: 'team only', clientVisible: false });
    await service.postForTeam(context, team, 'req-1', { body: 'hello', clientVisible: true });
    const reply = await service.postForClient(context, clientOf('corg-1'), 'req-1', {
      body: 'thanks',
    });
    expect(reply).toMatchObject({ from: 'client', mine: true });
    expect(rows[2]).toMatchObject({ authorKind: 'client', clientVisible: true });
    const seen = await service.listForClient(context, clientOf('corg-1'), 'req-1');
    expect(seen.map((m) => m.body)).toEqual(['hello', 'thanks']);
    expect(events).toHaveLength(3);
  });

  it('a sibling client gets a 404 and writes nothing', async () => {
    const { service, rows } = harness();
    await expect(
      service.postForClient(context, clientOf('corg-2'), 'req-1', { body: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(rows).toHaveLength(0);
  });
});
