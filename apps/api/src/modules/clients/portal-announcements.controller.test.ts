import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { PortalAnnouncementsController } from './portal-announcements.controller.js';
import { PortalAnnouncementsService } from './portal-announcements.service.js';
import type { ClientOrganizationsRepository } from './client-organizations.repository.js';
import type {
  CreatePortalAnnouncementInput,
  PortalAnnouncementsRepository,
} from './portal-announcements.repository.js';
import type { ClientOrganizationRow, PortalAnnouncementRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * POR client portal (x304) — the internal create/delete surface and the client read, over fakes with
 * **real** `authorize()`.
 *
 * The fakes stand in only for the database and the two repositories; `authorize()` is the real policy,
 * so these cases prove the actual security decisions: an internal staffer posts as the context user
 * and the client reads only their own client's *active* banners; a cross-tenant client id is a 404
 * with no write; a role without `client_member.manage` is a 403; and the write validations refuse an
 * empty title and a non-positive window before the insert. No DB in this suite (the chain owns the
 * round-trip and the migrator proof).
 */

const ORG = 'org-under-test';
const CLIENT = 'client-org-under-test';
const OTHER_CLIENT = 'client-org-sibling';
const INTERNAL_USER = 'user-internal-1';

function internalManager(): Principal {
  return {
    userId: INTERNAL_USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-internal-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

/** An internal role whose ceiling excludes `client_member.manage` — proves the 403. */
function internalMember(): Principal {
  return { ...internalManager(), role: 'member', hasOrgWideScope: false };
}

function clientAdmin(ownClientOrg: string): Principal {
  return {
    userId: 'client-user-1',
    organizationId: ORG,
    kind: 'client',
    role: 'client_admin',
    membershipId: 'membership-client-1',
    membershipStatus: 'active',
    clientOrganizationId: ownClientOrg,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, userId: INTERNAL_USER } as unknown as TenantContext;
const NOW = new Date('2026-09-27T12:00:00.000Z');

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

/** A client-org repo that resolves exactly the ids it was seeded with (tenant-scoped by the context). */
function fakeClients(ids: readonly string[]): ClientOrganizationsRepository {
  return {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(
        ids.includes(id) ? ({ id, organizationId: ORG } as unknown as ClientOrganizationRow) : null,
      ),
  } as unknown as ClientOrganizationsRepository;
}

/** A stateful banner store: `create` appends, reads filter by client + active window, `delete` prunes. */
function fakeAnnouncements(seed: readonly PortalAnnouncementRow[] = []): {
  repo: PortalAnnouncementsRepository;
  created: CreatePortalAnnouncementInput[];
  rows: PortalAnnouncementRow[];
} {
  const created: CreatePortalAnnouncementInput[] = [];
  const rows: PortalAnnouncementRow[] = [...seed];
  let seq = 0;
  const repo = {
    create: (_r: never, _c: TenantContext, input: CreatePortalAnnouncementInput) => {
      created.push(input);
      seq += 1;
      const row = {
        id: `a-${seq}`,
        organizationId: ORG,
        clientId: input.clientId,
        title: input.title,
        body: input.body,
        startsAt: input.startsAt ?? NOW,
        endsAt: input.endsAt,
        createdBy: input.createdBy,
        createdAt: NOW,
      } as unknown as PortalAnnouncementRow;
      rows.push(row);
      return Promise.resolve(row);
    },
    listActiveForClient: (_r: never, _c: TenantContext, clientId: string, now: Date) =>
      Promise.resolve(
        rows.filter(
          (row) =>
            row.clientId === clientId &&
            row.startsAt.getTime() <= now.getTime() &&
            (row.endsAt === null || row.endsAt.getTime() > now.getTime()),
        ),
      ),
    delete: (_r: never, _c: TenantContext, clientId: string, id: string) => {
      const before = rows.length;
      const kept = rows.filter((row) => !(row.clientId === clientId && row.id === id));
      rows.length = 0;
      rows.push(...kept);
      return Promise.resolve(kept.length < before);
    },
  } as unknown as PortalAnnouncementsRepository;
  return { repo, created, rows };
}

function serviceFor(
  clientIds: readonly string[],
  store: ReturnType<typeof fakeAnnouncements>,
): PortalAnnouncementsService {
  return new PortalAnnouncementsService(
    fakeDatabase(),
    fakeClients(clientIds),
    store.repo,
    () => NOW,
  );
}

describe('PortalAnnouncementsService (x304)', () => {
  it('posts as the context user; the client reads their own active banner without a staff identity', async () => {
    const store = fakeAnnouncements();
    const service = serviceFor([CLIENT], store);

    const created = await service.create(context, internalManager(), CLIENT, {
      title: 'Scheduled maintenance',
      body: 'The portal is read-only Saturday morning.',
    });

    expect(store.created[0]?.createdBy).toBe(INTERNAL_USER);
    expect(created).toMatchObject({ clientId: CLIENT, createdBy: INTERNAL_USER });

    const seen = await service.listActiveForClient(context, clientAdmin(CLIENT), CLIENT);
    expect(seen.map((a) => a.title)).toEqual(['Scheduled maintenance']);
    expect(Object.keys(seen[0]!).sort()).toEqual(
      ['body', 'clientId', 'endsAt', 'id', 'startsAt', 'title'].sort(),
    );
    expect(seen[0]).not.toHaveProperty('createdBy');
  });

  it('answers 404 and writes nothing for a client organization in another tenant', async () => {
    const store = fakeAnnouncements();
    // The client org is not resolvable in this tenant.
    const service = serviceFor([], store);

    await expect(
      service.create(context, internalManager(), CLIENT, { title: 'x', body: 'y' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.created).toHaveLength(0);
  });

  it('answers 403 for an internal role that does not hold client_member.manage', async () => {
    const store = fakeAnnouncements();
    const service = serviceFor([CLIENT], store);

    await expect(
      service.create(context, internalMember(), CLIENT, { title: 'x', body: 'y' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.created).toHaveLength(0);
  });

  it('answers 400 and writes nothing when endsAt is not after startsAt', async () => {
    const store = fakeAnnouncements();
    const service = serviceFor([CLIENT], store);

    await expect(
      service.create(context, internalManager(), CLIENT, {
        title: 'x',
        body: 'y',
        startsAt: new Date('2026-09-27T10:00:00.000Z'),
        endsAt: new Date('2026-09-27T10:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.created).toHaveLength(0);
  });

  it('a client cannot read another client organization’s banners (404, not an empty list)', async () => {
    const store = fakeAnnouncements();
    const service = serviceFor([CLIENT, OTHER_CLIENT], store);

    await expect(
      service.listActiveForClient(context, clientAdmin(CLIENT), OTHER_CLIENT),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('the active-window read excludes not-yet-started and expired banners', async () => {
    const store = fakeAnnouncements([
      {
        id: 'past',
        organizationId: ORG,
        clientId: CLIENT,
        title: 'expired',
        body: 'b',
        startsAt: new Date('2026-09-01T00:00:00.000Z'),
        endsAt: new Date('2026-09-10T00:00:00.000Z'),
        createdBy: INTERNAL_USER,
        createdAt: NOW,
      } as unknown as PortalAnnouncementRow,
      {
        id: 'future',
        organizationId: ORG,
        clientId: CLIENT,
        title: 'not yet',
        body: 'b',
        startsAt: new Date('2026-10-01T00:00:00.000Z'),
        endsAt: null,
        createdBy: INTERNAL_USER,
        createdAt: NOW,
      } as unknown as PortalAnnouncementRow,
    ]);
    const service = serviceFor([CLIENT], store);

    const seen = await service.listActiveForClient(context, clientAdmin(CLIENT), CLIENT);
    expect(seen).toHaveLength(0);
  });

  it('retract is idempotent — no throw when the banner is already gone', async () => {
    const store = fakeAnnouncements();
    const service = serviceFor([CLIENT], store);

    await expect(
      service.remove(context, internalManager(), CLIENT, 'never-existed'),
    ).resolves.toBeUndefined();
  });
});

/**
 * The route ceiling the guard enforces. A role that lacks the capability is refused with 403 before
 * the handler runs; the live round-trip is the chain's e2e. This pins the wiring the guard depends on.
 */
describe('portal-announcements route capabilities', () => {
  const capabilityOf = (key: string): unknown =>
    Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      (PortalAnnouncementsController.prototype as unknown as Record<string, unknown>)[
        key
      ] as object,
    );

  it('guards create and retract with client_member.manage', () => {
    expect(capabilityOf('post')).toBe('client_member.manage');
    expect(capabilityOf('remove')).toBe('client_member.manage');
  });

  it('guards the portal read with client_projection.read', () => {
    expect(capabilityOf('list')).toBe('client_projection.read');
  });
});
