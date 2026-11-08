import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { FileAssetRow } from '../../common/database/schema.js';
import { mayReadHit, reachScope } from './search-permission.js';
import type { SearchIndexHitRow } from './search-index.repository.js';

/**
 * 53-17 — the per-hit read rule for the new kinds. A search never returns an item the caller
 * cannot read: a client sees only its own sent invoices and the files the files relation lets it
 * reach, never quotes or expenses; a member sees its own expenses and nothing in finance.
 */

const ORG = 'org-1';
const PROJECT = 'project-1';
const CLIENT_ORG = 'client-org-1';
const NOW = new Date('2026-11-08T10:00:00.000Z');

function principal(overrides: Partial<Principal>): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
    ...overrides,
  };
}

const member = principal({});
const owner = principal({ role: 'owner', hasOrgWideScope: true, projectIds: [] });
const client = principal({
  kind: 'client',
  role: 'client_admin',
  clientOrganizationId: CLIENT_ORG,
  membershipId: 'membership-client',
});

function hit(overrides: Partial<SearchIndexHitRow>): SearchIndexHitRow {
  return {
    organizationId: ORG,
    projectId: PROJECT,
    targetKind: 'work_item',
    targetId: 'x',
    title: 't',
    audience: 'internal',
    updatedAt: NOW,
    ...overrides,
  };
}

const sentInvoice = hit({
  targetKind: 'invoice',
  projectId: null,
  state: 'sent',
  clientOrganizationId: CLIENT_ORG,
  audience: 'client_visible',
});

describe('AUTH-53-17-1 search permission filter', () => {
  it('gives a client only its own sent invoices and reached files, never quotes or expenses', () => {
    expect(mayReadHit(client, sentInvoice)).toBe(true);
    expect(mayReadHit(client, { ...sentInvoice, state: 'draft' })).toBe(false);
    expect(mayReadHit(client, { ...sentInvoice, clientOrganizationId: 'other-client' })).toBe(
      false,
    );
    expect(mayReadHit(client, hit({ targetKind: 'quote', projectId: null }))).toBe(false);
    expect(
      mayReadHit(client, hit({ targetKind: 'expense', ownerMembershipId: client.membershipId })),
    ).toBe(false);

    const asset = {
      id: 'f1',
      organizationId: ORG,
      projectId: PROJECT,
      clientOrganizationId: CLIENT_ORG,
      purpose: 'deliverable',
      audience: 'internal',
    } as unknown as FileAssetRow;
    const file = hit({ targetKind: 'file', targetId: 'f1', asset });
    expect(mayReadHit(client, file)).toBe(false);
    expect(mayReadHit(client, file, { fileReach: new Map([['f1', null]]) })).toBe(false);
    expect(mayReadHit(client, file, { fileReach: new Map([['f1', 'client_visible']]) })).toBe(true);
    expect(mayReadHit(client, hit({ targetKind: 'work_item' }))).toBe(false);

    expect(reachScope(client)).toMatchObject({
      invoicesClient: true,
      quotes: false,
      expenses: false,
    });
  });

  it('keeps finance from a member: own expenses only, no invoices, no quotes; owner sees all', () => {
    const others = hit({ targetKind: 'expense', ownerMembershipId: 'membership-2' });
    expect(
      mayReadHit(member, hit({ targetKind: 'expense', ownerMembershipId: 'membership-1' })),
    ).toBe(true);
    expect(mayReadHit(member, others)).toBe(false);
    expect(mayReadHit(member, sentInvoice)).toBe(false);
    expect(mayReadHit(member, hit({ targetKind: 'quote', projectId: null }))).toBe(false);
    expect(mayReadHit(owner, others)).toBe(true);
    expect(mayReadHit(owner, sentInvoice)).toBe(true);
    expect(mayReadHit(owner, { ...sentInvoice, organizationId: 'org-2' })).toBe(false);
  });
});
