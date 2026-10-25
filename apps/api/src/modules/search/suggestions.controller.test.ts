import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { SuggestionsService } from './suggestions.service.js';
import { SuggestionsController } from './suggestions.controller.js';
import type { SuggestCandidateRow, SuggestionsRepository } from './suggestions.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * SRCH suggestions (x289) proofs, database-free over a fake tenant database. The prefix `LIKE` and
 * the tenant `WHERE organization_id` predicate themselves are MySQL the chain's DB suites own — no
 * DB test in-slice. Here the subject is the service's own logic: the relation gate that never
 * suggests a title the caller's own read would deny (the required refusal — a cross-tenant candidate
 * that reaches the gate is dropped, so a prefix matching only another tenant's rows returns []),
 * de-duplication of shared titles, the recency-preserving order, the bound, and the blank-prefix
 * short-circuit. The controller's capability gate and limit validation round it out.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';

type Candidate = SuggestCandidateRow;

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
 * The fake repository returns its seeded candidates verbatim — deliberately NOT applying the tenant
 * scope the real SQL applies, so a cross-tenant row reaches the service's relation gate and must be
 * dropped. The fake `read` just runs the work against a stub runner.
 */
function serviceWith(candidates: readonly Candidate[]): SuggestionsService {
  const database = {
    read: async <T>(_ctx: unknown, work: (runner: unknown) => Promise<T>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    suggestByPrefix: async () => candidates,
  } as unknown as SuggestionsRepository;
  return new SuggestionsService(database, repository);
}

function candidate(overrides: Partial<Candidate> & Pick<Candidate, 'title'>): Candidate {
  return {
    organizationId: ORG,
    projectId: PROJECT,
    audience: 'internal',
    lifecycle: 'active',
    ...overrides,
  };
}

describe('SuggestionsService (x289)', () => {
  it('drops a cross-tenant candidate: a prefix matching only another tenant returns []', async () => {
    const service = serviceWith([
      candidate({ title: 'Foreign roadmap', organizationId: OTHER_ORG }),
    ]);
    const out = await service.suggest(context, member([PROJECT], true), { q: 'Fore' });
    expect(out).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(OTHER_ORG);
  });

  it('drops a candidate the caller has no relation to, keeps one it can read', async () => {
    const seed = [candidate({ title: 'Members only' })];
    expect(await serviceWith(seed).suggest(context, member([]), { q: 'Mem' })).toEqual([]);
    expect(await serviceWith(seed).suggest(context, member([], true), { q: 'Mem' })).toEqual([
      'Members only',
    ]);
  });

  it('de-duplicates titles, preserves order and bounds the list', async () => {
    const service = serviceWith([
      candidate({ title: 'Alpha plan' }),
      candidate({ title: 'Alpha plan' }),
      candidate({ title: 'Alpha review' }),
    ]);
    expect(await service.suggest(context, member([PROJECT], true), { q: 'Alpha' })).toEqual([
      'Alpha plan',
      'Alpha review',
    ]);
    expect(
      await service.suggest(context, member([PROJECT], true), { q: 'Alpha', limit: 1 }),
    ).toEqual(['Alpha plan']);
  });

  it('returns [] for a blank prefix without reading', async () => {
    let read = false;
    const database = {
      read: async () => {
        read = true;
        return [];
      },
    } as unknown as TenantDatabase;
    expect(
      await new SuggestionsService(database).suggest(context, member([PROJECT]), { q: '  ' }),
    ).toEqual([]);
    expect(read).toBe(false);
  });
});

describe('SuggestionsController (x289)', () => {
  it('gates the suggest route on the search.use capability', () => {
    const capability = new Reflector().get(
      REQUIRED_CAPABILITY,
      SuggestionsController.prototype.run,
    );
    expect(capability).toBe('search.use');
  });

  it('rejects a non-integer or out-of-range limit with a 400, and empties a blank prefix', async () => {
    const controller = new SuggestionsController(undefined, serviceWith([]));
    await expect(controller.run(context, member([PROJECT]), 'a', 'lots')).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(controller.run(context, member([PROJECT]), 'a', '999')).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(await controller.run(context, member([PROJECT]), '   ')).toEqual({ suggestions: [] });
  });
});
