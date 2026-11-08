import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Mailer } from '@tmanage/mail';
import { ApiError } from '../../../common/http/errors.js';
import { PlatformOrganizationsController } from '../organizations/organizations.controller.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';
import { AccessReviewService, parseQuarter } from '../team/access-review.service.js';
import type { AccessReviewStore } from '../team/access-review.repository.js';
import type { ApprovalRecord, GovernanceStore, NewOwnerNotice } from './governance.repository.js';
import { APPROVAL_TTL_MS, PlatformGovernanceService } from './governance.service.js';
import { TwoPersonApprovalGuard } from './two-person.guard.js';

/** 56-21 (R46 L2) — two-person rule, owner notices, quarterly access review. Fake stores only. */

const NOW = new Date('2026-11-08T10:00:00.000Z');
const ORG = '0199aa00-0000-7000-8000-00000000c0de';
const APPROVAL = '0199aa00-0000-7000-8000-0000000000a9';
const ctx = { correlationId: 'c-1', ip: null, userAgent: null };

function actor(userId: string): PlatformAdminActor {
  return {
    account: {
      userId,
      email: `${userId}@tmanage.test`,
      displayName: userId,
      emailVerified: true,
      mfaEnabled: true,
    },
    sessionId: 's',
    stepUp: null,
    permissions: ['platform.team.manage', 'platform.orgs.lifecycle'],
  } as unknown as PlatformAdminActor;
}

function approval(over: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: APPROVAL,
    action: 'company.suspend',
    targetId: ORG,
    targetLabel: 'Acme',
    reason: 'Unpaid for 60 days',
    status: 'pending',
    requestedBy: 'alice',
    requestedByEmail: 'alice@tmanage.test',
    requestedAt: NOW,
    expiresAt: new Date(NOW.getTime() + APPROVAL_TTL_MS),
    decidedBy: null,
    decidedByEmail: null,
    decidedAt: null,
    decisionNote: null,
    usedAt: null,
    ...over,
  };
}

function harness(
  opts: { policy?: boolean; row?: ApprovalRecord | null; consumed?: boolean; owner?: boolean } = {},
) {
  const audits: PlatformAuditInput[] = [];
  const notices: NewOwnerNotice[] = [];
  const consumeCalls: unknown[][] = [];
  const store: GovernanceStore = {
    readPolicy: () => Promise.resolve(opts.policy ?? false),
    writePolicy: (_e, audit) => (audits.push(audit), Promise.resolve()),
    listApprovals: () => Promise.resolve(opts.row ? [opts.row] : []),
    findApproval: () => Promise.resolve(opts.row ?? null),
    insertApproval: (_r, audit) => (audits.push(audit), Promise.resolve()),
    decide: (_id, _s, _by, _n, _now, audit) => (audits.push(audit), Promise.resolve(true)),
    consume: (...args) => (consumeCalls.push(args), Promise.resolve(opts.consumed ?? false)),
    findOwner: () =>
      Promise.resolve({
        organizationId: ORG,
        organizationName: 'Acme',
        ownerUserId: opts.owner === false ? null : 'owner-1',
        ownerEmail: opts.owner === false ? null : 'mona@acme.test',
      }),
    insertNotice: (row, audit) => (notices.push(row), audits.push(audit), Promise.resolve()),
    listNotices: () => Promise.resolve([]),
  };
  const sent: unknown[] = [];
  const mailer: Mailer = { send: (m) => (sent.push(m), Promise.resolve('sent')) };
  return { store, audits, notices, sent, consumeCalls, mailer };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof ApiError ? `${String(e.status)}` : String(e)),
  );

