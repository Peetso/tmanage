import { describe, expect, it } from 'vitest';
import { FakeObjectStore } from '@tmanage/storage';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { InboundEmailService, inboundServicePrincipal } from './inbound-email.service.js';
import type { InboundEmailRepository } from './inbound-email.repository.js';
import { MAX_DAILY_ATTACHMENT_BYTES, attachmentObjectKey } from './inbound-mail-rules.js';
import type { ParsedInboundMessage } from './inbound-mail-rules.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/** R21-f — ingest (dedup, DMARC gate, sender -> request or held), log, trust. */
const ORG = '0192f000-0000-7000-8000-0000000000aa';
const ADDRESS = '0192f000-0000-7000-8000-0000000000ab';
const PDF = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(1992)]);
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

function harness(
  opts: {
    status?: string;
    sender?: boolean;
    member?: boolean;
    shared?: boolean;
    usedToday?: number;
    /** 57-13r: bytes already held on TManage, against a 1,000,000-byte upload limit. */
    storageHeld?: number;
  } = {},
) {
  const emails: Row[] = [];
  const atts: Row[] = [];
  const submitted: Row[] = [];
  const created: Row[] = [];
  const store = new FakeObjectStore(() => 0);
  const address = {
    id: ADDRESS,
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
    findSenderMember: () =>
      Promise.resolve(opts.member ? { userId: 'mu-1', membershipId: 'mm-1' } : null),
    dailyAttachmentBytes: () => Promise.resolve(opts.usedToday ?? 0),
    setOutcome: (_r: never, _c: never, id: string, row: Row) =>
      Promise.resolve(void Object.assign(emails.find((e) => e['id'] === id) ?? {}, row)),
    expireWaitingAttachments: (_r: never, _c: never, id: string) => {
      const waiting = atts.filter(
        (a) => a['inboundEmailId'] === id && a['state'] === 'waiting_trust',
      );
      for (const a of waiting) a['state'] = 'unavailable';
      return Promise.resolve(waiting.length);
    },
    markTrusted: (_r: never, _c: never, id: string, row: Row) =>
      Promise.resolve(void Object.assign(emails.find((e) => e['id'] === id) ?? {}, row)),
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
  const workItems = {
    create: (_c: unknown, principal: Principal, input: Row) => (
      created.push({ ...input, principal }),
      Promise.resolve({ id: 'wi-1' })
    ),
  };
  const service = new InboundEmailService(db, repo, {
    requests: requests as never,
    audit: audit as never,
    workItems: workItems as never,
    store,
    now: () => NOW,
    domain: 'tmanageapp.com',
    ...(opts.storageHeld === undefined
      ? {}
      : {
          storage: {
            limits: {
              limitsFor: () =>
                Promise.resolve({
                  allowanceBytes: 1_000_000,
                  uploadLimitBytes: 1_000_000,
                  limitedBy: 'plan',
                }),
            },
            counters: {
              find: () =>
                Promise.resolve({ usedValue: opts.storageHeld, reservedValue: 0 } as never),
            },
          },
        }),
  });
  return { service, emails, atts, submitted, created, store };
}

const pass = { 'Authentication-Results': 'mx; dmarc=pass' };
const fail = { 'Authentication-Results': 'mx; dmarc=fail' };

const mail = (over: Partial<ParsedInboundMessage> = {}): ParsedInboundMessage => ({
  to: 'requests+acme-ab12cd@tmanageapp.com',
  from: 'Client <client@acme.com>',
  messageId: '<m-1@acme.com>',
  date: null,
  subject: 'New banner',
  text: null,
  html: '<p>Please resize</p><script>steal()</script>',
  headers: { 'Authentication-Results': 'mx; dmarc=pass' },
  attachments: [
    { name: 'brief.pdf', sizeBytes: 9, declaredType: 'application/pdf', head: null, bytes: PDF },
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

describe('InboundEmailService — webhook outcomes and bytes (R22-c)', () => {
  it('files a passing member mail as a work item owned by the member', async () => {
    const h = harness({ sender: false, member: true });
    expect(await h.service.ingest(mail())).toMatchObject({ status: 'work_item' });
    expect(h.created[0]).toMatchObject({
      projectId: 'p-1',
      ownerUserId: 'mu-1',
      title: 'New banner',
      description: 'Please resize',
    });
    expect(h.created[0]?.['principal']).toMatchObject({
      projectIds: ['p-1'],
      hasOrgWideScope: false,
    });
    expect(h.emails[0]).toMatchObject({ outcome: 'work_item', linkedObjectType: 'work_item' });
    const reach = (projectId: string) =>
      authorize({
        principal: inboundServicePrincipal(ORG, 'p-1'),
        capability: 'work.create',
        resource: { organizationId: ORG, projectId, audience: 'internal', lifecycle: 'active' },
      }).allowed;
    expect([reach('p-1'), reach('p-2')]).toEqual([true, false]);
  });

  it('holds a non-member (a member of another org is not found) and prefers the client', async () => {
    expect(await harness({ sender: false }).service.ingest(mail())).toMatchObject({
      reason: 'unknown_sender',
    });
    const both = harness({ member: true });
    expect(await both.service.ingest(mail())).toMatchObject({ status: 'client_request' });
    expect(both.created).toHaveLength(0);
  });

  it('dmarc=fail: a 2 MB PDF stays waiting_trust with no sha256 and nothing written', async () => {
    const h = harness();
    const big = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(2 * 1024 * 1024)]);
    await h.service.ingest(
      mail({
        headers: fail,
        attachments: [
          { name: 'a.pdf', sizeBytes: big.length, declaredType: null, head: null, bytes: big },
        ],
      }),
    );
    expect(h.atts[0]).toMatchObject({ state: 'waiting_trust', sha256: null });
    expect(h.store.quarantinePut).toHaveLength(0);
  });

  it('dmarc=pass: parks the PDF under attachmentObjectKey with its sha256', async () => {
    const h = harness();
    await h.service.ingest(mail({ headers: pass }));
    const id = h.atts[0]?.['id'] as string;
    expect(h.atts[0]).toMatchObject({ state: 'scanning', sizeBytes: PDF.length });
    expect(h.atts[0]?.['sha256']).toMatch(/^[0-9a-f]{64}$/u);
    expect(h.store.quarantinePut).toEqual([attachmentObjectKey(ORG, ADDRESS, id)]);
  });

  it('blocks a macro ZIP and stops at the daily byte cap without writing', async () => {
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('word/vbaProject.bin'),
    ]);
    const h = harness();
    await h.service.ingest(
      mail({
        attachments: [{ name: 'r.docx', sizeBytes: 1, declaredType: null, head: null, bytes: zip }],
      }),
    );
    expect(h.atts[0]?.['state']).toBe('blocked_type');
    const capped = harness({ usedToday: MAX_DAILY_ATTACHMENT_BYTES - 1000 });
    await capped.service.ingest(mail());
    expect(capped.atts[0]?.['state']).toBe('too_large');
    expect([...h.store.quarantinePut, ...capped.store.quarantinePut]).toHaveLength(0);
  });

  it('57-13r: refuses an attachment at a full storage allowance and parks it below', async () => {
    const full = harness({ storageHeld: 1_000_000 });
    await full.service.ingest(mail());
    expect(full.atts[0]?.['state']).toBe('too_large');
    expect(full.store.quarantinePut).toHaveLength(0);
    const room = harness({ storageHeld: 0 });
    await room.service.ingest(mail());
    expect(room.atts[0]?.['state']).toBe('scanning');
    expect(room.store.quarantinePut).toHaveLength(1);
  });

  it('trusting a held mail creates the request and turns its attachments unavailable', async () => {
    const h = harness();
    const { inboundEmailId } = await h.service.ingest(mail({ headers: fail }));
    const trusted = await h.service.trust(context, owner, inboundEmailId as string);
    expect(trusted).toMatchObject({ outcome: 'client_request', attachmentsReleased: 1 });
    expect(h.atts[0]?.['state']).toBe('unavailable');
    expect(h.submitted).toHaveLength(1);
  });
});
