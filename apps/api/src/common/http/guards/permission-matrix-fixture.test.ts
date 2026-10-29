import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_CEILING_DIVERGENCES,
  PERMISSION_MATRIX,
  expectedCeilingFor,
} from '@tmanage/test-kit';
import { CAPABILITIES, CLIENT_ROLES, INTERNAL_ROLES, capabilitiesFor } from '@tmanage/domain';
import type { Capability, Role } from '@tmanage/domain';

/**
 * The anti-rot guard for `@tmanage/test-kit`'s hand-written permission matrix.
 *
 * ## What this file is for
 *
 * `packages/test-kit/src/permission-matrix.ts` is a human's transcription of
 * `12-PERMISSION-MATRIX.md` §2. Three suites — the §11 role grid, the worker's triage
 * recipient rule, and the membership resolver's context — now take their expected answers
 * from that transcription instead of from `hasCapability` / `capabilitiesFor`, which is what
 * makes them able to fail when the ceiling widens (findings C1, C2, C3).
 *
 * A hand-written fixture has one failure mode of its own: it rots. Somebody edits
 * `CAPABILITY_CEILING`, three suites go red, and the quickest way to green is to edit the
 * fixture to match. This file exists to make that a conscious act rather than a convenient
 * one. It is the **only** place in the repository where the fixture and the product's ceiling
 * are compared, and when it fails it fails loudly and says nothing about which side is right,
 * because that is a question for a person:
 *
 * - the ceiling drifted → fix `packages/domain/src/policies/capabilities.ts`;
 * - the matrix document changed → fix the fixture, and cite the change;
 * - the difference is deliberate and accepted → add an entry to
 *   `ACCEPTED_CEILING_DIVERGENCES` saying so, in writing, with a reason.
 *
 * What it must never do is compute the expectation from the thing it is checking. There is no
 * auto-correction here and there must never be one.
 *
 * ## Why it lives in the API's unit project
 *
 * `packages/test-kit`'s own `tsconfig.json` excludes `*.test.ts` from typecheck, and its
 * tests are outside every gate named in the slice rules. Here the guard is compiled by
 * `pnpm --filter @tmanage/api typecheck` and executed by
 * `pnpm --filter @tmanage/api test -- --project unit`, next to the capability guard whose
 * ceiling it is about.
 */

const ALL_ROLES: readonly Role[] = [...INTERNAL_ROLES, ...CLIENT_ROLES];

function sorted(capabilities: readonly Capability[]): readonly Capability[] {
  return [...capabilities].sort();
}

describe('the hand-written permission matrix is complete', () => {
  it('covers every role, and only the roles the domain has', () => {
    expect(sorted(Object.keys(PERMISSION_MATRIX) as Capability[])).toEqual(
      sorted(ALL_ROLES as unknown as Capability[]),
    );
    // PA-01: eleven roles of `12-PERMISSION-MATRIX` §2 plus the hidden `platform_support`.
    expect(ALL_ROLES).toHaveLength(12);
  });

  for (const role of [...INTERNAL_ROLES, ...CLIENT_ROLES]) {
    it(`states an answer for every capability for '${role}', exactly once`, () => {
      // Both directions are written out by hand, so a capability added to `CAPABILITIES`
      // without a line in the fixture fails here rather than defaulting to denied — which
      // is the difference between "the matrix says no" and "nobody transcribed it".
      const { granted, denied } = PERMISSION_MATRIX[role];
      const stated = [...granted, ...denied];
      expect(new Set(stated).size, `${role}: a capability is listed twice`).toBe(stated.length);
      expect(sorted(stated), `${role}: granted ∪ denied is not the capability list`).toEqual(
        sorted(CAPABILITIES),
      );
    });
  }
});

