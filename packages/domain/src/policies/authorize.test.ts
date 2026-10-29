import { describe, expect, it } from 'vitest';
import {
  authorize,
  mayGrantCapability,
  type Principal,
  type ResourceContext,
} from './authorize.js';
import {
  CAPABILITIES,
  CLIENT_ROLES,
  INTERNAL_ROLES,
  isInternalOnlyCapability,
  type Capability,
  type Role,
} from './capabilities.js';
import { findForbiddenClientFields } from './audience.js';

/**
 * The permission grid from `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §12.
 *
 * Every operation is tested for: correct internal project; same tenant / different
 * project; same tenant / different client; different tenant; suspended membership;
 * expired client membership; direct-ID enumeration; changed role after session;
 * archived / deleted object.
 *
 * These run against the pure evaluator. MySQL repository scoping, composite tenant
 * constraints, restricted credentials, and the database isolation corpus live in the API
 * package's integration tests; every layer is tested because one failure must not expose
 * another organization's data.
 */

const ORG_A = '01890000-0000-7000-8000-00000000000a';
const ORG_B = '01890000-0000-7000-8000-00000000000b';
const CLIENT_ATLAS = '01890000-0000-7000-8000-0000000000a1';
const CLIENT_OTHER = '01890000-0000-7000-8000-0000000000a2';
const PROJECT_1 = '01890000-0000-7000-8000-000000000101';
const PROJECT_2 = '01890000-0000-7000-8000-000000000102';

const internal = (over: Partial<Principal> = {}): Principal => ({
  userId: '01890000-0000-7000-8000-000000000001',
  organizationId: ORG_A,
  kind: 'internal',
  role: 'member',
  membershipId: '01890000-0000-7000-8000-000000000011',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PROJECT_1],
  hasOrgWideScope: false,
  ...over,
});

const client = (over: Partial<Principal> = {}): Principal => ({
  userId: '01890000-0000-7000-8000-000000000002',
  organizationId: ORG_A,
  kind: 'client',
  role: 'client_reviewer',
  membershipId: '01890000-0000-7000-8000-000000000012',
  membershipStatus: 'active',
  clientOrganizationId: CLIENT_ATLAS,
  projectIds: [PROJECT_1],
  hasOrgWideScope: false,
  ...over,
});

const resource = (over: Partial<ResourceContext> = {}): ResourceContext => ({
  organizationId: ORG_A,
  projectId: PROJECT_1,
  audience: 'internal',
  ...over,
});

describe('authorize — tenant isolation', () => {
  it('denies every capability across a tenant boundary, for every role', () => {
    for (const role of [...INTERNAL_ROLES, ...CLIENT_ROLES] as Role[]) {
      for (const capability of CAPABILITIES) {
        const decision = authorize({
          principal: internal({ role, hasOrgWideScope: true, clientOrganizationId: CLIENT_ATLAS }),
          capability,
          // Resource in the other tenant. Nothing about the principal should matter.
          resource: resource({ organizationId: ORG_B, audience: 'client_visible' }),
        });

        expect(decision, `${role} / ${capability} must not cross tenants`).toMatchObject({
          allowed: false,
          code: 'tenant_mismatch',
        });
      }
    }
  });

  it('denies a cross-tenant read even for an owner with org-wide scope', () => {
    expect(
      authorize({
        principal: internal({ role: 'owner', hasOrgWideScope: true }),
        capability: 'work.read',
        resource: resource({ organizationId: ORG_B }),
      }),
    ).toMatchObject({ allowed: false, code: 'tenant_mismatch' });
  });
});

