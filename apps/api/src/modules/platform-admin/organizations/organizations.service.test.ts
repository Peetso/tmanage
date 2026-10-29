import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/http/errors.js';
import { ORG_SQL } from './organizations.repository.js';
import {
  decodeCursor,
  encodeCursor,
  healthOf,
  limitsFor,
  toSummary,
} from './organizations.service.js';
import { PlatformOrganizationProvisioning } from './provisioning.js';
import { actor, CONTEXT, fakeOrgs, NOW, ORG, orgRow, serviceWith } from './test-fakes.js';

describe('platform organizations · list and filters', () => {
  it('passes each filter to the statement and pages with a cursor', async () => {
    const fake = fakeOrgs();
    const service = serviceWith(fake);
    const view = await service.list(
      { q: ' north ', status: 'suspended', plan: 'studio', createdFrom: '2026-01-01' },
      CONTEXT,
    );
    const filters = (fake.raw.list.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(filters).toMatchObject({ q: 'north', status: 'suspended', plan: 'studio' });
    expect(filters['createdFrom']).toEqual(new Date('2026-01-01'));
    expect(view.organizations).toHaveLength(1);
    expect(view.nextCursor).toBeNull();
    expect(view.counts.all).toBe(1);
  });

  it('treats all/any as no filter and refuses an unknown status, plan or health', async () => {
    const service = serviceWith(fakeOrgs());
    await service.list({ status: 'all', plan: 'any', health: 'any' }, CONTEXT);
    await expect(service.list({ status: 'gone' }, CONTEXT)).rejects.toMatchObject({ status: 400 });
    await expect(service.list({ plan: 'gold' }, CONTEXT)).rejects.toMatchObject({ status: 400 });
    await expect(service.list({ health: 'meh' }, CONTEXT)).rejects.toMatchObject({ status: 400 });
  });

  it('filters by computed health', async () => {
    const fake = fakeOrgs(orgRow({ failedRuns: 2 }));
    const service = serviceWith(fake);
    expect((await service.list({ health: 'failing' }, CONTEXT)).organizations).toHaveLength(1);
    expect((await service.list({ health: 'good' }, CONTEXT)).organizations).toHaveLength(0);
  });

  it('round-trips the cursor and refuses a forged one', () => {
    const cursor = encodeCursor(orgRow());
    expect(decodeCursor(cursor)).toEqual({ createdAt: orgRow().createdAt, id: ORG });
    expect(() => decodeCursor('bm9wZQ')).toThrow(ApiError);
  });

  it('builds the list statement with status chips that exclude each other', () => {
    expect(ORG_SQL.statusCounts).toContain('o.deleted_at is not null');
    expect(ORG_SQL.list({ ...base(), status: 'archived' }).sql).toContain(
      'o.archived_at is not null',
    );
  });
});

function base() {
  return {
    q: null,
    status: null,
    plan: null,
    createdFrom: null,
    createdTo: null,
    activeFrom: null,
    activeTo: null,
    cursor: null,
    limit: 50,
  };
}

describe('platform organizations · limits and billing mode', () => {
  it('an override wins over the plan, field by field; blank keeps the plan default', () => {
    const limits = limitsFor(orgRow({ planId: 'free', peopleLimit: 25, storageBytesLimit: null }));
    expect(limits.people).toBe(25);
    expect(limits.storageBytes).toBe(limits.plan.storageBytes);
  });

  it('is "check" over the people limit and "failing" with failed runs', () => {
    expect(healthOf(orgRow({ planId: 'free', people: 26, peopleLimit: 25 }))).toBe('check');
    expect(healthOf(orgRow({ failedRuns: 1 }))).toBe('failing');
    expect(toSummary(orgRow()).health).toBe('good');
  });

  it('saves limits with an upsert and reports override and usage', async () => {
    const fake = fakeOrgs();
    const service = serviceWith(fake);
    await service.setLimits(
      actor(),
      ORG,
      { people: 30, activeProjects: '', storageBytes: null },
      CONTEXT,
    );
    const upsert = fake.statements.find((s) => s.sql === ORG_SQL.upsertLimits);
    expect(upsert?.params.slice(1, 5)).toEqual([ORG, 30, null, null]);
    expect(fake.audits[0]?.action).toBe('platform.organization_limits_changed');
    await expect(service.setLimits(actor(), ORG, { people: -1 }, CONTEXT)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('plan and billing-mode changes need a reason and store the override (inherit = null)', async () => {
    const fake = fakeOrgs();
    const service = serviceWith(fake);
    await expect(
      service.setPlan(actor(), ORG, { billingModeOverride: 'paid' }, CONTEXT),
    ).rejects.toMatchObject({
      status: 400,
    });
    await service.setPlan(
      actor(),
      ORG,
      { planId: 'business', billingModeOverride: 'paid', reason: 'customer upgrade' },
      CONTEXT,
    );
    expect(fake.statements.find((s) => s.sql === ORG_SQL.updateBillingOverride)?.params).toEqual([
      'paid',
      ORG,
    ]);
    expect(fake.statements.find((s) => s.sql === ORG_SQL.updatePlan)?.params).toEqual([
      'business',
      ORG,
    ]);
    await service.setPlan(
      actor(),
      ORG,
      { billingModeOverride: 'inherit', reason: 'back to platform' },
      CONTEXT,
    );
    expect(
      fake.statements.filter((s) => s.sql === ORG_SQL.updateBillingOverride).at(-1)?.params,
    ).toEqual([null, ORG]);
  });

  it('reads the platform billing mode from the setting, the override on top', async () => {
    const fake = fakeOrgs(orgRow({ billingModeOverride: 'paid' }));
    fake.settings.set('billing_mode', 'beta_free');
    const view = await serviceWith(fake).plan(ORG, CONTEXT);
    expect(view).toMatchObject({
      platformMode: 'beta_free',
      override: 'paid',
      effectiveMode: 'paid',
    });
  });
});

describe('platform organizations · profile', () => {
  it('refuses a slug another organization holds with 409', async () => {
    const fake = fakeOrgs();
    fake.raw.slugOwner.mockResolvedValueOnce('0199aa00-0000-7000-8000-0000000000b2');
    await expect(
      serviceWith(fake).updateProfile(actor(), ORG, { slug: 'brightops-consulting' }, CONTEXT),
    ).rejects.toMatchObject({ status: 409 });
    expect(fake.audits).toHaveLength(0);
  });

  it('maps a duplicate-key race to the same 409', async () => {
    const fake = fakeOrgs();
    fake.raw.write.mockRejectedValueOnce(
      Object.assign(new Error("Duplicate entry 'x' for key 'uq_organizations_slug'"), {
        code: 'ER_DUP_ENTRY',
      }),
    );
    await expect(
      serviceWith(fake).updateProfile(actor(), ORG, { slug: 'new-slug' }, CONTEXT),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it('saves name, slug and notes with an optional reason', async () => {
    const fake = fakeOrgs();
    await serviceWith(fake).updateProfile(
      actor(),
      ORG,
      { name: 'Northstar', slug: 'northstar', operatorNotes: 'VIP' },
      CONTEXT,
    );
    const update = fake.statements.find((s) => s.sql === ORG_SQL.updateProfile);
    expect(update?.params).toEqual(['Northstar', 'northstar', 'en', 'UTC', 'VIP', ORG]);
    expect(fake.audits[0]).toMatchObject({
      action: 'platform.organization_updated',
      reason: null,
      organizationId: ORG,
    });
  });
});

describe('platform organizations · provisioning', () => {
  it('provisions for an existing account as owner and sets the plan', async () => {
    const fake = fakeOrgs();
    fake.raw.findUserByEmail.mockResolvedValueOnce({
      id: 'u-1',
      email: 'owner@x.test',
      displayName: 'Owner',
    });
    const provisioning = { provisionOrganization: vi.fn(async () => ({ organizationId: ORG })) };
    const create = new PlatformOrganizationProvisioning(
      serviceWith(fake),
      fake.repo,
      provisioning as never,
    );
    await create.create(
      actor(),
      { name: 'Harborline', slug: 'harborline', ownerEmail: 'Owner@x.test', plan: 'starter' },
      CONTEXT,
    );
    expect(provisioning.provisionOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1', slug: 'harborline', name: 'Harborline' }),
    );
    expect(fake.statements.find((s) => s.sql === ORG_SQL.updatePlan)?.params).toEqual([
      'starter',
      ORG,
    ]);
    expect(fake.audits[0]?.action).toBe('platform.organization_created');
  });

  it('refuses a taken slug (409) and an unknown owner (404) before creating anything', async () => {
    const fake = fakeOrgs();
    const provisioning = { provisionOrganization: vi.fn() };
    const create = new PlatformOrganizationProvisioning(
      serviceWith(fake),
      fake.repo,
      provisioning as never,
    );
    fake.raw.slugOwner.mockResolvedValueOnce(ORG);
    await expect(
      create.create(
        actor(),
        { name: 'B', slug: 'brightops-consulting', ownerEmail: 'a@b.co' },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      create.create(actor(), { name: 'B', slug: 'fresh', ownerEmail: 'a@b.co' }, CONTEXT),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(provisioning.provisionOrganization).not.toHaveBeenCalled();
  });
});

describe('platform organizations · overview', () => {
  it('adds the deleted window, support sessions and the attention list to the base tiles', async () => {
    const fake = fakeOrgs(orgRow({ failedRuns: 3 }));
    const view = await serviceWith(fake).overview(CONTEXT);
    expect(view.computedAt).toBe(NOW.toISOString());
    expect(view.attention[0]).toMatchObject({ kind: 'failing', level: 'action' });
    expect(view.openSupportSessions).toBe(0);
  });
});
