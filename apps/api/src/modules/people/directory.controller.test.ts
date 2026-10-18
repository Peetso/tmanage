import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { CLIENT_ROLES, INTERNAL_ROLES, capabilitiesFor } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { analyzeStatement } from '../../common/database/tenant-guard.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { PeopleDirectoryController } from './directory.controller.js';
import { PeopleDirectoryRepository } from './directory.repository.js';

/**
 * People & capacity (module 14, audit #4). The read is tenant-scoped and internal-only, and the
 * project count is counted from this tenant's own rows.
 *
 * These run without a server. The scoping assertion is not a re-reading of the source: the
 * statement Drizzle actually builds is captured off the runner and handed to `analyzeStatement`
 * — the production guard, the same function `TenantQueryRunner` calls before any statement
 * reaches a connection — so a missing predicate, an inline literal, or a `project_memberships`
 * join left unanchored is rejected by the thing that would reject it in production.
 */

const ORG = uuidv7();
const OTHER_ORG = uuidv7();

function contextFor(organizationId: string): TenantContext {
  return createTenantContext({
    organizationId,
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

function capturingRunner(
  captured: Captured[],
  rows: readonly unknown[][],
): { runner: TenantQueryRunner } {
  const respond = ((sql: string, params: readonly unknown[]) => {
    captured.push({ sql, params });
    return Promise.resolve(rows);
  }) as unknown as TenantQueryRunner['query'];

  return {
    runner: {
      query: respond,
      execute: respond as unknown as TenantQueryRunner['execute'],
      unscoped: () => ({
        query: respond,
        execute: respond as unknown as TenantQueryRunner['execute'],
      }),
    },
  };
}

const repository = new PeopleDirectoryRepository();

describe('PeopleDirectoryRepository.list', () => {
  it('names each person with a project count, in a statement the tenant guard accepts', async () => {
    const captured: Captured[] = [];
    const membershipId = uuidv7();
    const userId = uuidv7();
    const { runner } = capturingRunner(captured, [
      [membershipId, userId, 'Priya Raman', 'manager', 'active', 3],
    ]);

    const rows = await repository.list(runner, contextFor(ORG));
    expect(rows).toEqual([
      {
        membershipId,
        userId,
        displayName: 'Priya Raman',
        role: 'manager',
        status: 'active',
        projectCount: 3,
      },
    ]);

    const statement = captured[0];
    expect(statement).toBeDefined();
    // The name join and the project-count join are both there, and the tenant key is a bound
    // parameter carrying the active org rather than an inlined literal.
    expect(statement?.sql).toMatch(/join\s+`users`/i);
    expect(statement?.sql).toMatch(/join\s+`project_memberships`/i);
    expect(statement?.params).toContain(ORG);
    expect(statement?.sql).not.toContain(ORG);

    const analysis = analyzeStatement(statement?.sql ?? '', statement?.params ?? [], ORG);
    expect(analysis.violations, analysis.violations.join('\n')).toEqual([]);
    // `memberships` and `project_memberships` are anchored tenant tables; `users` is global.
    expect(analysis.tenantTables).toContain('memberships');
    expect(analysis.tenantTables).toContain('project_memberships');
    expect(analysis.tenantTables).not.toContain('users');
  });

  it('cannot serve an adjacent tenant: the same statement is refused under another org', async () => {
    const captured: Captured[] = [];
    const { runner } = capturingRunner(captured, []);
    await repository.list(runner, contextFor(ORG));

    const crossTenant = analyzeStatement(
      captured[0]?.sql ?? '',
      captured[0]?.params ?? [],
      OTHER_ORG,
    );
    expect(crossTenant.violations.length).toBeGreaterThan(0);
  });

  it('searches the name on the server and bounds the fragment, without letting go of the tenant', async () => {
    const captured: Captured[] = [];
    const { runner } = capturingRunner(captured, []);

    await repository.list(runner, contextFor(ORG), { q: 'Pri', limit: 2 });

    const statement = captured[0];
    expect(statement?.sql).toMatch(/like/i);
    // Bound, never interpolated — which is also what keeps `%` a typed character, not a wildcard.
    expect(statement?.params).toContain('%Pri%');
    expect(statement?.sql).not.toContain('Pri');
    expect(statement?.params).toContain(ORG);

    const analysis = analyzeStatement(statement?.sql ?? '', statement?.params ?? [], ORG);
    expect(analysis.violations, analysis.violations.join('\n')).toEqual([]);
    expect(
      analyzeStatement(statement?.sql ?? '', statement?.params ?? [], OTHER_ORG).violations.length,
    ).toBeGreaterThan(0);
  });
});

describe('GET /v1/organizations/:orgSlug/people', () => {
  const capability = Reflect.getMetadata(
    REQUIRED_CAPABILITY,
    PeopleDirectoryController.prototype.list,
  ) as Capability | undefined;

  it('is behind work.read — open to every internal role, closed to every client role', () => {
    // `CapabilityGuard` refuses a tenant-scoped route that names none; this pins which one.
    expect(capability).toBe('work.read');
    for (const role of INTERNAL_ROLES) expect(capabilitiesFor(role), role).toContain(capability);
    // The denial that matters: no client role holds `work.read`, so the portal can never be
    // handed the agency's staff roster — the refusal is the capability ceiling's, not a check
    // this controller could forget to write.
    for (const role of CLIENT_ROLES) expect(capabilitiesFor(role), role).not.toContain(capability);
  });

  it('projects name/role/status/count, hides the cursor, and returns nextAfter only when full', async () => {
    const rows = [
      {
        membershipId: 'm-1',
        userId: 'u-1',
        displayName: 'Ada',
        role: 'member',
        status: 'active',
        projectCount: 2,
      },
      {
        membershipId: 'm-2',
        userId: 'u-2',
        displayName: 'Bo',
        role: 'guest',
        status: 'active',
        projectCount: 0,
      },
    ];
    const context = contextFor(ORG);
    const database = {
      read: <T>(_context: TenantContext, work: (db: never) => Promise<T>) =>
        work(undefined as never),
    };
    const directory = {
      list: (_db: never, _context: TenantContext, options: { limit?: number }) =>
        Promise.resolve(rows.slice(0, options.limit ?? rows.length)),
      rowDetails: () =>
        Promise.resolve(
          new Map([
            [
              'm-1',
              {
                teams: [{ id: 't-1', name: 'Design' }],
                openCommitments: 6,
                overdueCommitments: 1,
                declared: { kind: 'vacation', startDate: '2026-10-22', endDate: '2026-10-23' },
              },
            ],
          ]),
        ),
    };
    const controller = new PeopleDirectoryController(
      database as never,
      directory as unknown as PeopleDirectoryRepository,
    );

    const full = await controller.list(context, undefined, '2');
    expect(full.people).toEqual([
      {
        membershipId: 'm-1',
        userId: 'u-1',
        displayName: 'Ada',
        role: 'member',
        status: 'active',
        projectCount: 2,
        teams: [{ id: 't-1', name: 'Design' }],
        openCommitments: 6,
        overdueCommitments: 1,
        declared: { kind: 'vacation', startDate: '2026-10-22', endDate: '2026-10-23' },
      },
      // No details row: no team, nothing owned, nothing declared � never invented.
      {
        membershipId: 'm-2',
        userId: 'u-2',
        displayName: 'Bo',
        role: 'guest',
        status: 'active',
        projectCount: 0,
        teams: [],
        openCommitments: 0,
        overdueCommitments: 0,
        declared: null,
      },
    ]);
    // The membership id is the cursor and the profile link (PEO-02 routes on it).
    expect(full.nextAfter).toBe('m-2');

    const short = await controller.list(context, undefined, '50');
    expect(short.nextAfter).toBeNull();
  });

  it('refuses a non-positive limit with a 400 rather than a silent default', async () => {
    const controller = new PeopleDirectoryController({} as never, {} as never);
    await expect(controller.list(contextFor(ORG), undefined, '0')).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('PeopleDirectoryRepository.rowDetails', () => {
  it('reads teams, open work and declared availability in tenant-bound statements', async () => {
    const captured: Captured[] = [];
    const { runner } = capturingRunner(captured, []);
    const member = { membershipId: uuidv7(), userId: uuidv7() };
    const details = await repository.rowDetails(runner, contextFor(ORG), [member], {
      now: new Date(Date.UTC(2026, 9, 18)),
      fromDate: '2026-10-18',
      toDate: '2026-10-31',
    });

    expect(captured).toHaveLength(3);
    for (const statement of captured) {
      const analysis = analyzeStatement(statement.sql, statement.params, ORG);
      expect(analysis.violations, analysis.violations.join('\n')).toEqual([]);
      const crossTenant = analyzeStatement(statement.sql, statement.params, OTHER_ORG);
      expect(crossTenant.violations.length).toBeGreaterThan(0);
    }
    expect(details.get(member.membershipId)).toEqual({
      teams: [],
      openCommitments: 0,
      overdueCommitments: 0,
      declared: null,
    });
  });

  it('reads nothing for an empty page', async () => {
    const captured: Captured[] = [];
    const { runner } = capturingRunner(captured, []);
    const details = await repository.rowDetails(runner, contextFor(ORG), [], {
      now: new Date(),
      fromDate: '2026-10-18',
      toDate: '2026-10-31',
    });
    expect(details.size).toBe(0);
    expect(captured).toHaveLength(0);
  });
});
