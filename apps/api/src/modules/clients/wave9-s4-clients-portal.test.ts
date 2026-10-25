import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ClientMessagesService } from './client-messages.service.js';
import { ClientsService } from './clients.service.js';
import { PortalAnnouncementsService } from './portal-announcements.service.js';
import { PortalService } from './portal.service.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { ClientMessagesRepository } from './client-messages.repository.js';
import type { ClientMembershipsRepository } from './client-memberships.repository.js';
import type { ClientOrganizationsRepository } from './client-organizations.repository.js';
import type {
  CreatePortalAnnouncementInput,
  PortalAnnouncementsRepository,
} from './portal-announcements.repository.js';
import type {
  ClientMembershipRow,
  PortalAnnouncementRow,
  ProjectRow,
  PortalClientMessageRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Wave 9, lane S4 — regression tests for audit run 1 findings F02, F27 and F38, over fakes with the
 * **real** `authorize()`. Each case replays the audit's exploit step and proves it now fails (with
 * nothing read or written), next to the legitimate staff path that must keep working.
 */

const ORG = 'org-atlas';
const CLIENT_A = 'client-org-a';
const CLIENT_B = 'client-org-b';
const STAFF_USER = 'staff-user-1';
const OUTSIDE_USER = 'outside-user-1';

const context = { organizationId: ORG, userId: 'caller-1' } as unknown as TenantContext;

