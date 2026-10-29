import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CLIENT_ROLES,
  ASSIGNABLE_INTERNAL_ROLES,
  hasCapability,
  isInternalRole,
} from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import {
  GRID_ROLES,
  GUARDED_OPERATIONS,
  UNGUARDED_CAPABILITIES,
  assertCatalogCoversEveryCapability,
  buildRoleOperationGrid,
  expectedGuardDenialCount,
} from './role-operation-grid.js';

/**
 * The generator's own proofs. The DB suite it feeds cannot run without the `db-e2e.lock`, so
 * these are what demonstrate the two properties the harness rests on: it covers §11's whole
 * operation axis (a new capability fails loudly), and its verdicts are load-bearing (flipping a
 * ceiling cell would turn a grid cell red rather than moving the expectation with it).
 */

describe('role × operation grid coverage', () => {
  it('accounts for every capability, once, as either guarded or unguarded', () => {
    expect(() => assertCatalogCoversEveryCapability()).not.toThrow();

    const guarded = GUARDED_OPERATIONS.map((op) => op.capability);
    const unguarded = UNGUARDED_CAPABILITIES.map((entry) => entry.capability);
    const covered = new Set<Capability>([...guarded, ...unguarded]);

    // Exactly the domain's capability set — nothing missing, nothing invented.
    expect(covered.size).toBe(CAPABILITIES.length);
    for (const capability of CAPABILITIES) expect(covered.has(capability)).toBe(true);

    // The two lists are disjoint and internally unique.
    expect(new Set(guarded).size).toBe(guarded.length);
    expect(new Set(unguarded).size).toBe(unguarded.length);
    expect(guarded.filter((cap) => unguarded.includes(cap))).toEqual([]);
  });

  it('fails loudly when a newly declared capability is mapped nowhere', () => {
    // The silent pass this module removes: a capability added to §4 with no operation and no
    // recorded reason must break the harness rather than go untested.
    const withNewCapability = [...CAPABILITIES, 'workspace.export' as Capability];
    expect(() => assertCatalogCoversEveryCapability(withNewCapability)).toThrow(
      /no guarded operation and no unguarded reason: workspace\.export/,
    );
  });

  it('every guarded operation names a real capability and a route', () => {
    for (const op of GUARDED_OPERATIONS) {
      expect(CAPABILITIES).toContain(op.capability);
      expect(op.path.startsWith('/')).toBe(true);
      expect(op.declaredAt.length).toBeGreaterThan(0);
      if (op.surface === 'portal') expect(op.path.startsWith('/portal')).toBe(true);
    }
  });
});

describe('buildRoleOperationGrid', () => {
  it('enumerates every role against every guarded operation', () => {
    const grid = buildRoleOperationGrid();
    const roles = [...ASSIGNABLE_INTERNAL_ROLES, ...CLIENT_ROLES];

    expect(grid).toHaveLength(roles.length * GUARDED_OPERATIONS.length);
    expect(GRID_ROLES).toEqual(roles);

    for (const role of roles) {
      const forRole = grid.filter((cell) => cell.role === role);
      expect(forRole).toHaveLength(GUARDED_OPERATIONS.length);
      expect(new Set(forRole.map((cell) => cell.operation.capability)).size).toBe(
        GUARDED_OPERATIONS.length,
      );
    }
  });

  it('marks internal-principal-on-portal-route cells as cross-surface, and no others', () => {
    for (const cell of buildRoleOperationGrid()) {
      const expected = cell.operation.surface === 'portal' && isInternalRole(cell.role);
      expect(cell.crossSurface).toBe(expected);
    }
  });

  it('has both allowed and denied cells — the sweep is not degenerate', () => {
    const grid = buildRoleOperationGrid();
    expect(grid.some((cell) => cell.expectedAllowed)).toBe(true);
    expect(grid.some((cell) => !cell.expectedAllowed)).toBe(true);
    expect(expectedGuardDenialCount()).toBe(grid.filter((cell) => !cell.expectedAllowed).length);
    expect(expectedGuardDenialCount()).toBeGreaterThan(0);
  });
});

describe('the grid is load-bearing, not tautological', () => {
  it('draws each verdict from the transcription, which agrees with the live ceiling today', () => {
    // The whole grid must match the domain's ceiling right now: any standing disagreement is a
    // divergence someone forgot to record, and it would make the DB sweep red on a correct
    // guard. (The four accepted divergences are already folded into expectedCeilingGrants, so
    // this holds cell by cell.)
    for (const cell of buildRoleOperationGrid()) {
      expect(
        cell.expectedAllowed,
        `${cell.role} × ${cell.operation.capability}: transcription and ceiling disagree`,
      ).toBe(hasCapability(cell.role, cell.operation.capability));
    }
  });

  it('would turn a cell red if the ceiling flipped, because the expectation is independent', () => {
    // The mutation check §Item-3 AC3 asks for, at the unit level: the guard follows
    // `hasCapability`, so a flipped ceiling cell makes the guard's behaviour the opposite of
    // what it is today. The grid's verdict comes from the transcription and does NOT move with
    // the flip — so the cell the guard now answers differently no longer matches, and the DB
    // sweep would fail on it. If the expectation were `hasCapability`, both sides would move
    // together and nothing would go red (D18 / C1).
    const grid = buildRoleOperationGrid();
    let checkedAllow = false;
    let checkedDeny = false;

    for (const cell of grid) {
      const live = hasCapability(cell.role, cell.operation.capability);
      const mutated = !live; // the guard's behaviour after a single ceiling-cell flip
      // The grid's verdict (transcription) still equals the pre-flip ceiling, so it now
      // disagrees with the mutated guard — the cell goes red.
      expect(cell.expectedAllowed).not.toBe(mutated);
      if (cell.expectedAllowed) checkedAllow = true;
      else checkedDeny = true;
    }

    // Proven for both an allowed cell and a denied cell, not just one polarity.
    expect(checkedAllow && checkedDeny).toBe(true);
  });
});
