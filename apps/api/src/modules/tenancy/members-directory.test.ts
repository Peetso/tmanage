import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { CLIENT_ROLES, INTERNAL_ROLES, capabilitiesFor } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { analyzeStatement } from '../../common/database/tenant-guard.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { MembersController } from './members.controller.js';
import { MembershipsRepository } from './memberships.repository.js';

/**
 * D16's member directory: the read is tenant-scoped, and the route is internal-only.
 *
 * These run without a server, and the scoping assertion is not a re-reading of the source.
 * The statement Drizzle actually builds is captured off the runner and handed to
 * `analyzeStatement` — the production guard, the same function `TenantQueryRunner` calls
 * before any statement reaches a connection. A missing predicate, a literal instead of a
 * bound parameter, or a join that left `memberships` unanchored are each rejected by the
 * thing that would reject them in production, so a DB test would prove nothing further about
 * the SQL. (`test/tenant-isolation.db.test.ts` already proves the guard itself against real
 * rows, and `users` is already in its non-tenant registry.)
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

/**
 * A runner that records what it was asked to run and answers with `rows`.
 *
 * `rowsAsArray` is what `tenantDrizzle` asks the driver for, so the rows here are positional
 * — the same shape mysql2 hands back — and Drizzle's own column mapping is therefore on the
 * path under test rather than stubbed out.
 */
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

const repository = new MembershipsRepository();

describe('MembershipsRepository.listWithNames', () => {
  it('names each member, and issues a statement the tenant guard accepts', async () => {
    const captured: Captured[] = [];
    const membershipId = uuidv7();
    const userId = uuidv7();
    const { runner } = capturingRunner(captured, [
      [membershipId, userId, 'Priya Raman', 'manager', 'active'],
    ]);

    const rows = await repository.listWithNames(runner, contextFor(ORG));

    // The shape D16 asks for: an id the API keeps, and a name a person reads.
    expect(rows).toEqual([
      {
        membershipId,
        userId,
        displayName: 'Priya Raman',
        role: 'manager',
        status: 'active',
      },
    ]);

    const statement = captured[0];
    expect(statement).toBeDefined();
    // The join is there, and the tenant key is a bound parameter carrying the active org.
    expect(statement?.sql).toMatch(/join\s+`users`/i);
    expect(statement?.params).toContain(ORG);
    expect(statement?.sql).not.toContain(ORG);

    const analysis = analyzeStatement(statement?.sql ?? '', statement?.params ?? [], ORG);
    expect(analysis.violations, analysis.violations.join('\n')).toEqual([]);
    // `memberships` is the anchored side; `users` is global identity and carries no tenant key.
    expect(analysis.tenantTables).toContain('memberships');
    expect(analysis.tenantTables).not.toContain('users');
  });

  it('cannot serve an adjacent tenant: the guard rejects the same statement under another org', async () => {
    const captured: Captured[] = [];
    const { runner } = capturingRunner(captured, []);

    await repository.listWithNames(runner, contextFor(ORG));
    const statement = captured[0];

    // The statement's bound organization id is this tenant's. Analysed against a context for
    // a different organization — which is what a leaked or reused statement would be — the
    // guard refuses it, so the predicate is genuinely the active tenant's and not decoration.
    const crossTenant = analyzeStatement(statement?.sql ?? '', statement?.params ?? [], OTHER_ORG);
    expect(crossTenant.violations.length).toBeGreaterThan(0);
  });

  it('asks only for active members unless told otherwise, and pages on the membership id', async () => {
    const captured: Captured[] = [];
    const { runner } = capturingRunner(captured, []);
    const cursor = uuidv7();

    await repository.listWithNames(runner, contextFor(ORG), { after: cursor, limit: 2 });

    const statement = captured[0];
    expect(statement?.params).toEqual([ORG, 'active', cursor, 2]);
    expect(statement?.sql).toMatch(/order by\s+`memberships`\.`id`/i);
  });

  it('searches the name on the server, without letting go of the tenant', async () => {
    const captured: Captured[] = [];
    const { runner } = capturingRunner(captured, []);

    // A person typing into the picker. Without this the search happens on whatever page the
    // browser already holds, so the fifty-first member of an organization is unassignable.
    await repository.listWithNames(runner, contextFor(ORG), { q: 'Pri' });

    const statement = captured[0];
    expect(statement?.sql).toMatch(/like/i);
    // Bound, never interpolated: the typed text appears in the parameters and nowhere in the
    // SQL, which is also what keeps `%` a character somebody typed rather than a wildcard.
    expect(statement?.params).toContain('%Pri%');
    expect(statement?.sql).not.toContain('Pri');

    // And the search is still this tenant's search: narrowing by name cannot widen who is
    // reachable, so the guard must accept the statement exactly as it does without a `q`.
    expect(statement?.params).toContain(ORG);
    const analysis = analyzeStatement(statement?.sql ?? '', statement?.params ?? [], ORG);
    expect(analysis.violations, analysis.violations.join('\n')).toEqual([]);
    expect(
      analyzeStatement(statement?.sql ?? '', statement?.params ?? [], OTHER_ORG).violations.length,
    ).toBeGreaterThan(0);
  });
});

describe('GET /v1/organizations/:orgSlug/members', () => {
  const capability = Reflect.getMetadata(REQUIRED_CAPABILITY, MembersController.prototype.list) as
    Capability | undefined;

  it('declares a capability at all', () => {
    // `CapabilityGuard` refuses a tenant-scoped route that names none; this pins which one.
    expect(capability).toBe('work.read');
  });

  it('is open to every internal role and closed to every client role', () => {
    for (const role of INTERNAL_ROLES) {
      expect(capabilitiesFor(role), role).toContain(capability);
    }
    // The denial that matters: a client portal principal must never be handed the agency's
    // staff roster. `work.read` is held by no client role, so the refusal comes from the
    // capability ceiling rather than from a check this controller could forget to write.
    for (const role of CLIENT_ROLES) {
      expect(capabilitiesFor(role), role).not.toContain(capability);
    }
  });

  it('returns a cursor only when the page it sent back was full', async () => {
    const rows = [
      { membershipId: 'm-1', userId: 'u-1', displayName: 'Ada', role: 'member', status: 'active' },
      { membershipId: 'm-2', userId: 'u-2', displayName: 'Bo', role: 'guest', status: 'active' },
    ];
    const context = contextFor(ORG);
    const database = {
      read: <T>(_context: TenantContext, work: (db: never) => Promise<T>) =>
        work(undefined as never),
    };
    const memberships = {
      listWithNames: (_db: never, _context: TenantContext, options: { limit?: number }) =>
        Promise.resolve(rows.slice(0, options.limit ?? rows.length)),
    };
    const controller = new MembersController(
      database as never,
      memberships as unknown as MembershipsRepository,
    );

    const full = await controller.list(context, undefined, '2');
    expect(full.members).toEqual([
      { userId: 'u-1', displayName: 'Ada', role: 'member', status: 'active' },
      { userId: 'u-2', displayName: 'Bo', role: 'guest', status: 'active' },
    ]);
    // The membership id is the cursor and is not otherwise exposed.
    expect(full.nextAfter).toBe('m-2');

    const short = await controller.list(context, undefined, '50');
    expect(short.nextAfter).toBeNull();
  });
});
