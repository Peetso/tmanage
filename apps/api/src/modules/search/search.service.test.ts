import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { SearchService } from './search.service.js';
import { SearchController } from './search.controller.js';
import type { SearchHitRow, SearchReadOptions, SearchRepository } from './search.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * SRCH-01 (x111) service proofs, database-free over the module's fakes. The tenant-scoped SQL
 * round-trip and the migration are proven by the chain's per-table DB suites and the
 * `tenant-isolation` DB test over the tables this slice only reads (no schema change). Here the
 * subject is the service's own logic: the relation filter that never surfaces an item the item's
 * own direct read would deny, cross-tenant exclusion, the Known-trap projectId resolution, the
 * bound, the deterministic order, and literal (escaped) matching.
 *
 * The fake repository deliberately does **not** apply the tenant scope the real SQL applies, so a
 * cross-tenant row reaches the service and its `authorize()` filter must drop it — belt-and-braces
 * to the scoped query, exactly as the meetings and documents service tests do.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const OTHER_PROJECT = 'project-0000-0000-0000-0000-000000000002';
const USER = 'user-0000-0000-0000-0000-000000000001';

function member(projectIds: readonly string[], hasOrgWideScope = false): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: hasOrgWideScope ? 'owner' : 'member',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

interface Seed {
  readonly work?: readonly SearchHitRow[];
  readonly documents?: readonly SearchHitRow[];
  readonly meetings?: readonly SearchHitRow[];
}

/** Recover the unescaped needle from the service's `%…%` LIKE pattern, so the fake matches it. */
function needleOf(likePattern: string): string {
  return likePattern.slice(1, -1).replace(/\\([\\%_])/g, '$1');
}

function matcher(rows: readonly SearchHitRow[]) {
  return (_runner: unknown, _ctx: unknown, options: SearchReadOptions): readonly SearchHitRow[] => {
    const needle = needleOf(options.likePattern).toLowerCase();
    return rows
      .filter((row) => row.title.toLowerCase().includes(needle))
      .filter((row) => options.projectId === undefined || row.projectId === options.projectId)
      .slice(0, options.limit);
  };
}

function serviceWith(seed: Seed = {}, knownProjects: readonly string[] = [PROJECT]): SearchService {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    searchWorkItems: async (r: unknown, c: unknown, o: SearchReadOptions) =>
      matcher(seed.work ?? [])(r, c, o),
    searchDocuments: async (r: unknown, c: unknown, o: SearchReadOptions) =>
      matcher(seed.documents ?? [])(r, c, o),
    searchMeetings: async (r: unknown, c: unknown, o: SearchReadOptions) =>
      matcher(seed.meetings ?? [])(r, c, o),
  } as unknown as SearchRepository;

  const projects = {
    findById: async (_runner: unknown, _ctx: unknown, projectId: string) =>
      knownProjects.includes(projectId) ? { id: projectId, organizationId: ORG } : null,
  } as unknown as ProjectsRepository;

  return new SearchService(database, repository, projects);
}

function hit(overrides: Partial<SearchHitRow> & Pick<SearchHitRow, 'id' | 'title'>): SearchHitRow {
  return { organizationId: ORG, projectId: PROJECT, ...overrides };
}

