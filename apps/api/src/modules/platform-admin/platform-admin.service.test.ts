import { describe, expect, it, vi } from 'vitest';
import type { PlatformAdminActor } from './platform-admin.guard.js';
import type { PlatformAdminRepository, PlatformAuditInput } from './platform-admin.repository.js';
import { PlatformAdminService } from './platform-admin.service.js';
import { PlatformOrganizationsService } from './organizations/organizations.service.js';
import { PlatformPeopleService } from './people/people.service.js';
import { PlatformSettingsService } from './settings/settings.service.js';

/** Every platform action carries a typed reason into the platform audit log; none runs without. */

const ORG = '0199aa00-0000-7000-8000-0000000000c1';
const PERSON = '0199aa00-0000-7000-8000-0000000000d1';
const ctx = { correlationId: 'c', ip: '203.0.113.9', userAgent: 'Firefox' };
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
    readSetting: vi.fn(async () => null),
    recordStepUp: vi.fn(async (input: { audit: PlatformAuditInput }) => {
      keep(input.audit);
      return new Date('2026-10-28T10:15:00Z');
    }),
    organizationSlugs: async () => new Map([[ORG, 'northstar']]),
    admins: {
      liveSupportSessions: async () => [
        { id: 'ss', organizationId: ORG, expiresAt: new Date('2026-10-28T12:00:00Z') },
      ],
    },
  } as unknown as PlatformAdminRepository;
  const resets = { request: vi.fn(async () => ({})) };
  const core = new PlatformAdminService(repository, { confirmReauthentication: async () => ({}) });
  const organizations = new PlatformOrganizationsService(repository);
  const people = new PlatformPeopleService(repository, resets);
  const settings = new PlatformSettingsService(repository, true);
  // The PA-02 split: the same calls, now on the area services.
  const service = {
    setSuspended: organizations.setSuspended.bind(organizations),
    company: organizations.company.bind(organizations),
    signOutEverywhere: people.signOutEverywhere.bind(people),
    sendPasswordReset: people.sendPasswordReset.bind(people),
    setPublicSignup: settings.setPublicSignup.bind(settings),
    setAiAccess: settings.setAiAccess.bind(settings),
  };
  return { service, core, repository, resets, audits };
}

const REASON = 'Customer asked us to pause the account';

describe('PlatformAdminService', () => {
  it('audits every action with who, what, the target and the typed reason', async () => {
    const { service, audits, resets } = harness();
    await service.setSuspended(actor, ORG, true, { reason: REASON }, ctx);
    await service.signOutEverywhere(actor, PERSON, { reason: REASON }, ctx);
    await service.sendPasswordReset(actor, PERSON, { reason: REASON }, ctx);
    await service.setPublicSignup(actor, { open: false, reason: REASON }, ctx);
    await service.setAiAccess(actor, { on: false, reason: REASON }, ctx);
    expect(audits.map((a) => [a.action, a.targetId, a.reason, a.actorEmail])).toEqual([
      ['platform.company_suspended', ORG, REASON, 'peter@example.com'],
      ['platform.user_signed_out', PERSON, REASON, 'peter@example.com'],
      ['platform.password_reset_sent', PERSON, REASON, 'peter@example.com'],
      ['platform.public_signup_closed', null, REASON, 'peter@example.com'],
      ['platform.ai_access_off', null, REASON, 'peter@example.com'],
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
      () => service.setAiAccess(actor, { on: false }, ctx),
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

  it('stamps the IP and device of the request on every platform audit row', async () => {
    const { service, audits } = harness();
    await service.setSuspended(actor, ORG, true, { reason: REASON }, ctx);
    expect(audits[0]).toMatchObject({
      ip: '203.0.113.9',
      userAgent: 'Firefox',
      organizationId: ORG,
    });
  });

  it('me carries the permissions, the preset and the live support sessions', async () => {
    const { core } = harness();
    const view = await core.me(
      { ...actor, source: 'db', preset: 'auditor', permissions: ['platform.orgs.view'] },
      ctx,
    );
    expect(view).toMatchObject({
      source: 'db',
      preset: 'auditor',
      permissions: ['platform.orgs.view'],
      supportSessions: [
        { id: 'ss', organizationId: ORG, slug: 'northstar', expiresAt: '2026-10-28T12:00:00.000Z' },
      ],
    });
  });

  it('step-up writes its own audit row with the origin', async () => {
    const { core, audits } = harness();
    await core.stepUp(actor, { password: 'pw', code: '123456' }, ctx);
    expect(audits[0]).toMatchObject({ action: 'platform.step_up', ip: '203.0.113.9' });
  });
});
