import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { InvitationsService } from './invitations.service.js';
import type { InvitationsRepository } from './invitations.repository.js';
import type { MailBouncesRepository } from '../mail-bounces/mail-bounces.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * 56-26 (B1): the invitation list carries `deliveryStopped`, read from the company's stopped
 * addresses in the same read, so the notice survives a reload. Only pending invitations are asked
 * about, and only a pending one is ever flagged.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000c1';
const context = { organizationId: ORG, userId: OWNER } as unknown as TenantContext;
const owner: Principal = {
  userId: OWNER,
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: '00000000-0000-4000-8000-0000000000e1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
};

function row(id: string, email: string, status: 'pending' | 'accepted') {
  return {
    id,
    email,
    role: 'member',
    clientOrganizationId: null,
    status,
    expiresAt: new Date('2999-01-01T00:00:00.000Z'),
    invitedByUserId: OWNER,
    acceptedByUserId: null,
    acceptedAt: null,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
  };
}

describe('InvitationsService.list — deliveryStopped (56-26 B1)', () => {
  it('flags only the pending invitation whose address is stopped, asking about pending ones only', async () => {
    const asked: string[][] = [];
    const database = {
      read: (_c: unknown, work: (runner: unknown) => Promise<unknown>) => work({}),
    } as unknown as TenantDatabase;
    const invitations = {
      list: () =>
        Promise.resolve([
          row('i-1', 'gone@atlas.example', 'pending'),
          row('i-2', 'fine@atlas.example', 'pending'),
          row('i-3', 'gone@atlas.example', 'accepted'),
        ]),
    } as unknown as InvitationsRepository;
    const bounces = {
      suppressedAddresses: (_r: unknown, _c: unknown, addresses: string[]) => {
        asked.push(addresses);
        return Promise.resolve(new Set(['gone@atlas.example']));
      },
    } as unknown as MailBouncesRepository;
    const service = new InvitationsService(
      database,
      invitations,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      bounces,
    );

    const views = await service.list(context, owner);

    expect(views.map((view) => [view.id, view.deliveryStopped])).toEqual([
      ['i-1', true],
      ['i-2', false],
      ['i-3', false],
    ]);
    expect(asked).toEqual([['gone@atlas.example', 'fine@atlas.example']]);
  });
});