describe('the hand-written permission matrix agrees with the shipped ceiling', () => {
  for (const role of [...INTERNAL_ROLES, ...CLIENT_ROLES]) {
    it(`'${role}' holds exactly what the matrix document says it holds`, () => {
      // THE assertion this whole fixture exists for. If it fails, do not edit either side
      // until a person has decided which one is wrong — see this file's header.
      expect(
        sorted(capabilitiesFor(role)),
        `The ceiling for '${role}' and the hand-written transcription of ` +
          `12-PERMISSION-MATRIX.md §2 disagree. This is a decision for a person, not a fix: ` +
          `read §2, decide which side is wrong, and either correct the ceiling, correct ` +
          `packages/test-kit/src/permission-matrix.ts, or record the difference in ` +
          `ACCEPTED_CEILING_DIVERGENCES with a reason.`,
      ).toEqual(sorted(expectedCeilingFor(role)));
    });
  }
});

describe('PA-01: the matrix capabilities are transcribed for every role', () => {
  it('has 56 capabilities: the 32 of §2 and the 24 of the platform-admin SPEC §3.3', () => {
    expect(CAPABILITIES).toHaveLength(56);
  });

  it('gives no client role any of the new capabilities, in the transcription or the ceiling', () => {
    const added = CAPABILITIES.slice(32);
    for (const role of CLIENT_ROLES) {
      for (const capability of added) {
        expect(PERMISSION_MATRIX[role].denied, `${role} ${capability}`).toContain(capability);
        expect(capabilitiesFor(role), `${role} ${capability}`).not.toContain(capability);
      }
    }
  });
});

describe('every accepted divergence is still real', () => {
  // A stale entry is as dangerous as a missing one: it is a standing licence for a
  // difference that no longer exists, and the next real drift at that cell would be
  // absorbed silently. Each entry must still describe both sides.
  for (const divergence of ACCEPTED_CEILING_DIVERGENCES) {
    const { role, capability, ceiling } = divergence;

    it(`'${role}' × '${capability}': the ceiling still ${ceiling} it, and §2 still does not`, () => {
      const inCeiling = capabilitiesFor(role).includes(capability);
      const inMatrix = PERMISSION_MATRIX[role].granted.includes(capability);

      expect(inCeiling, `ceiling no longer ${ceiling} '${capability}' for '${role}'`).toBe(
        ceiling === 'grants',
      );
      expect(
        inMatrix,
        `the transcription no longer disagrees at '${role}' × '${capability}' — delete this ` +
          `entry from ACCEPTED_CEILING_DIVERGENCES`,
      ).toBe(ceiling === 'denies');
    });
  }

  it('names a reason for each, and names each cell only once', () => {
    const keys = ACCEPTED_CEILING_DIVERGENCES.map((d) => `${d.role} ${d.capability}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const divergence of ACCEPTED_CEILING_DIVERGENCES) {
      expect(
        divergence.why.length,
        `${divergence.role} × ${divergence.capability}`,
      ).toBeGreaterThan(60);
    }
  });

  it('is a short list — a long one means the transcription stopped being a second opinion', () => {
    // Not a style rule. Every entry is a cell where nothing independent checks the ceiling,
    // so the register is the fixture's blind spot and it has to stay small enough to read.
    expect(ACCEPTED_CEILING_DIVERGENCES.length).toBeLessThanOrEqual(8);
  });
});

describe('the fixture cannot read the table it checks', () => {
  it('imports nothing but types from @tmanage/domain', () => {
    // The defect this whole slice removes was an expectation computed from the code under
    // test. A future edit that reaches for `hasCapability` to "simplify" the fixture would
    // reintroduce it in a form no assertion above could detect, because both sides would
    // move together again. So the import list itself is asserted.
    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = resolve(here, '../../../../../../packages/test-kit/src/permission-matrix.ts');
    const source = readFileSync(fixture, 'utf8');

    const imports = source.match(/^import .*?;$/gms) ?? [];
    expect(imports.length, 'the fixture should have exactly one import').toBe(1);
    expect(imports[0]).toBe("import type { Capability, Role } from '@tmanage/domain';");

    // Belt and braces: no value-level reference to the ceiling anywhere outside a comment.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/'[^']*'/g, "''");
    for (const forbidden of ['hasCapability', 'capabilitiesFor', 'CAPABILITY_CEILING']) {
      expect(code, `the fixture must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });
});
