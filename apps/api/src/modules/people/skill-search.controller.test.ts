import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { SkillSearchController } from './skill-search.controller.js';
import type {
  PersonSkillSearchRepository,
  SkillSearchMatchRow,
  SkillSearchQuery,
} from './skill-search.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Skill directory search (x194) controller proofs, database-free over a fake repository with the
 * *real* `authorize`. The tenant-scoped join is the chain's DB suite, not here; this file proves the
 * controller's own logic: the requested labels reach the repository and matches group per member, a
 * minimum level narrows, a blank query returns an empty result with no read, the member page is
 * capped, a bad level/limit is 400, and a suspended membership is refused (403) with no read.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const RANK = { basic: 0, proficient: 1, expert: 2 } as const;

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
    ...overrides,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

/** A controller over a fake repository whose store honours the label/level/limit filter and records reads. */
function controllerWith(rows: readonly SkillSearchMatchRow[]) {
  const queries: SkillSearchQuery[] = [];
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    searchMembersBySkill: async (
      _runner: unknown,
      _context: TenantContext,
      query: SkillSearchQuery,
    ) => {
      queries.push(query);
      const labels = new Set(query.labels);
      const matched = rows
        .filter((r) => labels.has(r.label))
        .filter((r) => !query.minLevel || RANK[r.level] >= RANK[query.minLevel]);
      const kept = new Set<string>();
      for (const r of matched) {
        if (kept.size >= query.limit) break;
        kept.add(r.membershipId);
      }
      return matched.filter((r) => kept.has(r.membershipId));
    },
  } as unknown as PersonSkillSearchRepository;

  return { controller: new SkillSearchController(database, repository), queries };
}

function row(
  membershipId: string,
  label: string,
  level: SkillSearchMatchRow['level'],
): SkillSearchMatchRow {
  return { membershipId, role: 'member', status: 'active', label, level };
}

describe('SkillSearchController', () => {
  it('returns only matching members, grouped, with no organizationId', async () => {
    const { controller } = controllerWith([
      row('m1', 'TypeScript', 'expert'),
      row('m1', 'React', 'basic'),
      row('m2', 'React', 'proficient'),
      row('m3', 'Go', 'expert'),
    ]);

    const { results } = await controller.run(context, principal(), ['TypeScript', 'React']);

    expect(results.map((r) => r.membershipId)).toEqual(['m1', 'm2']); // m3 (Go only) excluded
    const [first] = results;
    expect(first?.matched.map((s) => s.label)).toEqual(['TypeScript', 'React']);
    expect(first).not.toHaveProperty('organizationId');
  });

  it('narrows by a minimum level', async () => {
    const { controller } = controllerWith([
      row('m1', 'React', 'basic'),
      row('m2', 'React', 'expert'),
    ]);

    const { results } = await controller.run(context, principal(), 'React', 'proficient');
    expect(results.map((r) => r.membershipId)).toEqual(['m2']);
  });

  it('returns an empty result for a blank query without reading', async () => {
    const { controller, queries } = controllerWith([row('m1', 'React', 'expert')]);
    const { results } = await controller.run(context, principal(), ['   ', '']);
    expect(results).toEqual([]);
    expect(queries).toEqual([]); // no scan
  });

  it('caps the member page size', async () => {
    const { controller } = controllerWith([
      row('m1', 'React', 'basic'),
      row('m2', 'React', 'basic'),
      row('m3', 'React', 'basic'),
    ]);
    const { results } = await controller.run(context, principal(), 'React', undefined, '2');
    expect(results.map((r) => r.membershipId)).toEqual(['m1', 'm2']);
  });

  it('rejects a bad level or limit with 400', async () => {
    const { controller } = controllerWith([]);
    await expect(controller.run(context, principal(), 'React', 'guru')).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      controller.run(context, principal(), 'React', undefined, '0'),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a suspended membership with 403 and no read', async () => {
    const { controller, queries } = controllerWith([row('m1', 'React', 'expert')]);
    await expect(
      controller.run(context, principal({ membershipStatus: 'suspended' }), 'React'),
    ).rejects.toMatchObject({ status: 403 });
    expect(queries).toEqual([]);
  });
});
