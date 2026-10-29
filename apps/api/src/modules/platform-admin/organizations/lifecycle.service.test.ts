import { describe, expect, it, vi } from 'vitest';
import type { MembershipsRepository } from '../../tenancy/memberships.repository.js';
import { PlatformOrganizationLifecycleService } from './lifecycle.service.js';
import { ORG_SQL } from './organizations.repository.js';
import { actor, ADMIN, CONTEXT, fakeOrgs, ORG, orgRow, serviceWith } from './test-fakes.js';

const NEW_OWNER = '0199aa00-0000-7000-8000-0000000000d1';
const OLD_OWNER = '0199aa00-0000-7000-8000-0000000000d2';

function setup(row = orgRow()) {
  const fake = fakeOrgs(row);
  const memberships = {
    findById: vi.fn(async () => ({
      id: NEW_OWNER,
      userId: 'u-sara',
      role: 'manager',
      status: 'active',
      version: 3,
    })),
    changeRole: vi.fn(async () => ({})),
  };
  const audit = { record: vi.fn(async () => ({})) };
  fake.raw.members.mockResolvedValue({
    internal: [
      { id: OLD_OWNER, userId: 'u-maya', role: 'owner', status: 'active', version: 7 } as never,
      { id: NEW_OWNER, userId: 'u-sara', role: 'manager', status: 'active', version: 3 } as never,
    ],
    clients: [],
    invitations: [],
  });
  const lifecycle = new PlatformOrganizationLifecycleService(
    serviceWith(fake),
    fake.repo,
    memberships as unknown as MembershipsRepository,
    audit as never,
  );
  return { fake, memberships, audit, lifecycle };
}

const REASON = 'customer asked in ticket 42';

describe('platform organization lifecycle', () => {
  it('refuses a typed-slug mismatch with 400 and writes nothing', async () => {
    const { fake, lifecycle } = setup();
    await expect(
      lifecycle.remove(actor(), ORG, { confirmSlug: 'Northstar-Studio', reason: REASON }, CONTEXT),
    ).rejects.toMatchObject({ status: 400 });
    expect(fake.statements).toHaveLength(0);
  });

  it('removal takes purge_after from the retention setting', async () => {
    const { fake, lifecycle } = setup();
    fake.settings.set('retention.org_purge_days', '14');
    await lifecycle.remove(
      actor(),
      ORG,
      { confirmSlug: 'northstar-studio', reason: REASON },
      CONTEXT,
    );
    const statement = fake.statements.find((s) => s.sql === ORG_SQL.softDelete);
    expect(statement?.params).toEqual([14, ADMIN, ORG]);
    expect(fake.audits[0]).toMatchObject({
      action: 'platform.organization_deleted',
      reason: REASON,
    });
  });

  it('delete falls back to 30 days and needs a reason', async () => {
    const { fake, lifecycle } = setup();
    await expect(
      lifecycle.remove(actor(), ORG, { confirmSlug: 'northstar-studio' }, CONTEXT),
    ).rejects.toMatchObject({
      status: 400,
    });
    fake.settings.set('retention.org_purge_days', 'junk');
    await lifecycle.remove(
      actor(),
      ORG,
      { confirmSlug: 'northstar-studio', reason: REASON },
      CONTEXT,
    );
    expect(fake.statements.find((s) => s.sql === ORG_SQL.softDelete)?.params[0]).toBe(30);
  });

  it('restore clears the deletion of a deleted organization only', async () => {
    const { fake, lifecycle } = setup();
    await expect(
      lifecycle.restore(actor(), ORG, { reason: REASON }, CONTEXT),
    ).rejects.toMatchObject({ status: 409 });
    fake.setRow(orgRow({ deletedAt: new Date(), purgeAfter: new Date() }));
    await lifecycle.restore(actor(), ORG, { reason: REASON }, CONTEXT);
    expect(fake.statements.map((s) => s.sql)).toContain(ORG_SQL.restore);
  });

  it('purge is super-admin only and brings purge_after forward', async () => {
    const { fake, lifecycle } = setup(orgRow({ deletedAt: new Date(), purgeAfter: new Date() }));
    await expect(
      lifecycle.purge(
        actor('support'),
        ORG,
        { confirmSlug: 'northstar-studio', reason: REASON },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await lifecycle.purge(
      actor('super_admin'),
      ORG,
      { confirmSlug: 'northstar-studio', reason: REASON },
      CONTEXT,
    );
    expect(fake.statements.map((s) => s.sql)).toContain(ORG_SQL.purgeNow);
    expect(fake.audits[0]?.action).toBe('platform.organization_purge_requested');
  });

  it('transfer makes the new owner owner and the old owner org admin', async () => {
    const { memberships, audit, fake, lifecycle } = setup();
    await lifecycle.transfer(
      actor(),
      ORG,
      { newOwnerMembershipId: NEW_OWNER, confirmSlug: 'northstar-studio', reason: REASON },
      CONTEXT,
    );
    expect(memberships.changeRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      NEW_OWNER,
      3,
      'owner',
    );
    expect(memberships.changeRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      OLD_OWNER,
      7,
      'org_admin',
    );
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(fake.audits[0]?.action).toBe('platform.organization_ownership_transferred');
  });

  it('archive and unarchive flip archived_at; a deleted organization is refused', async () => {
    const { fake, lifecycle } = setup();
    await lifecycle.archive(actor(), ORG, true, { reason: REASON }, CONTEXT);
    expect(fake.statements.at(-1)?.sql).toBe(ORG_SQL.archive);
    await expect(
      lifecycle.archive(actor(), ORG, false, { reason: REASON }, CONTEXT),
    ).rejects.toMatchObject({
      status: 409,
    });
    fake.setRow(orgRow({ deletedAt: new Date() }));
    await expect(
      lifecycle.archive(actor(), ORG, true, { reason: REASON }, CONTEXT),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it('policy refresh bumps policy_version', async () => {
    const { fake, lifecycle } = setup();
    await lifecycle.policyRefresh(actor(), ORG, { reason: REASON }, CONTEXT);
    expect(fake.statements.at(-1)?.sql).toBe(ORG_SQL.policyRefresh);
  });
});
