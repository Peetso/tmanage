import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ReferralsController } from './referrals.controller.js';
import type { NewReferralSignup, ReferralsRepository } from './referrals.repository.js';
import {
  REFERRAL_COUNTED_PER_DAY,
  classifyReferral,
  mailboxOf,
  newPartnerCode,
  newWorkspaceCode,
  parseReferralCode,
} from './referrals.rules.js';
import { ReferralsService } from './referrals.service.js';

const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000b2';
const NEW_ORG = '00000000-0000-4000-8000-0000000000c3';
const NOW = new Date('2026-11-18T12:00:00.000Z');

function contextFor(organizationId: string): TenantContext {
  return { organizationId, membershipId: 'm1', userId: 'u1', correlationId: 'c1' } as TenantContext;
}

function principal(role: string, kind: 'internal' | 'client' = 'internal'): Principal {
  return {
    userId: 'u1',
    organizationId: ORG_A,
    kind,
    role,
    membershipId: 'm1',
    membershipStatus: 'active',
    clientOrganizationId: kind === 'client' ? 'c1' : null,
    projectIds: [],
    hasOrgWideScope: kind === 'internal',
  } as Principal;
}

/** In-memory tables, every tenant read keyed by the context's organization (as the SQL is). */
class FakeRepository {
  readonly codes = new Map<string, { id: string; code: string }>([
    [ORG_A, { id: 'code-a', code: 'northstar-7q4k2m' }],
    [ORG_B, { id: 'code-b', code: 'bluedune-9x8w7v' }],
  ]);
  readonly team = new Map<string, { userIds: string[]; emails: string[] }>([
    [ORG_A, { userIds: ['ua'], emails: ['maya@northstar.studio'] }],
    [ORG_B, { userIds: ['ub'], emails: ['omar@gmail.com'] }],
  ]);
  readonly signups: (NewReferralSignup & { organizationId: string })[] = [];

  readSlug = () => Promise.resolve('cedar');
  readCode = (_r: unknown, context: TenantContext) =>
    Promise.resolve(this.codes.get(context.organizationId) ?? null);
  insertCode = (_r: unknown, context: TenantContext, code: string) => {
    this.codes.set(context.organizationId, { id: `code-${code}`, code });
    return Promise.resolve();
  };
  listCounted = (_r: unknown, context: TenantContext) => {
    const own = this.signups.filter(
      (row) => row.organizationId === context.organizationId && row.outcome === 'counted',
    );
    return Promise.resolve({
      total: own.length,
      agencies: own.map((row) => ({ name: row.referredName, signedUpAt: row.signedUpAt })),
    });
  };
  countRecordedRewards = (_r: unknown, context: TenantContext) =>
    Promise.resolve(
      this.signups.filter(
        (row) => row.organizationId === context.organizationId && row.outcome === 'counted',
      ).length,
    );
  countCountedSince = (_r: unknown, context: TenantContext) =>
    Promise.resolve(
      this.signups.filter(
        (row) => row.organizationId === context.organizationId && row.outcome === 'counted',
      ).length,
    );
  insertSignup = (_r: unknown, context: TenantContext, signup: NewReferralSignup) => {
    this.signups.push({ ...signup, organizationId: context.organizationId });
    return Promise.resolve();
  };
  resolveWorkspaceCode = (_r: unknown, code: string) => {
    for (const [organizationId, row] of this.codes) {
      if (row.code === code) {
        return Promise.resolve({
          organizationId,
          codeId: row.id,
          teamUserIds: this.team.get(organizationId)?.userIds ?? [],
        });
      }
    }
    return Promise.resolve(null);
  };
  emailsOf = (_r: unknown, userIds: readonly string[]) =>
    Promise.resolve(
      [...this.team.values()]
        .filter((team) => team.userIds.some((id) => userIds.includes(id)))
        .flatMap((team) => team.emails),
    );
}

function fakeDatabase(): TenantDatabase {
  const run = async (_o: unknown, work: (db: unknown) => Promise<unknown>) => work({});
  return {
    read: run,
    transaction: run,
    bootstrapRead: run,
    identityRead: run,
    identityTransaction: run,
  } as unknown as TenantDatabase;
}

function serviceWith(repo: FakeRepository, mode: 'beta_free' | 'paid' = 'beta_free') {
  return new ReferralsService(
    fakeDatabase(),
    repo as unknown as ReferralsRepository,
    () => NOW,
    () => mode,
  );
}

function signup(code: string, email: string, organizationId = NEW_ORG) {
  return {
    code,
    organizationId,
    organizationName: 'Cedar Agency',
    email,
    correlationId: '00000000-0000-4000-8000-0000000000d4',
  };
}

