import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { InboundEmailService } from './inbound-email.service.js';
import type { InboundEmailRepository } from './inbound-email.repository.js';
import type { ParsedInboundMessage } from './inbound-mail-rules.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/** R21-f — ingest (dedup, DMARC gate, sender -> request or held), log, trust. */
const ORG = '0192f000-0000-7000-8000-0000000000aa';
const NOW = new Date('2026-11-02T12:00:00.000Z');
const run = (_c: unknown, work: (r: never) => unknown) => work({} as never);
const db = { read: run, transaction: run, bootstrapRead: run } as unknown as TenantDatabase;
const context = { organizationId: ORG, correlationId: 'c' } as TenantContext;
const owner: Principal = {
  userId: 'u-1',
  organizationId: ORG,
  kind: 'internal',
  role: 'org_admin',
  membershipId: 'm-1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
};
const client = {
  ...owner,
  kind: 'client',
  role: 'client_admin',
  clientOrganizationId: 'co-1',
  hasOrgWideScope: false,
} as unknown as Principal;

type Row = Record<string, unknown>;

function harness(opts: { status?: string; sender?: boolean; shared?: boolean } = {}) {
  const emails: Row[] = [];
  const atts: Row[] = [];
  const submitted: Row[] = [];
  const address = {
    id: 'a-1',
    organizationId: ORG,
    localPart: 'requests+acme-ab12cd',
    status: opts.status ?? 'active',
    defaultProjectId: 'p-1',
    policyJson: '{}',
    createdAt: NOW,
    rotatedAt: null,
  };
  const repo = {
    findAddressByLocalPart: () => Promise.resolve(address),
    findAddressById: () => Promise.resolve(address),
    findByMessageHash: (_r: never, _c: never, h: string) =>
      Promise.resolve(emails.find((e) => e['messageIdHash'] === h) ?? null),
    findSenderClient: () =>
      Promise.resolve(
        opts.sender === false ? null : { clientOrganizationId: 'co-1', userId: 'cu-1' },
      ),
    projectExists: () => Promise.resolve(true),
    isProjectShared: () => Promise.resolve(opts.shared !== false),
    insertEmail: (_r: never, _c: never, row: Row) =>
      Promise.resolve(void emails.push({ ...row, receivedAt: NOW, trustedAt: null })),
    insertAttachments: (_r: never, _c: never, rows: Row[]) =>
      Promise.resolve(void atts.push(...rows)),
    findEmail: (_r: never, _c: never, id: string) =>
      Promise.resolve(emails.find((e) => e['id'] === id) ?? null),
    listEmails: () => Promise.resolve(emails.map(({ bodyText: _b, ...rest }) => rest)),
    listAttachments: () => Promise.resolve(atts),
  } as unknown as InboundEmailRepository;
  const requests = {
    submit: (_r: never, _c: never, input: Row) => (
      submitted.push(input),
      Promise.resolve({ id: 'cr-1' })
    ),
  };
  const audit = { append: () => Promise.resolve({}) };
  const service = new InboundEmailService(db, repo, {
    requests: requests as never,
    audit: audit as never,
    now: () => NOW,
    domain: 'tmanage.peetrix.com',
  });
  return { service, emails, atts, submitted };
}

const mail = (over: Partial<ParsedInboundMessage> = {}): ParsedInboundMessage => ({
  to: 'requests+acme-ab12cd@tmanage.peetrix.com',
  from: 'Client <client@acme.com>',
  messageId: '<m-1@acme.com>',
  date: null,
  subject: 'New banner',
  text: null,
  html: '<p>Please resize</p><script>steal()</script>',
  headers: { 'Authentication-Results': 'mx; dmarc=pass' },
  attachments: [
    { name: 'brief.pdf', sizeBytes: 2000, declaredType: 'application/pdf', head: null },
  ],
  correlationId: 'corr',
  ...over,
});

describe('InboundEmailService (R21-f)', () => {
  it('holds a DMARC failure, attachments waiting_trust, and never submits a request', async () => {
    const h = harness();
    const result = await h.service.ingest(
      mail({ headers: { 'Authentication-Results': 'mx; dmarc=fail' } }),
    );
    expect(result).toMatchObject({ status: 'held', reason: 'dmarc_failed' });
    expect(h.atts.map((a) => a['state'])).toEqual(['waiting_trust']);
    expect(h.submitted).toHaveLength(0);
  });

  it('creates a client request from a passing known client with the sanitised body', async () => {
    const h = harness();
    expect(await h.service.ingest(mail())).toMatchObject({ status: 'client_request' });
    expect(h.submitted[0]).toMatchObject({
      projectId: 'p-1',
      submittedByUserId: 'cu-1',
      title: 'New banner',
    });
    expect(h.submitted[0]?.['description']).toBe('Please resize');
    expect(h.emails[0]).toMatchObject({
      linkedObjectType: 'client_request',
      linkedObjectId: 'cr-1',
    });
    expect(h.atts[0]?.['state']).toBe('scanning');
  });

  it('holds an unknown sender', async () => {
    expect(await harness({ sender: false }).service.ingest(mail())).toMatchObject({
      status: 'held',
      reason: 'unknown_sender',
    });
  });

  it('answers duplicate for the same message id and keeps one row', async () => {
    const h = harness();
    await h.service.ingest(mail());
    expect(await h.service.ingest(mail())).toEqual({ status: 'duplicate' });
    expect(h.emails).toHaveLength(1);
  });

  it('drops mail to a rotated address, and the 101st in the hour', async () => {
    expect(await harness({ status: 'rotated' }).service.ingest(mail())).toEqual({
      status: 'dropped',
    });
    const h = harness();
    for (let i = 0; i < 100; i += 1)
      await h.service.ingest(mail({ messageId: `<m-${String(i)}@a>` }));
    expect(await h.service.ingest(mail({ messageId: '<m-x@a>' }))).toEqual({
      status: 'dropped_rate_limited',
    });
  });

  it('refuses to trust a passing mail (409) and the log carries no body', async () => {
    const h = harness();
    const { inboundEmailId } = await h.service.ingest(mail());
    await expect(h.service.trust(context, owner, inboundEmailId as string)).rejects.toMatchObject({
      status: 409,
    });
    const log = await h.service.log(context, owner, undefined);
    expect(JSON.stringify(log)).not.toContain('Please resize');
    expect(log.entries[0]?.attachments).toEqual([
      { name: 'brief.pdf', sizeBytes: 2000, state: 'scanning' },
    ]);
  });

  it('refuses a client principal with 403', async () => {
    await expect(harness().service.log(context, client, undefined)).rejects.toMatchObject({
      status: 403,
    });
    await expect(harness().service.address(context, client)).rejects.toMatchObject({ status: 403 });
  });
});
