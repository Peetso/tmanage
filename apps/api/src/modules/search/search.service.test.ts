import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { SearchService } from './search.service.js';
import { SearchController } from './search.controller.js';
import type {
  SearchIndexHitRow,
  SearchIndexRepository,
  SearchRankedOptions,
} from './search-index.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * SRCH ranking (x148) service proofs, database-free over the module's fakes. The FULLTEXT
 * `MATCH … AGAINST` ranking itself (relevance, then `updated_at`) is a MySQL feature proven by the
 * chain's DB suites — no DB test in-slice. Here the subject is the service's own logic: that it
 * preserves the repository's ranked order (the relation filter only *drops* rows, never reorders),
 * the cross-tenant exclusion, the relation gate that never surfaces a denied read, the audience
 * carry-through, the Known-trap `projectId` resolution, and the bound.
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

/**
 * The fake returns its seeded rows in the order given — that order *is* the repository's ranking
 * (relevance, then recency), so asserting the service preserves it is the unit-level proxy for
 * "ordered by relevance then updated_at". It applies only the optional projectId filter and bound,
 * never a re-sort and never the tenant scope (so a cross-tenant row reaches the relation gate).
 */
function serviceWith(
  ranked: readonly SearchIndexHitRow[] = [],
  knownProjects: readonly string[] = [PROJECT],
): SearchService {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    searchRanked: async (
      _r: unknown,
      _c: unknown,
      options: SearchRankedOptions,
    ): Promise<readonly SearchIndexHitRow[]> =>
      ranked
        .filter((row) => options.projectId === undefined || row.projectId === options.projectId)
        .slice(0, options.limit),
  } as unknown as SearchIndexRepository;

  const projects = {
    findById: async (_runner: unknown, _ctx: unknown, projectId: string) =>
      knownProjects.includes(projectId) ? { id: projectId, organizationId: ORG } : null,
  } as unknown as ProjectsRepository;

  return new SearchService(database, repository, projects);
}

function hit(
  overrides: Partial<SearchIndexHitRow> &
    Pick<SearchIndexHitRow, 'targetId' | 'title' | 'targetKind'>,
): SearchIndexHitRow {
  return { organizationId: ORG, projectId: PROJECT, audience: 'internal', ...overrides };
}

describe('SearchService (ranked)', () => {
  it('preserves the repository ranking order and projects a null snippet, never echoing the tenant id', async () => {
    const service = serviceWith([
      hit({ targetKind: 'document', targetId: 'd1', title: 'Most relevant' }),
      hit({ targetKind: 'work_item', targetId: 'w1', title: 'Next', audience: 'internal' }),
    ]);

    const results = await service.search(context, member([PROJECT]), { q: 'alpha' });

    // Order is the server's ranking — the relation filter drops, it never reorders.
    expect(results.map((r) => [r.kind, r.id])).toEqual([
      ['document', 'd1'],
      ['work_item', 'w1'],
    ]);
    expect(results.every((r) => r.snippet === null)).toBe(true);
    expect(JSON.stringify(results)).not.toContain(ORG);
  });

  it('never lets a cross-tenant row contribute', async () => {
    const service = serviceWith([
      hit({ targetKind: 'work_item', targetId: 'w1', title: 'Foreign', organizationId: OTHER_ORG }),
    ]);
    const results = await service.search(context, member([PROJECT], true), { q: 'foreign' });
    expect(results).toEqual([]);
    expect(JSON.stringify(results)).not.toContain(OTHER_ORG);
  });

  it('drops a hit the caller has no relation to (a search never leaks a denied read)', async () => {
    const seed = [hit({ targetKind: 'work_item', targetId: 'w1', title: 'Members only' })];
    // A member of no project sees nothing…
    expect(await serviceWith(seed).search(context, member([]), { q: 'members' })).toEqual([]);
    // …while an org-wide role sees it.
    const owned = await serviceWith(seed).search(context, member([], true), { q: 'members' });
    expect(owned.map((r) => r.id)).toEqual(['w1']);
  });

  it('authorizes each hit against its own audience (a client-visible item is reachable)', async () => {
    const service = serviceWith([
      hit({
        targetKind: 'work_item',
        targetId: 'w1',
        title: 'Shared',
        projectId: OTHER_PROJECT,
        audience: 'client_visible',
      }),
    ]);
    const results = await service.search(context, member([OTHER_PROJECT]), { q: 'shared' });
    expect(results.map((r) => r.id)).toEqual(['w1']);
  });

  it('resolves an optional projectId tenant-scoped before searching, and filters to it', async () => {
    const service = serviceWith([
      hit({ targetKind: 'work_item', targetId: 'w1', title: 'Here', projectId: PROJECT }),
      hit({ targetKind: 'work_item', targetId: 'w2', title: 'There', projectId: OTHER_PROJECT }),
    ]);
    const results = await service.search(context, member([PROJECT], true), {
      q: 'here',
      projectId: PROJECT,
    });
    expect(results.map((r) => r.id)).toEqual(['w1']);
  });

  it('404s on an unknown or cross-tenant projectId (Known-trap), leaking no results, never 500', async () => {
    const MISSING = 'project-0000-0000-0000-0000-0000000000ff';
    const service = serviceWith(
      [hit({ targetKind: 'work_item', targetId: 'w1', title: 'Secret' })],
      [PROJECT], // MISSING is not known in this tenant
    );
    const error = await service
      .search(context, member([], true), { q: 'secret', projectId: MISSING })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it('bounds the result set: default 20, cap 50', async () => {
    const many = (n: number): SearchIndexHitRow[] =>
      Array.from({ length: n }, (_v, i) =>
        hit({
          targetKind: 'work_item',
          targetId: `w${String(i).padStart(3, '0')}`,
          title: `Task ${i}`,
        }),
      );

    const big = serviceWith(many(80));
    expect(await big.search(context, member([PROJECT], true), { q: 'task' })).toHaveLength(20);
    expect(
      await big.search(context, member([PROJECT], true), { q: 'task', limit: 100 }),
    ).toHaveLength(50);
    expect(
      await big.search(context, member([PROJECT], true), { q: 'task', limit: 5 }),
    ).toHaveLength(5);
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
