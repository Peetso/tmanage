import { describe, expect, it, vi } from 'vitest';
import type { InvitationsRepository } from '../../tenancy/invitations.repository.js';
import type { MembershipsRepository } from '../../tenancy/memberships.repository.js';
import type { OffboardingService } from '../../tenancy/offboarding.service.js';
import { PlatformOrganizationMembersController } from './members.controller.js';
import { platformGrantPrincipal, PlatformOrganizationMembersService } from './members.service.js';
import { ORG_SQL } from './organizations.repository.js';
import { actor, ADMIN, CONTEXT, fakeOrgs, ORG, serviceWith } from './test-fakes.js';

const MEMBER = '0199aa00-0000-7000-8000-0000000000e1';
const OWNER = '0199aa00-0000-7000-8000-0000000000e2';
const REQUEST = { headers: {}, ip: '127.0.0.1', correlationId: 'corr-1' };

function setup(targetRole = 'designer') {
  const fake = fakeOrgs();
  const internal = [
    {
      id: OWNER,
      userId: 'u-owner',
      role: 'owner',
      status: 'active',
      version: 1,
      email: 'o@x',
      displayName: 'O',
      lastSignInAt: null,
      mfaEnabled: false,
      overrides: 0,
    },
    {
      id: MEMBER,
      userId: 'u-member',
      role: targetRole,
      status: 'active',
      version: 2,
      email: 'm@x',
      displayName: 'M',
      lastSignInAt: null,
      mfaEnabled: true,
      overrides: 1,
    },
  ];
  fake.raw.members.mockResolvedValue({ internal, clients: [], invitations: [] } as never);
  const memberships = {
    findById: vi.fn(
      async (_tx: unknown, _ctx: unknown, id: string) => internal.find((m) => m.id === id) ?? null,
    ),
    findByUserId: vi.fn(async () => null),
    changeRole: vi.fn(async () => ({})),
    countActiveHoldersOfRoles: vi.fn(async () => 0),
  };
  const offboarding = { offboard: vi.fn(async () => ({})) };
  const audit = { record: vi.fn(async () => ({})) };
  const service = new PlatformOrganizationMembersService(
    serviceWith(fake),
    fake.repo,
    memberships as unknown as MembershipsRepository,
    {} as InvitationsRepository,
    offboarding as unknown as OffboardingService,
    audit as never,
  );
  const controller = new PlatformOrganizationMembersController(service);
  return { fake, memberships, offboarding, audit, controller };
}

describe('platform members controller', () => {
  it('changes a role with the Support-session ceiling, recording both audits', async () => {
    const { memberships, audit, fake, controller } = setup();
    await controller.changeRole(actor(), ORG, MEMBER, { role: 'manager' }, REQUEST);
    expect(memberships.changeRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      MEMBER,
      2,
      'manager',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'membership.role_changed', effectiveActorId: ADMIN }),
    );
    expect(fake.audits[0]?.action).toBe('platform.member_role_changed');
  });

  it('may make someone an owner (platform_support grants owner) but never the support role', async () => {
    const { memberships, controller } = setup();
    expect(platformGrantPrincipal(ORG).role).toBe('platform_support');
    await controller.changeRole(actor(), ORG, MEMBER, { role: 'owner' }, REQUEST);
    expect(memberships.changeRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      MEMBER,
      2,
      'owner',
    );
    await expect(
      controller.changeRole(actor(), ORG, MEMBER, { role: 'platform_support' }, REQUEST),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('never demotes the only owner', async () => {
    const { controller } = setup();
    await expect(
      controller.changeRole(actor(), ORG, OWNER, { role: 'member' }, REQUEST),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it('adds an existing account and refuses an unknown address', async () => {
    const { fake, controller } = setup();
    await expect(
      controller.add(actor(), ORG, { email: 'nobody@x.test' }, REQUEST),
    ).rejects.toMatchObject({ status: 404 });
    fake.raw.findUserByEmail.mockResolvedValueOnce({
      id: 'u-new',
      email: 'new@x.test',
      displayName: 'New',
    });
    await controller
      .add(actor(), ORG, { email: 'new@x.test', role: 'member' }, REQUEST)
      .catch(() => undefined);
    const insert = fake.statements.find((s) => s.sql === ORG_SQL.insertMembership);
    expect(insert?.params.slice(1, 4)).toEqual([ORG, 'u-new', 'member']);
    expect(fake.audits.at(-1)?.action).toBe('platform.member_added');
  });

  it('offboarding needs a reason and runs as the operator', async () => {
    const { offboarding, fake, controller } = setup();
    await expect(controller.offboard(actor(), ORG, MEMBER, {}, REQUEST)).rejects.toMatchObject({
      status: 400,
    });
    expect(offboarding.offboard).not.toHaveBeenCalled();
    await controller.offboard(actor(), ORG, MEMBER, { reason: 'left the company' }, REQUEST);
    expect(offboarding.offboard).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, userId: ADMIN }),
      expect.objectContaining({ role: 'platform_support' }),
      'u-member',
    );
    expect(fake.audits.at(-1)).toMatchObject({
      action: 'platform.member_offboarded',
      reason: 'left the company',
    });
  });

  it('refuses to offboard an owner', async () => {
    const { controller } = setup();
    await expect(
      controller.offboard(actor(), ORG, OWNER, { reason: 'left the company' }, REQUEST),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it('reads the context from the request', async () => {
    const { controller } = setup();
    void CONTEXT;
    await expect(controller.list(ORG, REQUEST)).resolves.toMatchObject({
      internal: expect.any(Array),
    });
  });
});
