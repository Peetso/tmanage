import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import {
  AdminAnnouncementsController,
  MemberAnnouncementsController,
} from './announcements.controller.js';
import { OrgAnnouncementsService } from './announcements.service.js';
import type { OrgAnnouncementsRepository } from './announcements.repository.js';
import type { OrgAnnouncementRow } from '../../common/database/schema.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x276 — org-wide admin announcement banners. Database-free proofs over the module's fakes with the
 * **real** `authorize`. The security-load-bearing properties the controller/service own are provable
 * without a live database:
 *   - a POST by a principal without `org.manage` (a client — the capability is internal-only) is a 403
 *     with **no insert**;
 *   - a DELETE of another tenant's announcement id resolves to a 404 with **no delete** (the id is
 *     resolved tenant-scoped before authorize, the Known trap);
 *   - the active-now read drops announcements outside their `[startsAt, endsAt]` window;
 *   - the routes sit behind `org.manage` (write) and `work.read` (read), asserted through metadata.
 */

const ORG = 'organization-0000-0000-0000-000000000001';

const context = {
  organizationId: ORG,
  membershipId: 'membership-0000-0000-0000-000000000001',
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

/** An owner — the only internal role whose ceiling holds `org.manage`. */
function owner(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-0000-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

/** A client — `org.manage` is internal-only, so the org-level authorize refuses. */
function client(): Principal {
  return {
    ...owner(),
    userId: 'user-0000-0000-0000-0000-000000000003',
    kind: 'client',
    role: 'client_admin',
    clientOrganizationId: 'client-org-0000-0000-000000000001',
    hasOrgWideScope: false,
  };
}

function row(overrides: Partial<OrgAnnouncementRow>): OrgAnnouncementRow {
  return {
    id: 'announcement-0000-0000-0000-000000000001',
    organizationId: ORG,
    title: 'Maintenance window',
    body: 'The app is read-only tonight.',
    startsAt: null,
    endsAt: null,
    createdBy: 'membership-0000-0000-0000-000000000001',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as OrgAnnouncementRow;
}

/** A `TenantDatabase` whose `read`/`transaction` just run the unit of work against a fake repo. */
function serviceWith(repo: Partial<OrgAnnouncementsRepository>): OrgAnnouncementsService {
  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new OrgAnnouncementsService(database, repo as OrgAnnouncementsRepository);
}

describe('OrgAnnouncements write authorization (x276)', () => {
  it('refuses a POST without org.manage (a client) with a 403 and no insert', async () => {
    const create = vi.fn();
    const controller = new AdminAnnouncementsController(serviceWith({ create }));

    await expect(
      controller.create(context, client(), { title: 'Hello', body: 'World' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(create).not.toHaveBeenCalled();
  });

  it('resolves a DELETE of another tenant id to 404 with no delete (resolve before authorize)', async () => {
    // The repository is tenant-scoped, so another tenant's id resolves to null → 404, decided before
    // the org.manage authorize. No delete is issued.
    const findById = vi.fn().mockResolvedValue(null);
    const remove = vi.fn();
    const controller = new AdminAnnouncementsController(serviceWith({ findById, remove }));

    await expect(
      controller.remove(context, owner(), 'announcement-of-another-tenant'),
    ).rejects.toMatchObject({ status: 404 });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('OrgAnnouncements validation and window (x276)', () => {
  it('refuses an empty title with a 400 and no insert', async () => {
    const create = vi.fn();
    const controller = new AdminAnnouncementsController(serviceWith({ create }));

    await expect(
      controller.create(context, owner(), { title: '   ', body: 'x' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses endsAt <= startsAt with a 400 and no insert', async () => {
    const create = vi.fn();
    const controller = new AdminAnnouncementsController(serviceWith({ create }));

    await expect(
      controller.create(context, owner(), {
        title: 'Window',
        body: 'x',
        startsAt: '2026-02-02T00:00:00.000Z',
        endsAt: '2026-02-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(create).not.toHaveBeenCalled();
  });

  it('lists only announcements active right now, dropping past and future windows', async () => {
    const now = Date.now();
    const listForOrg = vi
      .fn()
      .mockResolvedValue([
        row({ id: 'open', startsAt: null, endsAt: null }),
        row({ id: 'past', endsAt: new Date(now - 1000) }),
        row({ id: 'future', startsAt: new Date(now + 60_000) }),
        row({ id: 'current', startsAt: new Date(now - 1000), endsAt: new Date(now + 60_000) }),
      ]);
    const controller = new MemberAnnouncementsController(serviceWith({ listForOrg }));

    const { announcements } = await controller.list(context);
    expect(announcements.map((a) => a.id)).toEqual(['open', 'current']);
  });
});

describe('OrgAnnouncements route guards (x276)', () => {
  it('guards POST and DELETE with org.manage, and the read with work.read', () => {
    expect(
      Reflect.getMetadata(REQUIRED_CAPABILITY, AdminAnnouncementsController.prototype.create),
    ).toBe('org.manage');
    expect(
      Reflect.getMetadata(REQUIRED_CAPABILITY, AdminAnnouncementsController.prototype.remove),
    ).toBe('org.manage');
    expect(
      Reflect.getMetadata(REQUIRED_CAPABILITY, MemberAnnouncementsController.prototype.list),
    ).toBe('work.read');
  });
});
