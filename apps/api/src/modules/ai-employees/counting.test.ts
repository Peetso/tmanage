import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { AdminOverviewRepository } from '../admin/overview.repository.js';
import { BillingSeatsRepository } from '../billing/seats.repository.js';
import { SubscriptionRepository } from '../billing/subscription.repository.js';
import { SignInPolicyRepository } from '../identity/sign-in-policy.repository.js';
import { InsightsAdoptionRepository } from '../insights/adoption.repository.js';
import { WorkloadForecastRepository } from '../insights/workload-forecast.repository.js';
import { PeopleDirectoryRepository } from '../people/directory.repository.js';
import { PeopleOverviewRepository } from '../people/people-overview.repository.js';
import { PersonTimeOffRepository } from '../people/time-off.repository.js';
import { ORG_SQL } from '../platform-admin/organizations/organizations.repository.js';
import { OrgWorkloadRepository } from '../work-views/org-workload.repository.js';

/**
 * 60-09, security test 16 (plan 60 v2 §5): adding an AI employee changes no seat count,
 * headcount, capacity or time-off figure.
 *
 * An AI employee is a `memberships` row with `kind = 'ai'`. Every read that counts or lists people
 * for a seat, a headcount, capacity, time off or the bill must therefore carry `kind = 'human'`.
 * These run without a server: each repository's statement is captured off the runner, exactly as
 * it would reach the connection, and must name the predicate with the value bound (or, for the
 * raw-SQL reads, written as the literal). The DB form of the same test is
 * `apps/api/test/t-60-09-ai-employees-not-counted.db.test.ts`; the 422 refusals (capacity, teams,
 * reporting lines) are tested beside their controllers.
 */

const ORG = uuidv7();

function context(): TenantContext {
  return createTenantContext({
    organizationId: ORG,
    userId: uuidv7(),
    principalKind: 'internal',
    membershipId: uuidv7(),
    capabilities: [],
    policyVersion: 'test',
    correlationId: uuidv7(),
  });
}

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function capturingRunner(captured: Captured[]): TenantQueryRunner {
  const respond = ((sql: string, params: readonly unknown[] = []) => {
    captured.push({ sql, params });
    return Promise.resolve([]);
  }) as unknown as TenantQueryRunner['query'];
  return {
    query: respond,
    execute: respond as unknown as TenantQueryRunner['execute'],
    unscoped: () => ({
      query: respond,
      execute: respond as unknown as TenantQueryRunner['execute'],
    }),
  };
}

/** The statements a read sends. An empty answer may make a read throw after it sent them. */
async function statementsOf(
  read: (runner: TenantQueryRunner, context: TenantContext) => Promise<unknown>,
): Promise<readonly Captured[]> {
  const captured: Captured[] = [];
  await read(capturingRunner(captured), context()).catch(() => undefined);
  return captured;
}

const BOUND_KIND = /`memberships`\.`kind`\s*=\s*\?/u;

/** A Drizzle statement on `memberships` that binds `kind` to `value`. */
function bindsKind(statement: Captured, value: 'human' | 'ai'): boolean {
  if (!BOUND_KIND.test(statement.sql)) return false;
  return statement.params.includes(value);
}

const PEOPLE_READS: readonly {
  readonly name: string;
  readonly read: (runner: TenantQueryRunner, context: TenantContext) => Promise<unknown>;
}[] = [
  {
    name: 'billing: the people on the bill',
    read: (r, c) => new SubscriptionRepository().countInternalPeople(r, c),
  },
  {
    name: 'billing: the membership a seat is assigned to',
    read: (r, c) => new BillingSeatsRepository().findMembership(r, c, uuidv7()),
  },
  {
    name: 'admin overview: seats used and active members',
    read: (r, c) => new AdminOverviewRepository().listSeatMemberships(r, c),
  },
  {
    name: 'insights: the adoption headcount',
    read: (r, c) => new InsightsAdoptionRepository().listActiveMembers(r, c),
  },
  {
    name: 'people: the overview roster (headcount and capacity)',
    read: (r, c) => new PeopleOverviewRepository().roster(r, c),
  },
  {
    name: 'people: the directory list',
    read: (r, c) => new PeopleDirectoryRepository().list(r, c, { limit: 10 }),
  },
  {
    name: 'people: the person time off is booked for',
    read: (r, c) => new PersonTimeOffRepository().resolvePersonMembership(r, c, uuidv7()),
  },
  {
    name: 'work views: the org workload members (capacity)',
    read: (r, c) =>
      new OrgWorkloadRepository().listInternalMembers(r, c, { afterMembershipId: null, limit: 5 }),
  },
];

describe('60-09 security test 16: an AI employee is never counted as a person', () => {
  for (const { name, read } of PEOPLE_READS) {
    it(`${name} reads people only (kind = 'human', bound)`, async () => {
      const statements = await statementsOf(read);
      expect(statements.length).toBeGreaterThan(0);
      const onMemberships = statements.filter((s) => /from\s+`memberships`/iu.test(s.sql));
      expect(onMemberships.length, 'the read names memberships').toBeGreaterThan(0);
      for (const statement of onMemberships) {
        expect(bindsKind(statement, 'human'), statement.sql).toBe(true);
      }
    });
  }

  it('the workload forecast finds AI employees by kind, so their work adds no capacity', async () => {
    const statements = await statementsOf((r, c) =>
      new WorkloadForecastRepository().aiUserIds(r, c),
    );
    expect(statements.some((s) => bindsKind(s, 'ai'))).toBe(true);
  });

  it('a sign-in policy counts only people it could lock out', async () => {
    const statements = await statementsOf((r, c) =>
      new SignInPolicyRepository().countMembersWithout(r, c, ['google']),
    );
    const internal = statements.find((s) => /from\s+memberships\s+m/iu.test(s.sql));
    expect(internal?.sql).toMatch(/m\.kind\s*=\s*'human'/u);
  });

  it('the platform organizations list counts people, not AI employees, against the people limit', () => {
    const people = /\(select count\(\*\) from memberships m([\s\S]*?)\) as people/u.exec(
      ORG_SQL.one,
    );
    expect(people?.[1]).toMatch(/m\.kind\s*=\s*'human'/u);
  });
});