describe('authorize — membership status', () => {
  it.each(['suspended', 'expired'] as const)(
    'denies everything for a %s membership before any object reasoning',
    (status) => {
      const decision = authorize({
        principal: internal({ role: 'owner', hasOrgWideScope: true, membershipStatus: status }),
        capability: 'work.read',
        resource: resource(),
      });

      expect(decision).toMatchObject({ allowed: false, code: 'membership_inactive' });
    },
  );

  it('denies an expired client membership on a project it previously reached', () => {
    expect(
      authorize({
        principal: client({ membershipStatus: 'expired' }),
        capability: 'approval.read',
        resource: resource({
          audience: 'client_visible',
          clientOrganizationId: CLIENT_ATLAS,
          isPublished: true,
        }),
      }),
    ).toMatchObject({ allowed: false, code: 'membership_inactive' });
  });
});

describe('authorize — client boundary', () => {
  it('never grants an internal-only capability to any client role', () => {
    for (const role of CLIENT_ROLES) {
      for (const capability of CAPABILITIES.filter(isInternalOnlyCapability)) {
        const decision = authorize({
          principal: client({ role }),
          capability,
          resource: resource({ audience: 'client_visible', isPublished: true }),
        });

        expect(decision, `${role} must never hold ${capability}`).toMatchObject({
          allowed: false,
        });
      }
    }
  });

  it('denies a client reading internal-audience content in its own project', () => {
    expect(
      authorize({
        principal: client(),
        capability: 'approval.read',
        resource: resource({ audience: 'internal', clientOrganizationId: CLIENT_ATLAS }),
      }),
    ).toMatchObject({ allowed: false, code: 'audience_internal' });
  });

  it('denies one client organization reading another inside the same tenant', () => {
    expect(
      authorize({
        principal: client({ clientOrganizationId: CLIENT_ATLAS }),
        capability: 'approval.read',
        resource: resource({
          audience: 'client_visible',
          clientOrganizationId: CLIENT_OTHER,
          isPublished: true,
        }),
      }),
    ).toMatchObject({ allowed: false, code: 'client_organization_mismatch' });
  });

  it('denies client-visible-but-unpublished content', () => {
    expect(
      authorize({
        principal: client(),
        capability: 'approval.read',
        resource: resource({
          audience: 'client_visible',
          clientOrganizationId: CLIENT_ATLAS,
          isPublished: false,
        }),
      }),
    ).toMatchObject({ allowed: false, code: 'not_published' });
  });

  it('denies a client on a project not shared with their client organization', () => {
    expect(
      authorize({
        principal: client({ projectIds: [PROJECT_1] }),
        capability: 'approval.read',
        resource: resource({
          projectId: PROJECT_2,
          audience: 'client_visible',
          clientOrganizationId: CLIENT_ATLAS,
          isPublished: true,
        }),
      }),
    ).toMatchObject({ allowed: false, code: 'not_project_member' });
  });

  it('allows a client reviewer to read a published, related, client-visible resource', () => {
    expect(
      authorize({
        principal: client(),
        capability: 'approval.read',
        resource: resource({
          audience: 'client_visible',
          clientOrganizationId: CLIENT_ATLAS,
          isPublished: true,
        }),
      }),
    ).toEqual({ allowed: true });
  });

  it('denies a client any access to an archived resource, even a read', () => {
    expect(
      authorize({
        principal: client(),
        capability: 'approval.read',
        resource: resource({
          audience: 'client_visible',
          clientOrganizationId: CLIENT_ATLAS,
          isPublished: true,
          lifecycle: 'archived',
        }),
      }),
    ).toMatchObject({ allowed: false, code: 'resource_not_active' });
  });
});

