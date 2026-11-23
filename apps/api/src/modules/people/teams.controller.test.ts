import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { PeopleTeamsController } from './teams.controller.js';
import { PeopleTeamsService } from './teams.service.js';
import type { PeopleTeamsRepository } from './teams.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MemberTeamRow } from '../../common/database/schema.js';

/**
 * PEOPLE / module 14 (x262). The people-teams controller over an in-memory `member_teams` store with
 * the **real** `authorize()` evaluator and the real service, so the subject is the controller's and
 * service's own decisions:
 *
 * - create → assign → detail/list round-trip;
 * - a duplicate team name is a 409 with no second team;
 * - the refusal: creating a team without `org.manage` is a 403 with NO insert;
 * - the Known-trap — an unknown/cross-tenant team, or an assignment of a non-member membership, is a
 *   404 with no write; assigning is idempotent;
 * - the route ceilings — writes require `org.manage`, reads `work.read`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-0000000000ff';
const MEMBERSHIP = 'membership-0000-0000-0000-00000000aa01';
const UNKNOWN_MEMBERSHIP = 'membership-0000-0000-0000-00000000aaff';
const USER = 'user-0000-0000-0000-0000-000000000001';

function principal(role: Principal['role'], orgWide = false): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: orgWide,
  };
}

const admin = principal('owner', true); // holds org.manage + work.read
const member = principal('member'); // holds neither org.manage nor org-wide work.read

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function build(
  knownMembershipIds: readonly string[] = [MEMBERSHIP],
  aiMembershipIds: readonly string[] = [],
): {
  controller: PeopleTeamsController;
  store: MemberTeamRow[];
  audits: { action: string; objectId: string; metadata: Record<string, unknown> }[];
} {
  const store: MemberTeamRow[] = [];
  let seq = 0;
  const now = () => new Date(Date.UTC(2026, 0, ++seq));
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const scoped = (org: string) => store.filter((r) => r.organizationId === org);
  const teams = {
    listTeams: async (_r: unknown, ctx: TenantContext) =>
      scoped(ctx.organizationId)
        .filter((r) => r.name !== null)
        .map((def) => ({
          definition: { id: def.id, name: def.name ?? '', createdAt: def.createdAt },
          memberCount: scoped(ctx.organizationId).filter(
            (r) => r.name === null && r.teamId === def.id,
          ).length,
        })),
    findTeamById: async (_r: unknown, ctx: TenantContext, id: string) => {
      const row = scoped(ctx.organizationId).find((r) => r.id === id && r.name !== null);
      return row ? { id: row.id, name: row.name ?? '', createdAt: row.createdAt } : null;
    },
    findTeamByName: async (_r: unknown, ctx: TenantContext, name: string) => {
      const row = scoped(ctx.organizationId).find((r) => r.name === name);
      return row ? { id: row.id, name: row.name ?? '', createdAt: row.createdAt } : null;
    },
    createTeam: async (_r: unknown, ctx: TenantContext, name: string) => {
      const row = {
        id: `team-${seq}`,
        organizationId: ctx.organizationId,
        teamId: null,
        membershipId: null,
        name,
        createdAt: now(),
      } as MemberTeamRow;
      store.push(row);
      return { id: row.id, name, createdAt: row.createdAt };
    },
    listMembers: async (_r: unknown, ctx: TenantContext, teamId: string) =>
      scoped(ctx.organizationId)
        .filter((r) => r.name === null && r.teamId === teamId)
        .map((r) => ({
          membershipId: r.membershipId ?? '',
          userId: USER,
          displayName: 'Ada',
          role: 'member',
          status: 'active',
        })),
    findAssignment: async (_r: unknown, ctx: TenantContext, teamId: string, mid: string) =>
      scoped(ctx.organizationId).find(
        (r) => r.name === null && r.teamId === teamId && r.membershipId === mid,
      ) ?? null,
    createAssignment: async (_r: unknown, ctx: TenantContext, teamId: string, mid: string) => {
      store.push({
        id: `assign-${seq}`,
        organizationId: ctx.organizationId,
        teamId,
        membershipId: mid,
        name: null,
        createdAt: now(),
      } as MemberTeamRow);
    },
    renameTeam: async (_r: unknown, ctx: TenantContext, id: string, name: string) => {
      const row = scoped(ctx.organizationId).find((r) => r.id === id && r.name !== null);
      if (row) row.name = name;
      return row !== undefined;
    },
    listRosters: async (_r: unknown, ctx: TenantContext) =>
      scoped(ctx.organizationId)
        .filter((r) => r.name === null)
        .map((r) => ({
          teamId: r.teamId ?? '',
          membershipId: r.membershipId ?? '',
          userId: `user-of-${r.membershipId ?? ''}`,
          displayName: `Person ${r.membershipId ?? ''}`,
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    openWorkCounts: async (_r: unknown, _c: unknown, ids: readonly string[]) =>
      new Map(ids.map((id) => [id, 3])),
    deleteAssignment: async (_r: unknown, ctx: TenantContext, teamId: string, mid: string) => {
      const before = store.length;
      const kept = store.filter(
        (r) =>
          !(
            r.organizationId === ctx.organizationId &&
            r.name === null &&
            r.teamId === teamId &&
            r.membershipId === mid
          ),
      );
      store.length = 0;
      store.push(...kept);
      return store.length < before;
    },
  } as unknown as PeopleTeamsRepository;

  const memberships = {
    findById: async (_r: unknown, ctx: TenantContext, mid: string) =>
      knownMembershipIds.includes(mid) && ctx.organizationId === ORG
        ? ({ id: mid, kind: aiMembershipIds.includes(mid) ? 'ai' : 'human' } as unknown)
        : null,
  } as unknown as MembershipsRepository;

  const audits: { action: string; objectId: string; metadata: Record<string, unknown> }[] = [];
  const audit = {
    record: async (
      _r: unknown,
      _c: unknown,
      entry: { action: string; objectId: string; metadata: Record<string, unknown> },
    ) => void audits.push(entry),
  };
  const service = new PeopleTeamsService(database, teams, memberships, audit as never);
  return { controller: new PeopleTeamsController(service), store, audits };
}

describe('PeopleTeamsController create → assign → read', () => {
  it('creates a team, assigns a member, and reads it back', async () => {
    const { controller } = build();
    const team = await controller.create(context, admin, { name: 'Platform' });
    expect(team.name).toBe('Platform');
    expect(team.memberCount).toBe(0);
    expect((team as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    await controller.assign(context, admin, team.id, MEMBERSHIP);
    const detail = await controller.detail(context, admin, team.id);
    expect(detail.members.map((m) => m.membershipId)).toEqual([MEMBERSHIP]);

    const listed = await controller.list(context, admin);
    expect(listed.teams.map((t) => [t.id, t.memberCount])).toEqual([[team.id, 1]]);
  });

  it('is idempotent: a second identical assign adds no second row', async () => {
    const { controller, store } = build();
    const team = await controller.create(context, admin, { name: 'Platform' });
    await controller.assign(context, admin, team.id, MEMBERSHIP);
    await controller.assign(context, admin, team.id, MEMBERSHIP);
    expect(store.filter((r) => r.name === null)).toHaveLength(1);
  });
});

describe('the guarded invariants', () => {
  it('rejects a duplicate team name with a 409 and no second team', async () => {
    const { controller, store } = build();
    await controller.create(context, admin, { name: 'Platform' });
    await expect(controller.create(context, admin, { name: 'Platform' })).rejects.toEqual(
      expect.objectContaining({ status: 409, code: 'conflict' }),
    );
    expect(store.filter((r) => r.name !== null)).toHaveLength(1);
  });

  it('THE REFUSAL: creating a team without org.manage is a 403 and inserts nothing', async () => {
    const { controller, store } = build();
    await expect(controller.create(context, member, { name: 'Platform' })).rejects.toEqual(
      expect.objectContaining({ status: 403, code: 'forbidden' }),
    );
    expect(store).toHaveLength(0);
  });

  it('rejects a blank team name with a 400 and no insert', async () => {
    const { controller, store } = build();
    await expect(controller.create(context, admin, { name: '  ' })).rejects.toEqual(
      expect.objectContaining({ status: 400 }),
    );
    expect(store).toHaveLength(0);
  });
});

describe('the Known-trap: unknown/cross-tenant is a 404, no write', () => {
  it('assign against an unknown team is a 404 and writes nothing', async () => {
    const { controller, store } = build();
    await expect(controller.assign(context, admin, 'team-missing', MEMBERSHIP)).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
    expect(store).toHaveLength(0);
  });

  it('60-09: an AI employee is never a team member (422) and nothing is written', async () => {
    const { controller, store } = build([MEMBERSHIP], [MEMBERSHIP]);
    const team = await controller.create(context, admin, { name: 'Platform' });
    await expect(controller.assign(context, admin, team.id, MEMBERSHIP)).rejects.toEqual(
      expect.objectContaining({ status: 422, auditCode: 'team.ai_employee' }),
    );
    expect(store.filter((r) => r.name === null)).toHaveLength(0);
  });

  it('assign of a non-member membership is a 404 and writes nothing', async () => {
    const { controller, store } = build();
    const team = await controller.create(context, admin, { name: 'Platform' });
    await expect(controller.assign(context, admin, team.id, UNKNOWN_MEMBERSHIP)).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
    expect(store.filter((r) => r.name === null)).toHaveLength(0);
  });

  it('reading a cross-tenant team id is a 404', async () => {
    const { controller, store } = build();
    // Seed a team in another tenant directly.
    store.push({
      id: 'team-other',
      organizationId: OTHER_ORG,
      teamId: null,
      membershipId: null,
      name: 'Foreign',
      createdAt: new Date(),
    } as MemberTeamRow);
    await expect(controller.detail(context, admin, 'team-other')).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe('the route ceilings the CapabilityGuard enforces', () => {
  it('requires org.manage to write and work.read to read', () => {
    const cap = (m: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, m as object);
    expect(cap(PeopleTeamsController.prototype.create)).toBe('org.manage');
    expect(cap(PeopleTeamsController.prototype.assign)).toBe('org.manage');
    expect(cap(PeopleTeamsController.prototype.unassign)).toBe('org.manage');
    expect(cap(PeopleTeamsController.prototype.list)).toBe('work.read');
    expect(cap(PeopleTeamsController.prototype.detail)).toBe('work.read');
  });
});

describe('work area (2026-11-23): rename, open work and an audit row for every team change', () => {
  it('renames a team, refuses a taken name (409) and an unknown team (404)', async () => {
    const { controller, store } = build();
    const design = await controller.create(context, admin, { name: 'Design' });
    await controller.create(context, admin, { name: 'Copy' });
    const renamed = await controller.rename(context, admin, design.id, { name: ' Brand design ' });
    expect(renamed.name).toBe('Brand design');
    expect(store.find((r) => r.id === design.id)?.name).toBe('Brand design');
    await expect(controller.rename(context, admin, design.id, { name: 'Copy' })).rejects.toEqual(
      expect.objectContaining({ status: 409 }),
    );
    await expect(controller.rename(context, admin, 'team-missing', { name: 'X' })).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
    await expect(controller.rename(context, member, design.id, { name: 'X' })).rejects.toEqual(
      expect.objectContaining({ status: 403 }),
    );
    expect(store.find((r) => r.id === design.id)?.name).toBe('Brand design');
  });

  it('records team.created, team.renamed, team.member_added and team.member_removed once each', async () => {
    const { controller, audits } = build();
    const team = await controller.create(context, admin, { name: 'Design' });
    await controller.rename(context, admin, team.id, { name: 'Design' }); // no change, no row
    await controller.rename(context, admin, team.id, { name: 'Brand' });
    await controller.assign(context, admin, team.id, MEMBERSHIP);
    await controller.assign(context, admin, team.id, MEMBERSHIP); // idempotent, no row
    await controller.unassign(context, admin, team.id, MEMBERSHIP);
    await controller.unassign(context, admin, team.id, MEMBERSHIP); // not on it, no row
    expect(audits.map((a) => a.action)).toEqual([
      'team.created',
      'team.renamed',
      'team.member_added',
      'team.member_removed',
    ]);
    expect(audits[2]?.metadata).toEqual({ membership_id: MEMBERSHIP });
  });

  it('lists each team with its first three faces and counts a person in two teams once', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4'];
    const { controller } = build(ids);
    const design = await controller.create(context, admin, { name: 'Design' });
    const dev = await controller.create(context, admin, { name: 'Development' });
    for (const id of ids) await controller.assign(context, admin, design.id, id);
    await controller.assign(context, admin, dev.id, 'm1');

    const listed = await controller.list(context, admin);
    const byName = new Map(listed.teams.map((row) => [row.name, row]));
    expect(byName.get('Design')?.memberCount).toBe(4);
    expect(byName.get('Design')?.faces.map((face) => face.displayName)).toEqual([
      'Person m1',
      'Person m2',
      'Person m3',
    ]);
    expect(byName.get('Development')?.faces).toEqual([
      { userId: 'user-of-m1', displayName: 'Person m1' },
    ]);
    expect(listed.peopleCount).toBe(4);
  });

  it('shows each member with the open work they do', async () => {
    const { controller } = build();
    const team = await controller.create(context, admin, { name: 'Design' });
    await controller.assign(context, admin, team.id, MEMBERSHIP);
    const detail = await controller.detail(context, admin, team.id);
    expect(detail.members[0]?.openWorkCount).toBe(3);
    const cap = (m: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, m as object);
    expect(cap(PeopleTeamsController.prototype.rename)).toBe('org.manage');
  });
});