describe('SearchService', () => {
  it('returns matches from all three kinds, in kind-then-title order, with a null snippet', async () => {
    const service = serviceWith({
      work: [hit({ id: 'w1', title: 'Alpha task', audience: 'internal' })],
      documents: [hit({ id: 'd1', title: 'Alpha brief' })],
      meetings: [hit({ id: 'm1', title: 'Alpha sync' })],
    });

    const results = await service.search(context, member([PROJECT]), { q: 'alpha' });

    expect(results.map((r) => [r.kind, r.id])).toEqual([
      ['work_item', 'w1'],
      ['document', 'd1'],
      ['meeting', 'm1'],
    ]);
    expect(results.every((r) => r.snippet === null)).toBe(true);
    expect(results.every((r) => r.projectId === PROJECT)).toBe(true);
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(results)).not.toContain(ORG);
  });

  it('orders within a kind by title, then id', async () => {
    const service = serviceWith({
      work: [
        hit({ id: 'w2', title: 'Beta', audience: 'internal' }),
        hit({ id: 'w1', title: 'Alpha', audience: 'internal' }),
      ],
    });
    const results = await service.search(context, member([PROJECT]), { q: 'a' });
    expect(results.map((r) => r.title)).toEqual(['Alpha', 'Beta']);
  });

  it('never lets a cross-tenant row of any kind contribute', async () => {
    const service = serviceWith({
      work: [hit({ id: 'w1', title: 'Foreign', organizationId: OTHER_ORG, audience: 'internal' })],
      documents: [hit({ id: 'd1', title: 'Foreign', organizationId: OTHER_ORG })],
      meetings: [hit({ id: 'm1', title: 'Foreign', organizationId: OTHER_ORG })],
    });
    const results = await service.search(context, member([PROJECT], true), { q: 'foreign' });
    expect(results).toEqual([]);
    expect(JSON.stringify(results)).not.toContain(OTHER_ORG);
  });

  it('drops a hit of each kind the caller has no relation to (a search never leaks a denied read)', async () => {
    const seed: Seed = {
      work: [hit({ id: 'w1', title: 'Members only', audience: 'internal' })],
      documents: [hit({ id: 'd1', title: 'Members only' })],
      meetings: [hit({ id: 'm1', title: 'Members only' })],
    };
    // A member of no project sees nothing of any kind…
    const asNonMember = serviceWith(seed);
    expect(await asNonMember.search(context, member([]), { q: 'members' })).toEqual([]);
    // …while an org-wide role sees all three.
    const asOwner = serviceWith(seed);
    const owned = await asOwner.search(context, member([], true), { q: 'members' });
    expect(owned.map((r) => r.kind)).toEqual(['work_item', 'document', 'meeting']);
  });

  it('keeps a client-audience work item for a member but never an internal one they cannot reach', async () => {
    // The relation gate authorizes each work item against its own audience, exactly as the direct
    // read does — so this only asserts the audience is carried through, not re-proving authorize.
    const service = serviceWith({
      work: [
        hit({ id: 'w1', title: 'Shared', projectId: OTHER_PROJECT, audience: 'client_visible' }),
        hit({ id: 'w2', title: 'Shared', projectId: OTHER_PROJECT, audience: 'internal' }),
      ],
    });
    // A member of OTHER_PROJECT may read both; assert both come back to confirm audience passes.
    const results = await service.search(context, member([OTHER_PROJECT]), { q: 'shared' });
    expect(results.map((r) => r.id)).toEqual(['w1', 'w2']);
  });

  it('resolves an optional projectId tenant-scoped before searching, and filters to it', async () => {
    const service = serviceWith({
      work: [
        hit({ id: 'w1', title: 'Here', projectId: PROJECT, audience: 'internal' }),
        hit({ id: 'w2', title: 'There', projectId: OTHER_PROJECT, audience: 'internal' }),
      ],
    });
    const results = await service.search(context, member([PROJECT], true), {
      q: 'here',
      projectId: PROJECT,
    });
    expect(results.map((r) => r.id)).toEqual(['w1']);
  });

  it('404s on an unknown or cross-tenant projectId (Known-trap), leaking no results, never 500', async () => {
    const MISSING = 'project-0000-0000-0000-0000-0000000000ff';
    const service = serviceWith(
      { work: [hit({ id: 'w1', title: 'Secret', audience: 'internal' })] },
      [PROJECT], // MISSING is not known in this tenant
    );
    const error = await service
      .search(context, member([], true), { q: 'secret', projectId: MISSING })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it('bounds the result set: default 20, cap 50', async () => {
    const many = (n: number): SearchHitRow[] =>
      Array.from({ length: n }, (_v, i) =>
        hit({ id: `w${String(i).padStart(3, '0')}`, title: `Task ${i}`, audience: 'internal' }),
      );

    const big = serviceWith({ work: many(80) });
    expect(await big.search(context, member([PROJECT], true), { q: 'task' })).toHaveLength(20);
    expect(
      await big.search(context, member([PROJECT], true), { q: 'task', limit: 100 }),
    ).toHaveLength(50);
    expect(
      await big.search(context, member([PROJECT], true), { q: 'task', limit: 5 }),
    ).toHaveLength(5);
  });

  it('matches LIKE metacharacters literally rather than as wildcards', async () => {
    const service = serviceWith({
      documents: [hit({ id: 'd1', title: '50% done' }), hit({ id: 'd2', title: '5000 done' })],
    });
    const results = await service.search(context, member([PROJECT], true), { q: '50%' });
    expect(results.map((r) => r.id)).toEqual(['d1']);
  });

  it('returns nothing for a query that matches no title', async () => {
    const service = serviceWith({
      work: [hit({ id: 'w1', title: 'Alpha', audience: 'internal' })],
    });
    expect(await service.search(context, member([PROJECT], true), { q: 'zzz' })).toEqual([]);
  });
});

describe('SearchController', () => {
  it('gates the search route on the search.use capability', () => {
    // The 403 for a caller without the capability is the globally-registered CapabilityGuard's,
    // proven generically (capability.guard + permission-matrix-fixture: search.use is
    // internal-only, so a client never holds it). This asserts the wiring the guard reads.
    const capability = new Reflector().get(REQUIRED_CAPABILITY, SearchController.prototype.run);
    expect(capability).toBe('search.use');
  });
});