describe('authorize — reviewer authority (US-C03, 25-AUTH-AND-TENANT-ISOLATION §8)', () => {
  it('denies a client reviewer deciding an approval they are not assigned to', () => {
    expect(
      authorize({
        principal: client({ role: 'client_reviewer' }),
        capability: 'approval.decide',
        resource: resource({
          audience: 'client_action_required',
          clientOrganizationId: CLIENT_ATLAS,
          isPublished: true,
          isAssignedReviewer: false,
        }),
      }),
    ).toMatchObject({ allowed: false, code: 'not_assigned_reviewer' });
  });

  it('allows an assigned client reviewer to decide', () => {
    expect(
      authorize({
        principal: client({ role: 'client_reviewer' }),
        capability: 'approval.decide',
        resource: resource({
          audience: 'client_action_required',
          clientOrganizationId: CLIENT_ATLAS,
          isPublished: true,
          isAssignedReviewer: true,
        }),
      }),
    ).toEqual({ allowed: true });
  });

  it('never lets a client viewer decide, even when marked as an assigned reviewer', () => {
    // 12-PERMISSION-MATRIX §2: "Approve governed version" is "No" for Client Viewer.
    // A stray assignment row must not become authority.
    expect(
      authorize({
        principal: client({ role: 'client_viewer' }),
        capability: 'approval.decide',
        resource: resource({
          audience: 'client_action_required',
          clientOrganizationId: CLIENT_ATLAS,
          isPublished: true,
          isAssignedReviewer: true,
        }),
      }),
    ).toMatchObject({ allowed: false, code: 'capability_not_in_role_ceiling' });
  });

  it('applies reviewer authority to internal principals too', () => {
    expect(
      authorize({
        principal: internal({ role: 'manager' }),
        capability: 'approval.decide',
        resource: resource({ isAssignedReviewer: false }),
      }),
    ).toMatchObject({ allowed: false, code: 'not_assigned_reviewer' });
  });
});

describe('authorize — internal project relation', () => {
  it('denies a member reading work in a same-tenant project they do not belong to', () => {
    expect(
      authorize({
        principal: internal({ projectIds: [PROJECT_1] }),
        capability: 'work.read',
        resource: resource({ projectId: PROJECT_2 }),
      }),
    ).toMatchObject({ allowed: false, code: 'not_project_member' });
  });

  it('allows a member on their own project', () => {
    expect(
      authorize({
        principal: internal(),
        capability: 'work.read',
        resource: resource({ projectId: PROJECT_1 }),
      }),
    ).toEqual({ allowed: true });
  });

  it('allows an org-wide role without an explicit project membership row', () => {
    expect(
      authorize({
        principal: internal({ role: 'org_admin', projectIds: [], hasOrgWideScope: true }),
        capability: 'work.read',
        resource: resource({ projectId: PROJECT_2 }),
      }),
    ).toEqual({ allowed: true });
  });

  it('denies a write to an archived object but permits an internal read for history', () => {
    const archived = resource({ lifecycle: 'archived' });

    expect(
      authorize({ principal: internal(), capability: 'work.update', resource: archived }),
    ).toMatchObject({ allowed: false, code: 'resource_not_active' });

    expect(
      authorize({ principal: internal(), capability: 'work.read', resource: archived }),
    ).toEqual({ allowed: true });
  });

  it('denies writes to a soft-deleted object', () => {
    expect(
      authorize({
        principal: internal({ role: 'owner', hasOrgWideScope: true }),
        capability: 'work.update',
        resource: resource({ lifecycle: 'soft_deleted' }),
      }),
    ).toMatchObject({ allowed: false, code: 'resource_not_active' });
  });
});

describe('authorize — organization policy narrows but never widens', () => {
  it('denies a capability the role holds when policy disables it', () => {
    expect(
      authorize({
        principal: internal({ role: 'manager' }),
        capability: 'deliverable.publish',
        resource: resource(),
        policy: { disabledCapabilities: ['deliverable.publish'] },
      }),
    ).toMatchObject({ allowed: false, code: 'capability_disabled_by_policy' });
  });

  it('cannot grant a capability the role does not hold', () => {
    // Policy has no "enabled" list by construction, so this is a type-level guarantee.
    // The behavioural assertion: a guest still cannot publish, whatever policy is passed.
    expect(
      authorize({
        principal: internal({ role: 'guest' }),
        capability: 'deliverable.publish',
        resource: resource(),
        policy: { disabledCapabilities: [] },
      }),
    ).toMatchObject({ allowed: false, code: 'capability_not_in_role_ceiling' });
  });
});

