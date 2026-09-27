import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { PersonSkillsController } from './skills.controller.js';
import { PersonSkillDuplicateError } from './skills.repository.js';
import type { PersonSkillsRepository } from './skills.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MembershipRow, PersonSkillRow } from '../../common/database/schema.js';

/**
 * People member skills (x172) controller proofs, database-free over fakes with the *real*
 * `authorize`. The migration and the tenant-scoped SQL round-trip are the chain's DB suite, not
 * here; this file proves the controller's own logic: resolve-before-authorize (a cross-tenant
 * member id is 404 with no write), add→list→delete, the duplicate-label 409, the bad-label 400, and
 * the deny for a role without `project.manage` (403).
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const MEMBER = 'membership-0000-0000-00000000000a';
const USER = 'user-0000-0000-0000-0000-000000000001';

function principal(role: Principal['role']): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function membershipRow(id: string, organizationId: string): MembershipRow {
  return { id, organizationId } as unknown as MembershipRow;
}

/**
 * A controller over an in-memory store. `createCalls`/`deleteCalls` record every mutation so a test
 * can assert none happened. The fake repository is tenant-and-member-scoped like the real one.
 */
function controllerWith(members: readonly MembershipRow[]) {
  const store: PersonSkillRow[] = [];
  const createCalls: { membershipId: string; label: string }[] = [];
  let seq = 0;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    findMembership: async (_runner: unknown, ctx: TenantContext, membershipId: string) =>
      members.find((m) => m.id === membershipId && m.organizationId === ctx.organizationId) ?? null,
    listForMember: async (_runner: unknown, ctx: TenantContext, membershipId: string) =>
      store
        .filter((r) => r.membershipId === membershipId && r.organizationId === ctx.organizationId)
        .sort((a, b) => a.label.localeCompare(b.label)),
    findSkill: async (
      _runner: unknown,
      ctx: TenantContext,
      membershipId: string,
      skillId: string,
    ) =>
      store.find(
        (r) =>
          r.id === skillId &&
          r.membershipId === membershipId &&
          r.organizationId === ctx.organizationId,
      ) ?? null,
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: { membershipId: string; label: string; level: PersonSkillRow['level'] },
    ) => {
      createCalls.push({ membershipId: input.membershipId, label: input.label });
      if (store.some((r) => r.membershipId === input.membershipId && r.label === input.label)) {
        throw new PersonSkillDuplicateError(input.label);
      }
      const row: PersonSkillRow = {
        id: `person-skill-${(seq += 1).toString().padStart(2, '0')}`,
        organizationId: ctx.organizationId,
        membershipId: input.membershipId,
        label: input.label,
        level: input.level,
        createdAt: new Date('2026-09-27T10:00:00.000Z'),
      };
      store.push(row);
      return row;
    },
    deleteSkill: async (
      _runner: unknown,
      ctx: TenantContext,
      membershipId: string,
      skillId: string,
    ) => {
      const index = store.findIndex(
        (r) =>
          r.id === skillId &&
          r.membershipId === membershipId &&
          r.organizationId === ctx.organizationId,
      );
      if (index === -1) return false;
      store.splice(index, 1);
      return true;
    },
  } as unknown as PersonSkillsRepository;

  return {
    controller: new PersonSkillsController(database, repository),
    store,
    createCalls,
  };
}

const localMember = [membershipRow(MEMBER, ORG)];

describe('PersonSkillsController', () => {
  it('adds a skill, lists it, and removes it', async () => {
    const { controller } = controllerWith(localMember);
    const actor = principal('owner');

    const added = await controller.add(context, actor, MEMBER, {
      label: '  TypeScript  ',
      level: 'expert',
    });
    expect(added.label).toBe('TypeScript'); // normalised
    expect(added.level).toBe('expert');
    expect(added).not.toHaveProperty('organizationId');

    const listed = await controller.list(context, actor, MEMBER);
    expect(listed.skills.map((s) => s.id)).toContain(added.id);

    await controller.remove(context, actor, MEMBER, added.id);
    const after = await controller.list(context, actor, MEMBER);
    expect(after.skills).toHaveLength(0);
  });

  it('rejects a duplicate (member, label) with 409', async () => {
    const { controller } = controllerWith(localMember);
    const actor = principal('owner');
    await controller.add(context, actor, MEMBER, { label: 'React', level: 'proficient' });

    await expect(
      controller.add(context, actor, MEMBER, { label: 'React', level: 'basic' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a blank or over-length label with 400 and writes nothing', async () => {
    const { controller, createCalls } = controllerWith(localMember);
    const actor = principal('owner');

    await expect(
      controller.add(context, actor, MEMBER, { label: '   ', level: 'basic' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.add(context, actor, MEMBER, { label: 'x'.repeat(81), level: 'basic' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.add(context, actor, MEMBER, { label: 'Go', level: 'guru' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(createCalls).toEqual([]);
  });

  it('returns 404 for a cross-tenant / unknown member id and writes nothing', async () => {
    // The member belongs to another org, so `findMembership` resolves null in this tenant.
    const { controller, createCalls } = controllerWith([]);

    await expect(
      controller.add(context, principal('owner'), MEMBER, { label: 'SQL', level: 'basic' }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      controller.add(context, principal('owner'), MEMBER, { label: 'SQL', level: 'basic' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(createCalls).toEqual([]);
  });

  it('refuses to add a skill without project.manage (403)', async () => {
    const { controller, createCalls } = controllerWith(localMember);
    // `member` holds work.read but not project.manage (capabilities ceiling), so the org-scoped
    // authorize denies the write with a 403 — after the member resolves, before any insert.
    await expect(
      controller.add(context, principal('member'), MEMBER, { label: 'Design', level: 'basic' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(createCalls).toEqual([]);
  });
});