describe('REFERRAL rules', () => {
  it('reads one mailbox whatever its spelling', () => {
    expect(mailboxOf('Maya+test@Northstar.Studio')).toBe('maya@northstar.studio');
    expect(mailboxOf('o.m.a.r@googlemail.com')).toBe('omar@gmail.com');
  });

  it('refuses self-referral, same company domain, and over the daily limit; counts the rest', () => {
    const team = ['maya@northstar.studio', 'omar@gmail.com'];
    expect(
      classifyReferral({
        newEmail: 'maya+2@northstar.studio',
        teamEmails: team,
        countedLastDay: 0,
      }),
    ).toBe('self');
    expect(
      classifyReferral({ newEmail: 'om.ar@gmail.com', teamEmails: team, countedLastDay: 0 }),
    ).toBe('self');
    expect(
      classifyReferral({ newEmail: 'sam@northstar.studio', teamEmails: team, countedLastDay: 0 }),
    ).toBe('same_domain');
    // A shared mail provider is not a company: a different gmail address is counted.
    expect(
      classifyReferral({ newEmail: 'lina@gmail.com', teamEmails: team, countedLastDay: 0 }),
    ).toBe('counted');
    expect(
      classifyReferral({
        newEmail: 'lina@cedar.agency',
        teamEmails: team,
        countedLastDay: REFERRAL_COUNTED_PER_DAY,
      }),
    ).toBe('rate_limited');
    expect(
      classifyReferral({ newEmail: 'lina@cedar.agency', teamEmails: team, countedLastDay: 0 }),
    ).toBe('counted');
  });

  it('accepts only code-shaped values, and its own codes parse back', () => {
    const fixed = (size: number) => Buffer.alloc(size, 7);
    const workspace = newWorkspaceCode('Northstar', fixed);
    const partner = newPartnerCode('Cedar Agency', fixed);
    expect(parseReferralCode(workspace)).toBe(workspace);
    expect(parseReferralCode(partner)).toBe(partner);
    expect(partner.startsWith('p.')).toBe(true);
    for (const bad of [42, '', 'x', '../etc', 'a b-abcdef', `${'a'.repeat(40)}-abcdef`, null]) {
      expect(parseReferralCode(bad)).toBeNull();
    }
  });
});

describe('REFERRAL owner gate', () => {
  const controller = new ReferralsController(fakeDatabase(), serviceWith(new FakeRepository()));

  it('answers the workspace owner', async () => {
    const view = await controller.read(contextFor(ORG_A), principal('owner'));
    expect(view.code).toBe('northstar-7q4k2m');
  });

  it.each([
    ['org_admin', 'internal'],
    ['workspace_admin', 'internal'],
    ['member', 'internal'],
    ['platform_support', 'internal'],
    ['client_admin', 'client'],
  ] as const)('refuses %s (403 referral:owner) on read and on create', async (role, kind) => {
    for (const call of [
      () => controller.read(contextFor(ORG_A), principal(role, kind)),
      () => controller.createCode(contextFor(ORG_A), principal(role, kind)),
    ]) {
      const error = (await call().catch((caught: unknown) => caught)) as ApiError;
      expect(error.status).toBe(403);
    }
  });
});

describe('REFERRAL recording and isolation', () => {
  it('records a sign-up against the code owner, and only that workspace sees it', async () => {
    const repo = new FakeRepository();
    const service = serviceWith(repo);
    expect(await service.recordSignup(signup('bluedune-9x8w7v', 'lina@cedar.agency'))).toBe(
      'counted',
    );

    const b = await service.view(contextFor(ORG_B));
    expect(b.signedUp).toBe(1);
    expect(b.agencies).toEqual([{ name: 'Cedar Agency', signedUpAt: NOW.toISOString() }]);
    // Name and date only: no address reaches the inviting owner.
    expect(JSON.stringify(b)).not.toContain('@');

    const a = await service.view(contextFor(ORG_A));
    expect(a.signedUp).toBe(0);
    expect(a.agencies).toEqual([]);
  });

  it('refuses self-referral: recorded as self, never counted or listed', async () => {
    const repo = new FakeRepository();
    const service = serviceWith(repo);
    expect(
      await service.recordSignup(signup('northstar-7q4k2m', 'Maya+new@northstar.studio')),
    ).toBe('self');
    expect(repo.signups[0]?.outcome).toBe('self');
    expect((await service.view(contextFor(ORG_A))).signedUp).toBe(0);
  });

  it('ignores an unknown or malformed code, and a workspace naming its own code', async () => {
    const repo = new FakeRepository();
    const service = serviceWith(repo);
    expect(await service.recordSignup(signup('nobody-abcdef', 'x@y.co'))).toBeNull();
    expect(await service.recordSignup(signup('<script>', 'x@y.co'))).toBeNull();
    expect(await service.recordSignup(signup('northstar-7q4k2m', 'x@y.co', ORG_A))).toBeNull();
    expect(repo.signups).toEqual([]);
  });
});

describe('REFERRAL link creation', () => {
  it('creates one code for a workspace without one, and returns the same one after', async () => {
    const repo = new FakeRepository();
    const service = serviceWith(repo);
    const first = await service.ensureCode(contextFor(NEW_ORG));
    expect(parseReferralCode(first.code)).toBe(first.code);
    expect(first.code?.startsWith('cedar-')).toBe(true);
    expect((await service.ensureCode(contextFor(NEW_ORG))).code).toBe(first.code);
    expect((await service.ensureCode(contextFor(ORG_A))).code).toBe('northstar-7q4k2m');
  });
});

describe('REFERRAL reward', () => {
  it('is hidden while beta_free and shown as a recorded count when paid', async () => {
    const repo = new FakeRepository();
    await serviceWith(repo).recordSignup(signup('northstar-7q4k2m', 'lina@cedar.agency'));
    expect((await serviceWith(repo, 'beta_free').view(contextFor(ORG_A))).rewards).toBeNull();
    expect((await serviceWith(repo, 'paid').view(contextFor(ORG_A))).rewards).toEqual({
      recorded: 1,
    });
  });
});