describe('authorize — role change after session issuance', () => {
  it('reflects the current role, not a stale elevated one', () => {
    // 12-PERMISSION-MATRIX §5: "stale token claims do not authorize changed access".
    // The evaluator is pure over the principal it is handed, so the guarantee is that the
    // session layer must rebuild the principal per request. Demonstrated here: the same
    // request with a demoted role denies.
    const before = authorize({
      principal: internal({ role: 'manager' }),
      capability: 'client_request.triage',
      resource: resource(),
    });
    const after = authorize({
      principal: internal({ role: 'member' }),
      capability: 'client_request.triage',
      resource: resource(),
    });

    expect(before).toEqual({ allowed: true });
    expect(after).toMatchObject({ allowed: false, code: 'capability_not_in_role_ceiling' });
  });
});

describe('authorize — deny by default', () => {
  it('produces a denial code for every deny, so nothing fails open silently', () => {
    const decision = authorize({
      principal: client({ role: 'client_viewer' }),
      capability: 'work.read',
      resource: resource(),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBeTruthy();
      expect(decision.detail).toBeTruthy();
    }
  });

  it('never leaks another tenant or client identifier in a denial detail', () => {
    const decision = authorize({
      principal: client({ clientOrganizationId: CLIENT_ATLAS }),
      capability: 'approval.read',
      resource: resource({
        organizationId: ORG_B,
        audience: 'client_visible',
        clientOrganizationId: CLIENT_OTHER,
      }),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.detail).not.toContain(ORG_B);
      expect(decision.detail).not.toContain(CLIENT_OTHER);
    }
  });
});

describe('findForbiddenClientFields', () => {
  it('finds a forbidden field nested inside a would-be client payload', () => {
    const payload = {
      title: 'Homepage Concept',
      versions: [{ number: 2, internalNotes: 'do not ship' }],
      owner: { name: 'Lina Samir', cost: 4200 },
    };

    expect(findForbiddenClientFields(payload).sort()).toEqual([
      'owner.cost',
      'versions[0].internalNotes',
    ]);
  });

  it('passes a correctly allowlisted client projection', () => {
    const projection = {
      title: 'Homepage Concept',
      versionNumber: 2,
      contentHashAbbreviated: '8f2c·d41a',
      milestoneState: 'in_review',
      committedDate: '2026-08-18',
    };

    expect(findForbiddenClientFields(projection)).toEqual([]);
  });
});

/**
 * A guard on the guard: if someone adds a capability to `CAPABILITIES` without deciding
 * whether an external principal may hold it, this fails and forces the decision.
 */
describe('capability coverage', () => {
  it('classifies every capability as internal-only or client-reachable deliberately', () => {
    const clientReachable: Capability[] = [
      // CLIENT-002. The decision this test exists to force: a client principal **may** hold
      // it, because the client projection is the only thing they were ever meant to read.
      // `work.read` stays internal-only, and the two are not the same surface.
      'client_projection.read',
      'client_request.submit',
      'approval.read',
      'approval.decide',
      'client_member.manage',
      'audit.read',
      'file.upload',
      'file.download',
    ];

    for (const capability of CAPABILITIES) {
      const classified =
        isInternalOnlyCapability(capability) || clientReachable.includes(capability);
      expect(classified, `${capability} is unclassified — decide if clients may hold it`).toBe(
        true,
      );
    }
  });
});

describe('mayGrantCapability (ADM-08) and the org admin ceiling (ADM-03)', () => {
  const owner = internal({ role: 'owner', projectIds: [], hasOrgWideScope: true });

  it('lets the active owner grant any capability, approval.decide included (ADM-08)', () => {
    expect(mayGrantCapability(owner, 'approval.decide', ORG_A).allowed).toBe(true);
    expect(mayGrantCapability(owner, 'work.update', ORG_A).allowed).toBe(true);
  });

  it('refuses the owner in another tenant, or while suspended', () => {
    expect(mayGrantCapability(owner, 'approval.decide', ORG_B).allowed).toBe(false);
    expect(mayGrantCapability(owner, 'work.update', ORG_B).allowed).toBe(false);
    const suspended = internal({
      role: 'owner',
      projectIds: [],
      hasOrgWideScope: true,
      membershipStatus: 'suspended',
    });
    expect(mayGrantCapability(suspended, 'approval.decide', ORG_A).allowed).toBe(false);
  });

  it('keeps the strict check for everyone else', () => {
    const admin = internal({ role: 'org_admin', projectIds: [], hasOrgWideScope: true });
    expect(mayGrantCapability(admin, 'approval.decide', ORG_A).allowed).toBe(false);
    expect(mayGrantCapability(internal(), 'org.manage', ORG_A).allowed).toBe(false);
  });

  it('gives the organization admin org.manage', () => {
    const admin = internal({ role: 'org_admin', projectIds: [], hasOrgWideScope: true });
    const verdict = authorize({
      principal: admin,
      capability: 'org.manage',
      resource: resource({ projectId: null, audience: 'internal' }),
    });
    expect(verdict.allowed).toBe(true);
  });
});

// ---- platform-admin v2 · PA-01 ----
describe('authorize — per-member overrides (SPEC §3.3)', () => {
  const orgWide = resource({ projectId: null, audience: 'internal' });

  it('an allow adds a capability the role lacks', () => {
    const member = internal({ overrides: { allow: ['report.export'], deny: [] } });
    expect(
      authorize({ principal: internal(), capability: 'report.export', resource: orgWide }),
    ).toMatchObject({ allowed: false, code: 'capability_not_in_role_ceiling' });
    expect(
      authorize({ principal: member, capability: 'report.export', resource: orgWide }).allowed,
    ).toBe(true);
  });

  it('a deny takes away a capability the role holds, with its own code', () => {
    const member = internal({ overrides: { allow: [], deny: ['work.read'] } });
    expect(
      authorize({ principal: member, capability: 'work.read', resource: resource() }),
    ).toMatchObject({ allowed: false, code: 'capability_denied_by_override' });
  });

  it('a deny wins over an allow of the same capability', () => {
    const member = internal({ overrides: { allow: ['report.export'], deny: ['report.export'] } });
    expect(
      authorize({ principal: member, capability: 'report.export', resource: orgWide }),
    ).toMatchObject({ allowed: false, code: 'capability_denied_by_override' });
  });

  it('never widens a client past the internal-only guard', () => {
    const reviewer = client({ overrides: { allow: ['work.read', 'org.manage'], deny: [] } });
    for (const capability of ['work.read', 'org.manage'] as const) {
      const verdict = authorize({
        principal: reviewer,
        capability,
        resource: resource({ audience: 'client_visible', clientOrganizationId: CLIENT_ATLAS }),
      });
      expect(verdict.allowed).toBe(false);
    }
  });

  it('a deny does not apply to TManage support', () => {
    const support = internal({
      role: 'platform_support',
      hasOrgWideScope: true,
      overrides: { allow: [], deny: ['work.read'] },
    });
    expect(
      authorize({ principal: support, capability: 'work.read', resource: resource() }).allowed,
    ).toBe(true);
  });

  it('an owner keeps every internal capability with no overrides present', () => {
    const owner = internal({ role: 'owner', hasOrgWideScope: true, projectIds: [] });
    for (const capability of CAPABILITIES) {
      if (capability === 'client_request.submit') continue;
      const verdict = authorize({
        principal: owner,
        capability,
        resource: orgWide,
      });
      if (!verdict.allowed) expect(verdict.code).not.toBe('capability_not_in_role_ceiling');
    }
  });
});
