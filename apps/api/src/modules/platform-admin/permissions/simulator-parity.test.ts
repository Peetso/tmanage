import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  authorize,
  customRoleKey,
  principalHoldsCapability,
  type Capability,
  type PermissionOverrides,
  type Principal,
} from '@tmanage/domain';
import { MEMBER, ORG, ROLE, harness, member, request, roleRow } from './test-fakes.js';

/**
 * UNIT-53-51 (53 §53-20, release gate audit debt) — the "what can this person do" simulation
 * (PA-04, `GET …/members/:membershipId/effective-permissions?projectId=`) answers exactly what the
 * runtime answers.
 *
 * The runtime path is the two calls a real request makes: the route guard's ceiling half
 * (`principalHoldsCapability`, `CapabilityGuard`) and the service's object-level `authorize()` over
 * the loaded row. The simulation is asked through the PA-04 service, so the role row is parsed from
 * stored JSON and the overrides and project list come from the repositories, as in production. The
 * runtime principal is built here independently from the same facts.
 *
 * Property style: the three AUTH-53-50 roles plus seeded random capability subsets and random
 * allow/deny overrides, each checked for every id in `CAPABILITIES` (not a hand-picked subset), at
 * org level, on the person's own project and on a project they are not on.
 */

const PROJECT = '0199aa00-0000-7000-8000-0000000000f1';
const OTHER_PROJECT = '0199aa00-0000-7000-8000-0000000000f2';

/** The ceilings AUTH-53-50 creates through the roles API. */
const NAMED_ROLES: Readonly<Record<string, readonly Capability[]>> = {
  'Read-only reviewer': ['work.read', 'conversation.read', 'meeting.read', 'people.view'],
  'Work contributor': ['work.read', 'work.create', 'work.update', 'conversation.read'],
  'Flow operator': ['work.read', 'work.transition', 'audit.read', 'decision.read'],
};

/** A small deterministic PRNG (mulberry32), so a red run is reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Fixture {
  readonly label: string;
  readonly capabilities: readonly Capability[];
  readonly overrides: PermissionOverrides;
}

function fixtures(): Fixture[] {
  const none: PermissionOverrides = { allow: [], deny: [] };
  const out: Fixture[] = Object.entries(NAMED_ROLES).map(([label, capabilities]) => ({
    label,
    capabilities,
    overrides: none,
  }));
  const random = prng(5320);
  for (let index = 0; index < 20; index += 1) {
    const pick = (p: number) => CAPABILITIES.filter(() => random() < p);
    out.push({
      label: `random role #${String(index)}`,
      capabilities: pick(0.4),
      overrides: index % 2 === 0 ? none : { allow: pick(0.08), deny: pick(0.08) },
    });
  }
  return out;
}

function runtimePrincipal(fixture: Fixture): Principal {
  return {
    userId: member().userId,
    organizationId: ORG,
    kind: 'internal',
    role: customRoleKey(ROLE, fixture.capabilities),
    membershipId: MEMBER,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
    overrides: fixture.overrides,
  };
}

/** What a real request answers: the guard's ceiling half, then `authorize()` on the loaded row. */
function runtimeAllows(principal: Principal, capability: Capability, projectId: string | null) {
  if (!principalHoldsCapability(principal, capability)) return false;
  return authorize({
    principal,
    capability,
    resource: {
      organizationId: ORG,
      projectId,
      audience: 'internal',
      lifecycle: 'active',
      isPublished: true,
      // The simulation asks about the permission; a real approval also checks the assignment.
      isAssignedReviewer: true,
    },
  }).allowed;
}

async function simulate(fixture: Fixture, projectId: string | undefined) {
  const h = harness({
    roles: [roleRow(ROLE, fixture.label, fixture.capabilities)],
    member: member({ role: ROLE }),
  });
  h.overrides.liveOverrides.mockResolvedValue(fixture.overrides as never);
  h.overrides.projectIdsOf.mockResolvedValue([PROJECT] as never);
  return h.service.effectivePermissions(ORG, MEMBER, projectId, request);
}

describe('UNIT-53-51 — the permission simulator answers what the runtime answers', () => {
  const cases = fixtures();

  it.each(cases.map((fixture) => [fixture.label, fixture] as const))(
    '%s: every capability, at org level, on its project and on another project',
    async (_label, fixture) => {
      const principal = runtimePrincipal(fixture);
      for (const projectId of [undefined, PROJECT, OTHER_PROJECT]) {
        const view = await simulate(fixture, projectId);
        expect(view.permissions.map((entry) => entry.capability)).toEqual([...CAPABILITIES]);
        const simulated = Object.fromEntries(
          view.permissions.map((entry) => [entry.capability, entry.final]),
        );
        const runtime = Object.fromEntries(
          CAPABILITIES.map((capability) => [
            capability,
            runtimeAllows(principal, capability, projectId ?? null),
          ]),
        );
        expect(simulated, `${fixture.label} on ${projectId ?? 'the organization'}`).toEqual(
          runtime,
        );
      }
    },
  );

  it('the fixtures exercise both answers for every capability somewhere', async () => {
    const seen = new Map<Capability, Set<boolean>>();
    for (const fixture of cases) {
      for (const entry of (await simulate(fixture, PROJECT)).permissions) {
        const answers = seen.get(entry.capability) ?? new Set<boolean>();
        answers.add(entry.final);
        seen.set(entry.capability, answers);
      }
    }
    const oneSided = CAPABILITIES.filter((capability) => seen.get(capability)?.size !== 2);
    expect(oneSided).toEqual([]);
  });
});