describe('56-21 two-person approvals', () => {
  it('records a request for a risky action and refuses an unknown action or a missing reason', async () => {
    const h = harness();
    const service = new PlatformGovernanceService(h.store, null, () => NOW);
    const view = await service.request(
      actor('alice'),
      { action: 'company.suspend', targetId: ORG, reason: 'Unpaid for 60 days' },
      ctx,
    );
    expect(view).toMatchObject({ status: 'pending', mine: true, action: 'company.suspend' });
    expect(h.audits[0]?.action).toBe('platform.approval_requested');
    expect(
      await code(
        service.request(
          actor('a'),
          { action: 'company.rename', targetId: ORG, reason: 'xxxxx' },
          ctx,
        ),
      ),
    ).toBe('400');
    expect(
      await code(service.request(actor('a'), { action: 'company.suspend', targetId: ORG }, ctx)),
    ).toBe('400');
  });

  it('refuses a self-approval and lets a different admin approve', async () => {
    const service = new PlatformGovernanceService(
      harness({ row: approval() }).store,
      null,
      () => NOW,
    );
    expect(await code(service.decide(actor('alice'), APPROVAL, 'approved', {}, ctx))).toBe('403');
    const view = await service.decide(actor('bob'), APPROVAL, 'approved', {}, ctx);
    expect(view.status).toBe('approved');
  });

  it('will not decide an expired request', async () => {
    const expired = approval({ expiresAt: new Date(NOW.getTime() - 1) });
    const service = new PlatformGovernanceService(harness({ row: expired }).store, null, () => NOW);
    expect(await code(service.decide(actor('bob'), APPROVAL, 'approved', {}, ctx))).toBe('409');
  });

  it('is a no-op while the policy is off, and needs a consumable approval while it is on', async () => {
    const off = harness({ policy: false });
    await new PlatformGovernanceService(off.store, null).requireApproval(
      actor('alice'),
      'company.suspend',
      ORG,
      undefined,
      ctx,
    );
    expect(off.consumeCalls).toHaveLength(0);

    const missing = new PlatformGovernanceService(harness({ policy: true }).store, null);
    expect(
      await code(missing.requireApproval(actor('alice'), 'company.suspend', ORG, undefined, ctx)),
    ).toBe('409');

    const unused = harness({ policy: true, consumed: false });
    expect(
      await code(
        new PlatformGovernanceService(unused.store, null).requireApproval(
          actor('alice'),
          'company.suspend',
          ORG,
          APPROVAL,
          ctx,
        ),
      ),
    ).toBe('409');

    const ok = harness({ policy: true, consumed: true });
    await new PlatformGovernanceService(ok.store, null).requireApproval(
      actor('alice'),
      'company.delete',
      ORG,
      APPROVAL,
      ctx,
    );
    expect(ok.consumeCalls[0]?.slice(0, 4)).toEqual([APPROVAL, 'company.delete', ORG, 'alice']);
  });

  it('puts the guard on the risky lifecycle routes only', () => {
    const proto = PlatformOrganizationsController.prototype as unknown as Record<string, object>;
    const guards = (name: string) =>
      (Reflect.getMetadata('__guards__', proto[name] as object) ?? []) as unknown[];
    for (const name of ['suspend', 'suspendOrg', 'remove', 'transfer']) {
      expect(guards(name)).toContain(TwoPersonApprovalGuard);
    }
    expect(guards('reactivate')).not.toContain(TwoPersonApprovalGuard);
  });

  it('changes the policy only with a boolean and a reason', async () => {
    const h = harness();
    const service = new PlatformGovernanceService(h.store, null);
    expect(
      await code(service.setPolicy(actor('a'), { enabled: 'yes', reason: 'Four eyes' }, ctx)),
    ).toBe('400');
    expect(
      await service.setPolicy(actor('a'), { enabled: true, reason: 'Four eyes rule' }, ctx),
    ).toEqual({ enabled: true });
    expect(h.audits[0]?.action).toBe('platform.two_person_policy_changed');
  });
});

