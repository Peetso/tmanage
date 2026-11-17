import { describe, expect, it } from 'vitest';
import {
  BounceGuardMailer,
  bounceMessageId,
  deriveBounceKey,
  emailAddressHash,
  readBounceMessageId,
} from '@tmanage/mail';
import type { MailMessage } from '@tmanage/mail';
import type { Principal } from '@tmanage/domain';
import type {
  ExternalApproverRow,
  PublicLinkCodeRow,
  PublicLinkRow,
} from '../../common/database/schema.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import { PublicLinkSecrets } from '../public-links/public-link-secrets.js';
import { PublicLinkTargets } from '../public-links/public-link-targets.js';
import type { PublicLinkDecisionDetail } from '../public-links/public-link-targets.js';
import { maskEmail, PublicLinksService } from '../public-links/public-links.service.js';
import type { PublicLinkStore } from '../public-links/public-links.service.js';
import { ExternalApprovalsService, externalDecisionRefusal } from './external-approvals.service.js';
import type { ExternalApprovalsServiceOptions } from './external-approvals.service.js';

const ORG = '0190f000-0000-7000-8000-000000000001';
const LINK = '0190f000-0000-7000-8000-000000000002';
const VERSION = '0190f000-0000-7000-8000-000000000003';
const DELIVERABLE = '0190f000-0000-7000-8000-000000000004';
const SENDER = '0190f000-0000-7000-8000-000000000005';
const context = createServiceContext({
  organizationId: ORG,
  correlationId: LINK,
  policyVersion: 't',
});
const secrets = new PublicLinkSecrets('test-pepper-of-sufficient-length');

const link = {
  id: LINK,
  organizationId: ORG,
  kind: 'approval',
  targetId: VERSION,
  versionHash: 'h1',
} as PublicLinkRow;
const record = {
  id: 'rec-1',
  organizationId: ORG,
  publicLinkId: LINK,
  projectId: 'proj-1',
  deliverableId: DELIVERABLE,
  deliverableVersionId: VERSION,
  contentHash: 'h1',
  requestedByUserId: SENDER,
  decision: null,
} as ExternalApproverRow;
const verified: PublicLinkDecisionDetail = {
  comment: 'Looks good',
  typedName: 'Sara Ali',
  verified: true,
  ipHash: 'ip',
  userAgent: 'ua',
  decidedAt: new Date('2026-11-08T10:00:00Z'),
};

function service(overrides: Partial<ExternalApprovalsServiceOptions> = {}) {
  const outbox: unknown[] = [];
  const audit: unknown[] = [];
  const mail: { to: string; text: string }[] = [];
  const created: unknown[] = [];
  const decided: unknown[] = [];
  const svc = new ExternalApprovalsService({
    database: {
      transaction: (_c, work) => work({} as never),
      read: (_c, work) => work({} as never),
    },
    approvers: {
      insert: async () => undefined,
      findByLink: async (_r, _c, id) => (id === LINK ? record : null),
      listForVersion: async () => [],
      decide: async (_r, _c, _id, facts) => (decided.push(facts), true),
    },
    versions: {
      findById: async (_r, _c, id) =>
        id === VERSION
          ? ({
              id,
              deliverableId: DELIVERABLE,
              projectId: 'proj-1',
              contentHash: 'h1',
              versionNo: 2,
            } as never)
          : null,
    },
    deliverables: { findById: async () => ({ title: 'Homepage' }) as never },
    links: {
      createInTransaction: async (_tx, _c, _p, input) => (
        created.push(input),
        { id: LINK, token: 'tmanage_lnk_abc', expiresAt: '2026-11-15T00:00:00.000Z' } as never
      ),
      list: async () => [],
    },
    outbox: { append: async (_r, _c, e) => (outbox.push(e), 'evt') },
    audit: { record: async (_r, _c, e) => (audit.push(e), {}) as never },
    mailer: { send: async (m) => (mail.push(m), {}) as never },
    organizationName: async () => 'Northstar',
    webPublicUrl: 'https://tmanage.example/',
    ...overrides,
  });
  return { svc, outbox, audit, mail, created, decided };
}

