import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PeopleTeamsService } from '../people/teams.service.js';
import type { PeopleTeamsRepository } from '../people/teams.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import { WorkLabelsService } from '../work/work-labels.service.js';
import type { WorkLabelsRepository } from '../work/work-labels.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import { QuotesService } from '../quotes/quotes.service.js';
import type { QuotesRepository } from '../quotes/quotes.repository.js';
import { ClientInvoicesService } from '../finance/client-invoices.service.js';
import type { ClientInvoicesRepository } from '../finance/client-invoices.repository.js';
import { inlineFile, INLINE_FILE_MAX_BYTES } from '../files/inline-file.js';

/**
 * Fix lane C (2026-11-23, G2/G5). The removals a member needs for what they made — a team, a label
 * definition, a draft quote, a draft invoice — and the inline-file parser behind the AI's upload.
 * Each removal resolves its row tenant-scoped first (another tenant's or an unknown id is 404),
 * refuses anything that is no longer a draft (409), and audits in the same unit of work.
 */

const QUOTE_ID = '01a20869-4197-7ebe-95ae-0f9ebffc485e';
const context = { organizationId: 'org-1', userId: 'u-1' } as TenantContext;
const owner: Principal = {
  userId: 'u-1',
  organizationId: 'org-1',
  kind: 'internal',
  role: 'owner',
  membershipId: 'm-1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
};
const member: Principal = { ...owner, userId: 'u-2', role: 'member', hasOrgWideScope: false };
const tx = { tx: true };
const database = {
  read: async (_c: unknown, fn: (r: unknown) => unknown) => fn(tx),
  transaction: async (_c: unknown, fn: (r: unknown) => unknown) => fn(tx),
} as unknown as TenantDatabase;

describe('fix lane C · delete a team', () => {
  it('deletes the team and its assignments, audits the member count', async () => {
    const deleteTeam = vi.fn(async () => 3);
    const record = vi.fn();
    const service = new PeopleTeamsService(
      database,
      {
        findTeamById: async () => ({ id: 't-1', name: 'Design', createdAt: new Date() }),
        deleteTeam,
      } as unknown as PeopleTeamsRepository,
      {} as MembershipsRepository,
      { record },
    );
    await service.deleteTeam(context, 't-1');
    expect(deleteTeam).toHaveBeenCalledWith(tx, context, 't-1');
    expect(record).toHaveBeenCalledWith(
      tx,
      context,
      expect.objectContaining({ action: 'team.deleted', metadata: { member_count: 3 } }),
    );
  });

  it('answers an unknown or foreign team with 404 and deletes nothing', async () => {
    const deleteTeam = vi.fn();
    const service = new PeopleTeamsService(
      database,
      { findTeamById: async () => null, deleteTeam } as unknown as PeopleTeamsRepository,
      {} as MembershipsRepository,
    );
    await expect(service.deleteTeam(context, 't-x')).rejects.toMatchObject({ status: 404 });
    expect(deleteTeam).not.toHaveBeenCalled();
  });
});

describe('fix lane C · delete a work label', () => {
  it('removes the definition and every tag of it, audited with the count', async () => {
    const deleteDefinition = vi.fn(async () => 4);
    const record = vi.fn();
    const service = new WorkLabelsService(
      database,
      {} as WorkItemsRepository,
      {
        findDefinition: async () => ({ id: 'l-1', name: 'Urgent', color: 'red' }),
        deleteDefinition,
      } as unknown as WorkLabelsRepository,
      { record },
    );
    await service.deleteDefinition(context, 'l-1');
    expect(deleteDefinition).toHaveBeenCalledWith(tx, context, 'l-1');
    expect(record).toHaveBeenCalledWith(
      tx,
      context,
      expect.objectContaining({ action: 'work_label.deleted', metadata: { untagged_items: 4 } }),
    );
  });

  it('answers an unknown label with 404', async () => {
    const service = new WorkLabelsService(
      database,
      {} as WorkItemsRepository,
      {
        findDefinition: async () => null,
      } as unknown as WorkLabelsRepository,
    );
    await expect(service.deleteDefinition(context, 'l-x')).rejects.toMatchObject({ status: 404 });
  });
});

function quotes(status: string) {
  const deleteDraft = vi.fn(async () => true);
  const record = vi.fn();
  const service = new QuotesService({
    database,
    repository: {
      find: async () => ({ id: QUOTE_ID, organizationId: 'org-1', status }),
      deleteDraft,
    } as unknown as QuotesRepository,
    audit: { record },
    links: { createInTransaction: vi.fn() },
  });
  return { service, deleteDraft, record };
}