function clientAdmin(clientOrganizationId: string = CLIENT_A): Principal {
  return {
    userId: 'client-admin-1',
    organizationId: ORG,
    kind: 'client',
    role: 'client_admin',
    membershipId: 'cm-admin-1',
    membershipStatus: 'active',
    clientOrganizationId,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

function internal(role: 'manager' | 'org_admin', hasOrgWideScope = false): Principal {
  return {
    userId: 'staff-caller-1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm-staff-caller-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope,
  };
}

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

function fakeOrganizations(ids: readonly string[] = [CLIENT_A, CLIENT_B]): {
  repo: ClientOrganizationsRepository;
  lookups: string[];
} {
  const lookups: string[] = [];
  const repo = {
    findById: (_r: never, _c: TenantContext, id: string) => {
      lookups.push(id);
      return Promise.resolve(
        ids.includes(id) ? ({ id, organizationId: ORG, archivedAt: null } as never) : null,
      );
    },
  } as unknown as ClientOrganizationsRepository;
  return { repo, lookups };
}

// ── F02 — the admin inbound read of portal messages ──────────────────────────

describe('F02: GET portal/messages/admin refuses every client principal', () => {
  function messagesService(): { service: ClientMessagesService; reads: string[] } {
    const reads: string[] = [];
    const rows = [
      {
        id: 'm-b',
        organizationId: ORG,
        clientOrgScopeId: CLIENT_B,
        authorUserId: 'client-user-b',
        subject: 'dummy-B',
        body: 'secret-B',
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
      },
      {
        id: 'm-a',
        organizationId: ORG,
        clientOrgScopeId: CLIENT_A,
        authorUserId: 'client-user-a',
        subject: 'dummy-A',
        body: 'secret-A',
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
      },
    ] as unknown as PortalClientMessageRow[];
    const messages = {
      listForScope: (_r: never, _c: TenantContext, scope: string) => {
        reads.push(scope);
        return Promise.resolve(rows.filter((row) => row.clientOrgScopeId === scope));
      },
    } as unknown as ClientMessagesRepository;
    return {
      service: new ClientMessagesService(fakeDatabase(), fakeOrganizations().repo, messages),
      reads,
    };
  }

  it('answers 404 to a client admin naming a sibling client organization, and reads nothing', async () => {
    const { service, reads } = messagesService();
    await expect(service.listForAdmin(context, clientAdmin(), CLIENT_B)).rejects.toMatchObject({
      status: 404,
    });
    expect(reads).toHaveLength(0);
  });

  it('answers 404 to a client admin naming their own client organization too', async () => {
    const { service, reads } = messagesService();
    await expect(service.listForAdmin(context, clientAdmin(), CLIENT_A)).rejects.toMatchObject({
      status: 404,
    });
    expect(reads).toHaveLength(0);
  });

  it('still lets an internal manager read the inbound record', async () => {
    const { service } = messagesService();
    const inbound = await service.listForAdmin(context, internal('manager'), CLIENT_B);
    expect(inbound.map((m) => m.subject)).toEqual(['dummy-B']);
  });
});

// ── F27 — raw-userId client memberships ──────────────────────────────────────

describe('F27: a client admin cannot put staff (or anyone) into their client organization', () => {
  function membershipsFake(seed: Partial<ClientMembershipRow> | null = null): {
    repo: ClientMembershipsRepository;
    invited: unknown[];
    transitions: unknown[];
  } {
    const invited: unknown[] = [];
    const transitions: unknown[] = [];
    const now = new Date('2026-10-25T00:00:00.000Z');
    const row = (over: Partial<ClientMembershipRow>): ClientMembershipRow =>
      ({
        id: 'cm-1',
        organizationId: ORG,
        clientOrganizationId: CLIENT_A,
        userId: OUTSIDE_USER,
        role: 'client_viewer',
        status: 'invited',
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
        ...over,
      }) as ClientMembershipRow;
    const repo = {
      userHasActiveInternalMembership: (_r: never, _c: TenantContext, userId: string) =>
        Promise.resolve(userId === STAFF_USER),
      invite: (_r: never, _c: TenantContext, input: { userId: string }) => {
        invited.push(input);
        return Promise.resolve(row({ userId: input.userId }));
      },
      findById: () => Promise.resolve(seed ? row(seed) : null),
      transitionStatus: (
        _r: never,
        _c: TenantContext,
        id: string,
        _at: Date,
        to: ClientMembershipRow['status'],
      ) => {
        transitions.push({ id, to });
        return Promise.resolve(row({ ...seed, status: to }));
      },
    } as unknown as ClientMembershipsRepository;
    return { repo, invited, transitions };
  }

  function clientsService(memberships: ClientMembershipsRepository): ClientsService {
    return new ClientsService(
      fakeDatabase(),
      { defaultExpiryDays: 30 },
      fakeOrganizations().repo,
      memberships,
    );
  }

  const inviteInput = (userId: string) => ({
    clientOrganizationId: CLIENT_A,
    userId,
    role: 'client_viewer' as const,
  });

  it('refuses a client admin the raw-userId invite of a staff member, and writes no row', async () => {
    const fake = membershipsFake();
    await expect(
      clientsService(fake.repo).invite(context, clientAdmin(), inviteInput(STAFF_USER)),
    ).rejects.toMatchObject({ status: 403 });
    expect(fake.invited).toHaveLength(0);
  });

  it('refuses a client admin the raw-userId invite of anybody (the email-bound flow is theirs)', async () => {
    const fake = membershipsFake();
    await expect(
      clientsService(fake.repo).invite(context, clientAdmin(), inviteInput(OUTSIDE_USER)),
    ).rejects.toMatchObject({ status: 403 });
    expect(fake.invited).toHaveLength(0);
  });

  it('answers 404 to staff inviting a user who is already staff in this tenant, and writes no row', async () => {
    const fake = membershipsFake();
    await expect(
      clientsService(fake.repo).invite(
        context,
        internal('org_admin', true),
        inviteInput(STAFF_USER),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(fake.invited).toHaveLength(0);
  });

  it('still lets staff invite an outside user', async () => {
    const fake = membershipsFake();
    const view = await clientsService(fake.repo).invite(
      context,
      internal('org_admin', true),
      inviteInput(OUTSIDE_USER),
    );
    expect(view.status).toBe('invited');
    expect(fake.invited).toHaveLength(1);
  });

  it('refuses a client admin activating an invited membership (403, no transition)', async () => {
    const fake = membershipsFake({ status: 'invited', userId: OUTSIDE_USER });
    await expect(
      clientsService(fake.repo).changeStatus(context, clientAdmin(), 'cm-1', new Date(), 'active'),
    ).rejects.toMatchObject({ status: 403 });
    expect(fake.transitions).toHaveLength(0);
  });

  it('refuses any activation for a user who is staff in this tenant (404, no transition)', async () => {
    const fake = membershipsFake({ status: 'suspended', userId: STAFF_USER });
    await expect(
      clientsService(fake.repo).changeStatus(
        context,
        internal('org_admin', true),
        'cm-1',
        new Date(),
        'active',
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(fake.transitions).toHaveLength(0);
  });

  it('still lets staff activate an outside user, and a client admin reinstate a suspended colleague', async () => {
    const invited = membershipsFake({ status: 'invited', userId: OUTSIDE_USER });
    const activated = await clientsService(invited.repo).changeStatus(
      context,
      internal('org_admin', true),
      'cm-1',
      new Date(),
      'active',
    );
    expect(activated.status).toBe('active');

    const suspended = membershipsFake({ status: 'suspended', userId: OUTSIDE_USER });
    const reinstated = await clientsService(suspended.repo).changeStatus(
      context,
      clientAdmin(),
      'cm-1',
      new Date(),
      'active',
    );
    expect(reinstated.status).toBe('active');
  });
});

// ── F38 — studio portal announcement banners ─────────────────────────────────

describe('F38: a client admin cannot post or retract studio banners', () => {
  const NOW = new Date('2026-10-25T12:00:00.000Z');

  function announcementsService(): {
    service: PortalAnnouncementsService;
    rows: PortalAnnouncementRow[];
    created: CreatePortalAnnouncementInput[];
  } {
    const created: CreatePortalAnnouncementInput[] = [];
    const rows: PortalAnnouncementRow[] = [
      {
        id: 'studio-banner',
        organizationId: ORG,
        clientId: CLIENT_A,
        title: 'Studio notice',
        body: 'From the agency',
        startsAt: NOW,
        endsAt: null,
        createdBy: 'staff-caller-1',
        createdAt: NOW,
      } as unknown as PortalAnnouncementRow,
    ];
    const repo = {
      create: (_r: never, _c: TenantContext, input: CreatePortalAnnouncementInput) => {
        created.push(input);
        const row = {
          id: `a-${created.length}`,
          organizationId: ORG,
          clientId: input.clientId,
          title: input.title,
          body: input.body,
          startsAt: input.startsAt ?? NOW,
          endsAt: input.endsAt ?? null,
          createdBy: input.createdBy,
          createdAt: NOW,
        } as unknown as PortalAnnouncementRow;
        rows.push(row);
        return Promise.resolve(row);
      },
      delete: (_r: never, _c: TenantContext, clientId: string, id: string) => {
        const index = rows.findIndex((row) => row.clientId === clientId && row.id === id);
        if (index >= 0) rows.splice(index, 1);
        return Promise.resolve(index >= 0);
      },
    } as unknown as PortalAnnouncementsRepository;
    return {
      service: new PortalAnnouncementsService(
        fakeDatabase(),
        fakeOrganizations().repo,
        repo,
        () => NOW,
      ),
      rows,
      created,
    };
  }

  it('refuses a client admin posting to their own client organization (404, no row)', async () => {
    const { service, created } = announcementsService();
    await expect(
      service.create(context, clientAdmin(), CLIENT_A, { title: 'Fake', body: 'Not the studio' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(created).toHaveLength(0);
  });

  it('refuses a client admin retracting the studio banner (404, the row survives)', async () => {
    const { service, rows } = announcementsService();
    await expect(
      service.remove(context, clientAdmin(), CLIENT_A, 'studio-banner'),
    ).rejects.toMatchObject({ status: 404 });
    expect(rows.map((row) => row.id)).toContain('studio-banner');
  });

  it('still lets an internal manager post and retract', async () => {
    const { service, rows } = announcementsService();
    const view = await service.create(context, internal('manager'), CLIENT_A, {
      title: 'Holiday hours',
      body: 'Closed Friday',
    });
    expect(view.clientId).toBe(CLIENT_A);
    await service.remove(context, internal('manager'), CLIENT_A, 'studio-banner');
    expect(rows.map((row) => row.id)).not.toContain('studio-banner');
  });
});

// ── F18 — the portal project list for internal principals ────────────────────

describe('F18: an internal guest or member sees only related projects in the portal list', () => {
  const projects = ['p-1', 'p-2', 'p-3'].map(
    (id) =>
      ({
        id,
        name: `Project ${id}`,
        status: 'active',
        committedAt: null,
        forecastAt: null,
      }) as unknown as ProjectRow,
  );
  const projectsRepo = {
    list: () => Promise.resolve(projects),
  } as unknown as ProjectsRepository;
  const service = new PortalService(fakeDatabase(), projectsRepo);

  function staff(role: 'guest' | 'member' | 'owner', projectIds: readonly string[]): Principal {
    return { ...internal('manager', role === 'owner'), role, projectIds };
  }

  it('lists nothing for a guest with no project memberships', async () => {
    await expect(service.projectsFor(context, staff('guest', []))).resolves.toEqual([]);
  });

  it('lists only the related project for a member', async () => {
    const seen = await service.projectsFor(context, staff('member', ['p-2']));
    expect(seen.map((p) => p.id)).toEqual(['p-2']);
  });

  it('still lists every project for an owner with org-wide scope', async () => {
    const seen = await service.projectsFor(context, staff('owner', []));
    expect(seen.map((p) => p.id)).toEqual(['p-1', 'p-2', 'p-3']);
  });
});