describe('52-18 external approver: decision permission', () => {
  it('allows a verified decision on the exact version the link was sent for', () => {
    expect(externalDecisionRefusal(record, link, 'approve', verified)).toBeNull();
    expect(externalDecisionRefusal(record, link, 'request_changes', verified)).toBeNull();
  });

  it('refuses unverified, superseded, already decided, unknown and foreign decisions', () => {
    expect(externalDecisionRefusal(record, link, 'approve', { verified: false })).toBe(
      'unverified',
    );
    expect(
      externalDecisionRefusal(record, { ...link, versionHash: 'h2' }, 'approve', verified),
    ).toBe('superseded');
    expect(
      externalDecisionRefusal({ ...record, decision: 'approve' }, link, 'approve', verified),
    ).toBe('already_decided');
    expect(externalDecisionRefusal(record, link, 'delete', verified)).toBe('unknown_decision');
    expect(
      externalDecisionRefusal(record, { ...link, organizationId: VERSION }, 'approve', verified),
    ).toBe('not_this_link');
    expect(externalDecisionRefusal(record, { ...link, kind: 'share' }, 'approve', verified)).toBe(
      'not_this_link',
    );
  });

  it('records once, tells the sender through approval.decided.v1 and audits', async () => {
    const s = service();
    await s.svc.recordDecision({} as never, context, link, 'request_changes', verified);
    expect(s.decided).toMatchObject([
      { decision: 'request_changes', emailVerified: true, typedName: 'Sara Ali' },
    ]);
    expect(s.outbox).toMatchObject([
      {
        type: 'approval.decided.v1',
        payload: {
          decision: 'changes_requested',
          requestedByUserId: SENDER,
          decidedByUserId: 'rec-1',
        },
      },
    ]);
    expect(s.audit).toMatchObject([{ action: 'approval.changes_requested', actorUserId: null }]);
  });

  it('rolls the link decision back when the record refuses it', async () => {
    const s = service();
    await expect(
      s.svc.recordDecision({} as never, context, link, 'approve', { ...verified, verified: false }),
    ).rejects.toMatchObject({ status: 409 });
    expect(s.outbox).toEqual([]);
  });
});