describe('56-21 owner notices', () => {
  it('mails the owner at send time and stores the notice without the address', async () => {
    const h = harness();
    const service = new PlatformGovernanceService(h.store, h.mailer, () => NOW);
    const view = await service.sendNotice(
      actor('alice'),
      {
        organizationId: ORG,
        subject: 'Storage almost full',
        body: 'Please clean up.',
        severity: 'warning',
      },
      ctx,
    );
    expect(view.delivery).toBe('sent');
    expect(h.sent[0]).toMatchObject({ to: 'mona@acme.test', templateKey: 'platform_owner_notice' });
    expect(JSON.stringify(h.notices)).not.toContain('mona@acme.test');
    expect(h.audits[0]?.action).toBe('platform.owner_notice_sent');
  });

  it('refuses a company without an owner, a header-breaking subject and an unknown level', async () => {
    const service = new PlatformGovernanceService(harness({ owner: false }).store, null);
    expect(
      await code(
        service.sendNotice(actor('a'), { organizationId: ORG, subject: 'Hi', body: 'x' }, ctx),
      ),
    ).toBe('409');
    const ok = new PlatformGovernanceService(harness().store, null);
    expect(
      await code(
        ok.sendNotice(actor('a'), { organizationId: ORG, subject: 'Hi\r\nBcc: x', body: 'x' }, ctx),
      ),
    ).toBe('400');
    expect(
      await code(
        ok.sendNotice(
          actor('a'),
          { organizationId: ORG, subject: 'Hi', body: 'x', severity: 'loud' },
          ctx,
        ),
      ),
    ).toBe('400');
  });

  it('records a failed delivery instead of losing the notice', async () => {
    const h = harness();
    const failing: Mailer = { send: () => Promise.reject(new Error('smtp down')) };
    const view = await new PlatformGovernanceService(h.store, failing).sendNotice(
      actor('a'),
      { organizationId: ORG, subject: 'Hi', body: 'x' },
      ctx,
    );
    expect(view.delivery).toBe('failed');
    expect(h.notices[0]?.delivery).toBe('failed');
  });
});

describe('56-21 quarterly access review', () => {
  const team = {
    listTeam: () =>
      Promise.resolve([
        {
          id: 'adm-1',
          userId: 'u-1',
          email: 'sara@tmanage.test',
          displayName: 'Sara',
          preset: 'support',
          permissions: ['platform.orgs.view'],
          status: 'active',
          createdAt: new Date('2026-01-01'),
          disabledAt: null,
        },
      ]),
    findUsersByEmails: () => Promise.resolve([]),
  } as never;
  const audits: PlatformAuditInput[] = [];
  const store: AccessReviewStore = {
    monthActivity: () => Promise.resolve([]),
    monthSupport: () => Promise.resolve([]),
    users: () =>
      Promise.resolve([
        { userId: 'u-1', email: 'sara@tmanage.test', displayName: 'Sara', twoStep: false },
      ]),
    recordReview: (audit) => (audits.push(audit), Promise.resolve()),
    confirmations: (period) => Promise.resolve(period === '2026-Q3' ? ['u-1'] : []),
  };
  const service = new AccessReviewService(team, store, [], () => NOW);

  it('parses a started quarter and refuses a future one', () => {
    expect(parseQuarter('2026-Q4', NOW).from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(() => parseQuarter('2027-Q1', NOW)).toThrow(ApiError);
    expect(() => parseQuarter('2026-Q5', NOW)).toThrow(ApiError);
  });

  it('lists staff with their rights and confirmed state for the quarter', async () => {
    const view = await service.review(actor('boss'), { quarter: '2026-Q3' }, ctx);
    expect(view.month).toBe('2026-Q3');
    expect(view.admins[0]).toMatchObject({
      adminId: 'adm-1',
      permissions: ['platform.orgs.view'],
      confirmed: true,
      twoStep: false,
    });
  });

  it('confirms one person with an evidence row, and 404s someone not on the list', async () => {
    expect(await service.confirm(actor('boss'), { period: '2026-Q4', userId: 'u-1' }, ctx)).toEqual(
      { period: '2026-Q4', userId: 'u-1', confirmed: true },
    );
    expect(audits.at(-1)).toMatchObject({
      action: 'platform.access_review_confirmed',
      targetId: 'u-1',
      targetLabel: '2026-Q4',
    });
    expect(
      await code(service.confirm(actor('boss'), { period: '2026-Q4', userId: 'nobody' }, ctx)),
    ).toBe('404');
  });
});