describe('fix lane C · delete a draft quote', () => {
  it('deletes a draft and audits quote.deleted', async () => {
    const { service, deleteDraft, record } = quotes('draft');
    await service.deleteDraft(context, owner, QUOTE_ID);
    expect(deleteDraft).toHaveBeenCalledWith(tx, context, QUOTE_ID);
    expect(record).toHaveBeenCalledWith(
      tx,
      context,
      expect.objectContaining({ action: 'quote.deleted' }),
    );
  });

  it('keeps a sent quote (409) and refuses a member without project.manage (403)', async () => {
    const sent = quotes('sent');
    await expect(sent.service.deleteDraft(context, owner, QUOTE_ID)).rejects.toMatchObject({
      status: 409,
    });
    expect(sent.deleteDraft).not.toHaveBeenCalled();
    await expect(
      quotes('draft').service.deleteDraft(context, member, QUOTE_ID),
    ).rejects.toMatchObject({ status: 403 });
  });
});

function invoices(state: string) {
  const releaseLinks = vi.fn(async () => undefined);
  const deleteDraft = vi.fn(async () => true);
  const record = vi.fn();
  const repository = {
    findInvoice: async () => ({ id: 'inv-1', state, clientOrganizationId: 'c-1' }),
    lines: async () => [{ id: 'line-1' }, { id: 'line-2' }],
    releaseLinks,
    deleteDraft,
  } as unknown as ClientInvoicesRepository;
  const service = new ClientInvoicesService({
    database,
    repository,
    audit: { record },
  } as never);
  return { service, releaseLinks, deleteDraft, record };
}

describe('fix lane C · delete a draft invoice', () => {
  it('releases what the draft pulled, then deletes it with an audit row', async () => {
    const { service, releaseLinks, deleteDraft, record } = invoices('draft');
    await service.deleteDraft(context, owner, 'inv-1');
    expect(releaseLinks).toHaveBeenCalledWith(tx, 'org-1', 'inv-1', ['line-1', 'line-2']);
    expect(deleteDraft).toHaveBeenCalledWith(tx, 'org-1', 'inv-1');
    expect(record).toHaveBeenCalledWith(
      tx,
      context,
      expect.objectContaining({ action: 'client_invoice.deleted', objectId: 'inv-1' }),
    );
  });

  it('never deletes an issued invoice (409) and refuses a member without finance.manage', async () => {
    const sent = invoices('sent');
    await expect(sent.service.deleteDraft(context, owner, 'inv-1')).rejects.toMatchObject({
      status: 409,
    });
    expect(sent.deleteDraft).not.toHaveBeenCalled();
    await expect(
      invoices('draft').service.deleteDraft(context, member, 'inv-1'),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('fix lane C · inline file parser', () => {
  it('accepts a small allowed file and decodes it', () => {
    const file = inlineFile({
      name: 'notes.txt',
      mimeType: 'text/plain',
      contentBase64: 'aGVsbG8=',
    });
    expect(file).toMatchObject({ name: 'notes.txt', mimeType: 'text/plain' });
    expect(file.bytes.toString('utf8')).toBe('hello');
  });

  it.each([
    [{ name: '../x.txt', mimeType: 'text/plain', contentBase64: 'aGVsbG8=' }, 'name'],
    [{ name: 'a\u0000.txt', mimeType: 'text/plain', contentBase64: 'aGVsbG8=' }, 'name'],
    [
      { name: 'x.exe', mimeType: 'application/x-msdownload', contentBase64: 'aGVsbG8=' },
      'mimeType',
    ],
    [{ name: 'x.txt', mimeType: 'text/plain', contentBase64: 'not base64!' }, 'contentBase64'],
    [{ name: 'x.txt', mimeType: 'text/plain', contentBase64: '' }, 'contentBase64'],
  ])('refuses %j on %s', (body, field) => {
    expect(() => inlineFile(body)).toThrow(
      expect.objectContaining({ status: 400, details: [expect.objectContaining({ field })] }),
    );
  });

  it('refuses content over the inline cap before decoding it', () => {
    const big = 'A'.repeat((Math.ceil(INLINE_FILE_MAX_BYTES / 3) + 4) * 4);
    expect(() =>
      inlineFile({ name: 'big.txt', mimeType: 'text/plain', contentBase64: big }),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });
});