describe('52-18 external approver: send', () => {
  it('always binds the e-mail, always needs the code, and mails the /a/ link', async () => {
    const s = service();
    const sent = await s.svc.send(context, {} as Principal, DELIVERABLE, VERSION, {
      email: ' Sara@Client.com ',
      message: 'Final logo',
    });
    expect(s.created).toMatchObject([
      { kind: 'approval', audienceEmail: 'sara@client.com', requireCode: true },
    ]);
    expect(sent.url).toBe('https://tmanage.example/a/tmanage_lnk_abc');
    expect(sent.mailed).toBe(true);
    expect(s.mail[0]?.to).toBe('sara@client.com');
    expect(s.mail[0]?.text).toContain('/a/tmanage_lnk_abc');
  });

  it('refuses a bad e-mail and a version of another deliverable', async () => {
    const s = service();
    await expect(
      s.svc.send(context, {} as Principal, DELIVERABLE, VERSION, { email: 'x' }),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      s.svc.send(context, {} as Principal, SENDER, VERSION, { email: 'a@b.co' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('52-18 external approver: token and code check', () => {
  it('passes verified=true and the typed name to the observer only after the mailed code', async () => {
    const issued = secrets.issueToken();
    const row = {
      id: LINK,
      organizationId: ORG,
      kind: 'approval',
      tokenHash: issued.hash,
      targetType: 'deliverable_version',
      targetId: VERSION,
      versionHash: 'h1',
      audienceEmail: 'sara@client.com',
      requireCode: true,
      expiresAt: new Date(Date.now() + 60_000),
      maxUses: null,
      uses: 0,
      decision: null,
      revokedAt: null,
    } as PublicLinkRow;
    let code: PublicLinkCodeRow | null = null;
    const store = {
      findById: async () => row,
      appendEvent: async () => undefined,
      organizationName: async () => 'Northstar',
      countEventsSince: async () => 0,
      putCode: async (_r: unknown, _c: unknown, c: PublicLinkCodeRow) =>
        void (code = { ...c, organizationId: ORG, attempts: 0 }),
      findCode: async () => code,
      countCodeAttempt: async () => undefined,
      deleteCode: async () => void (code = null),
      decide: async () => true,
    } as unknown as PublicLinkStore;
    const targets = new PublicLinkTargets();
    targets.register({
      targetType: 'deliverable_version',
      kinds: ['approval'],
      manageCapability: 'deliverable.publish',
      decisions: ['approve', 'request_changes'],
      resolve: async () => ({ projectId: null, versionHash: 'h1', projection: {} }),
    });
    const seen: PublicLinkDecisionDetail[] = [];
    targets.observeDecisions('deliverable_version', async (_t, _c, _l, _d, detail) => {
      seen.push(detail);
    });
    const mail: string[] = [];
    const links = new PublicLinksService({
      database: {
        transaction: (_c, work) => work({} as never),
        read: (_c, work) => work({} as never),
      },
      lookup: async (hash) => (hash === issued.hash ? { id: LINK, organizationId: ORG } : null),
      targets,
      secrets,
      audit: { record: async () => ({}) as never },
      mailer: { send: async (m) => (mail.push(m.text), {}) as never },
      store,
    });
    const body = { decision: 'approve', versionHash: 'h1', name: 'Sara Ali' };
    await expect(links.decide(issued.token, body, {})).rejects.toMatchObject({ status: 400 });
    await expect(links.decide('tmanage_lnk_forged', body, {})).rejects.toMatchObject({
      status: 404,
    });
    expect(seen).toEqual([]);
    await links.sendCode(issued.token, {});
    const sentCode = /is (\d{6})\./.exec(mail[0] ?? '')?.[1] ?? '';
    await links.decide(issued.token, { ...body, code: sentCode }, {});
    expect(seen).toMatchObject([{ verified: true, typedName: 'Sara Ali' }]);
  });

  it('masks the audience e-mail for the watermark', () => {
    expect(maskEmail('sara@client.com')).toBe('s•••@client.com');
    expect(maskEmail(null)).toBeNull();
  });
});

describe('56-26 external approver mail and bounces', () => {
  const key = deriveBounceKey('k'.repeat(48));
  it('names the company (so the Message-ID is signed for it); a bounced address is not mailed', async () => {
    const sentMail: MailMessage[] = [];
    let suppressed = false;
    const mailer = new BounceGuardMailer(
      { send: async (m) => (sentMail.push(m), 'sent' as const) },
      { isBounceSuppressed: async () => suppressed },
    );
    const s = service({ mailer });
    const ok = await s.svc.send(context, {} as Principal, DELIVERABLE, VERSION, {
      email: 'sara@client.com',
    });
    expect(ok.mailed).toBe(true);
    const message = sentMail[0] as MailMessage;
    expect(message.organizationId).toBe(context.organizationId);
    const id = bounceMessageId(key, {
      organizationId: message.organizationId as string,
      to: message.to,
      domain: 'tm.io',
    }) as string;
    expect(readBounceMessageId(key, id)).toMatchObject({
      organizationId: context.organizationId,
      addressHash: emailAddressHash('sara@client.com'),
    });

    suppressed = true;
    const held = await s.svc.send(context, {} as Principal, DELIVERABLE, VERSION, {
      email: 'sara@client.com',
    });
    expect(held.mailed).toBe(false);
    expect(held.url).toBe('https://tmanage.example/a/tmanage_lnk_abc');
    expect(sentMail).toHaveLength(1);
  });
});
