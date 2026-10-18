import { describe, expect, it, vi } from 'vitest';
import type { PlatformAdminActor } from './platform-admin.guard.js';
import type { PlatformAdminRepository, PlatformAuditInput } from './platform-admin.repository.js';
import { PlatformAdminService } from './platform-admin.service.js';

/** Every platform action carries a typed reason into the platform audit log; none runs without. */

const ORG = '0199aa00-0000-7000-8000-0000000000c1';
const PERSON = '0199aa00-0000-7000-8000-0000000000d1';
const ctx = { correlationId: 'c', ip: null, userAgent: null };
const account = {
  userId: 'u',
  email: 'peter@example.com',
  displayName: 'P',
  emailVerified: true,
  mfaEnabled: true,
};
const actor: PlatformAdminActor = { account, sessionId: 's', stepUp: null };
const company = {
  id: ORG,
  slug: 'n',
  name: 'Northstar',
  ownerEmail: null,
  people: 1,
  clients: 0,
  projects: 0,
  planId: null,
  createdAt: new Date(),
  lastActiveAt: null,
  suspendedAt: null,
  archivedAt: null,
};

function harness() {
  const audits: PlatformAuditInput[] = [];
  const keep = (audit: PlatformAuditInput) => void audits.push(audit);
  const repository = {
    findCompany: vi.fn(async () => company),
    listCompanyAudit: async () => [
      {
        id: 'e',
        action: 'membership.revoked',
        objectType: 'm',
        result: 'succeeded',
        createdAt: new Date(),
      },
    ],
    setSuspended: vi.fn(async (_i: string, _s: boolean, a: PlatformAuditInput) => keep(a)),
    findPerson: async () => ({ ...account, userId: PERSON, email: 'sara@x.test' }),
    signOutEverywhere: vi.fn(async (_i: string, a: PlatformAuditInput) => (keep(a), 2)),
    recordAudit: vi.fn(async (a: PlatformAuditInput) => keep(a)),
    writeSetting: vi.fn(async (_k: string, _v: string, a: PlatformAuditInput) => keep(a)),
  } as unknown as PlatformAdminRepository;
  const resets = { request: vi.fn(async () => ({})) };
  const service = new PlatformAdminService(
    repository,
    { confirmReauthentication: async () => ({}) },
    resets,
    true,
  );
  return { service, repository, resets, audits };
}

const REASON = 'Customer asked us to pause the account';

describe('PlatformAdminService', () => {
  it('audits every action with who, what, the target and the typed reason', async () => {
    const { service, audits, resets } = harness();
    await service.setSuspended(actor, ORG, true, { reason: REASON }, ctx);
    await service.signOutEverywhere(actor, PERSON, { reason: REASON }, ctx);
    await service.sendPasswordReset(actor, PERSON, { reason: REASON }, ctx);
    await service.setPublicSignup(actor, { open: false, reason: REASON }, ctx);
    expect(audits.map((a) => [a.action, a.targetId, a.reason, a.actorEmail])).toEqual([
      ['platform.company_suspended', ORG, REASON, 'peter@example.com'],
      ['platform.user_signed_out', PERSON, REASON, 'peter@example.com'],
      ['platform.password_reset_sent', PERSON, REASON, 'peter@example.com'],
      ['platform.public_signup_closed', null, REASON, 'peter@example.com'],
    ]);
    expect(resets.request).toHaveBeenCalledWith('sara@x.test', ctx);
  });

  it('refuses every action without a reason and changes nothing', async () => {
    const { service, repository, resets } = harness();
    const tries = [
      () => service.setSuspended(actor, ORG, true, {}, ctx),
      () => service.signOutEverywhere(actor, PERSON, { reason: ' no ' }, ctx),
      () => service.sendPasswordReset(actor, PERSON, {}, ctx),
      () => service.setPublicSignup(actor, { open: true }, ctx),
    ];
    for (const run of tries) await expect(run()).rejects.toMatchObject({ status: 400 });
    expect(repository.setSuspended).not.toHaveBeenCalled();
    expect(repository.signOutEverywhere).not.toHaveBeenCalled();
    expect(repository.recordAudit).not.toHaveBeenCalled();
    expect(repository.writeSetting).not.toHaveBeenCalled();
    expect(resets.request).not.toHaveBeenCalled();
  });

  it('shows a company as metadata only: no event metadata, no content', async () => {
    const view = await harness().service.company(ORG, ctx);
    expect(Object.keys(view.recentAdminEvents[0] ?? {}).sort()).toEqual([
      'action',
      'id',
      'objectType',
      'occurredAt',
      'result',
    ]);
    expect(Object.keys(view.company)).not.toContain('metadata');
    await expect(harness().service.company('../x', ctx)).rejects.toMatchObject({ status: 404 });
  });
});
