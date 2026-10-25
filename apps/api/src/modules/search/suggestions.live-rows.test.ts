import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { analyzeStatement } from '../../common/database/tenant-guard.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { SuggestionsRepository } from './suggestions.repository.js';
import { SuggestionsService } from './suggestions.service.js';

/**
 * NV12 — typeahead reads the live rows, never the frozen `search_index` snapshot. The real
 * repository runs over a scripted runner (the statements are captured and handed to the
 * production tenant guard), and the service authorizes each candidate against the project the
 * live row names **now**: an item moved from A to C is not suggested to a member of A only.
 */

const ORG = uuidv7();
const PROJECT_A = uuidv7();
const PROJECT_C = uuidv7();

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const context: TenantContext = createTenantContext({
  organizationId: ORG,
  userId: uuidv7(),
  principalKind: 'internal',
  membershipId: uuidv7(),
  capabilities: [],
  policyVersion: 'test',
  correlationId: uuidv7(),
});

function memberOf(projectIds: readonly string[]): Principal {
  return {
    userId: context.userId,
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: context.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

/** Work-item rows first, document rows second — the repository's two statements, in order. */
function serviceOver(
  captured: Captured[],
  itemRows: readonly unknown[][],
  docRows: readonly unknown[][] = [],
): SuggestionsService {
  const answers = [itemRows, docRows];
  let next = 0;
  const respond = ((sql: string, params: readonly unknown[]) => {
    captured.push({ sql, params });
    const answer = answers[next] ?? [];
    next += 1;
    return Promise.resolve(answer);
  }) as unknown as TenantQueryRunner['query'];
  const runner = { query: respond, execute: respond } as unknown as TenantQueryRunner;
  const database = {
    read: async <T>(_c: unknown, work: (r: TenantQueryRunner) => Promise<T>) => work(runner),
  } as unknown as TenantDatabase;
  return new SuggestionsService(database, new SuggestionsRepository());
}

const UPDATED = new Date('2026-10-25T10:00:00.000Z');

describe('NV12: suggestions are checked against the live row', () => {
  it('reads work_items and documents, never search_index, and the guard accepts both', async () => {
    const captured: Captured[] = [];
    await serviceOver(captured, []).suggest(context, memberOf([PROJECT_A]), { q: 'Dummy' });
    expect(captured).toHaveLength(2);
    for (const statement of captured) {
      expect(statement.sql).not.toMatch(/search_index/i);
      const analysis = analyzeStatement(statement.sql, statement.params, ORG);
      expect(analysis.violations, analysis.violations.join('\n')).toEqual([]);
    }
    expect(captured[0]?.sql).toMatch(/from `work_items`/i);
    // A soft-deleted item is never a candidate.
    expect(captured[0]?.sql).toMatch(/`work_items`\.`deleted_at` is null/i);
    expect(captured[1]?.sql).toMatch(/from `documents`/i);
  });

  it('an item moved from A to C is not suggested to a member of A only', async () => {
    const moved = [uuidv7(), PROJECT_C, 'Dummy secret title', 'internal', UPDATED, null];
    const out = await serviceOver([], [moved]).suggest(context, memberOf([PROJECT_A]), {
      q: 'Dummy',
    });
    expect(out).toEqual([]);
  });

  it('a member of the item’s current project still gets the suggestion', async () => {
    const item = [uuidv7(), PROJECT_C, 'Dummy secret title', 'internal', UPDATED, null];
    const out = await serviceOver([], [item]).suggest(context, memberOf([PROJECT_C]), {
      q: 'Dummy',
    });
    expect(out).toEqual(['Dummy secret title']);
  });
});
