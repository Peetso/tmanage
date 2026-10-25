import { describe, expect, it } from 'vitest';
import { authorize, type Principal, type ResourceContext } from './authorize.js';
import type { PrincipalRole } from './capabilities.js';

/**
 * Wave 9, lane S4 — audit run 1 F18: `client_projection.read` is relation-gated for internal
 * principals, so an internal guest or member no longer reads the portal projection of projects they
 * are not on (`12-PERMISSION-MATRIX` §2 "View client projection": Member = Project, Guest =
 * Explicit, org-wide roles = Scope). Client principals keep rule 10.
 */

const ORG = 'org-acme';
const P1 = 'project-related';
const P2 = 'project-unrelated';
const CLIENT_ORG = 'client-org-c';

function internal(
  role: PrincipalRole,
  projectIds: readonly string[],
  hasOrgWideScope = false,
): Principal {
  return {
    userId: 'u-1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope,
  };
}

function client(projectIds: readonly string[]): Principal {
  return {
    userId: 'c-1',
    organizationId: ORG,
    kind: 'client',
    role: 'client_viewer',
    membershipId: 'cm-1',
    membershipStatus: 'active',
    clientOrganizationId: CLIENT_ORG,
    projectIds,
    hasOrgWideScope: false,
  };
}

function projection(projectId: string | null, clientOrganizationId: string | null = null) {
  const resource: ResourceContext = {
    organizationId: ORG,
    projectId,
    audience: 'client_visible',
    clientOrganizationId,
    isPublished: true,
    lifecycle: 'active',
  };
  return resource;
}

const read = (principal: Principal, resource: ResourceContext) =>
  authorize({ principal, capability: 'client_projection.read', resource });

describe('F18: client_projection.read needs the project relation for internal principals', () => {
  it('denies an internal guest with no project memberships', () => {
    expect(read(internal('guest', []), projection(P2))).toMatchObject({
      allowed: false,
      code: 'not_project_member',
    });
  });

  it.each(['member', 'moderator', 'manager'] as const)(
    'denies a %s the projection of a project they are not on',
    (role) => {
      expect(read(internal(role, [P1]), projection(P2))).toMatchObject({
        allowed: false,
        code: 'not_project_member',
      });
    },
  );

  it('allows a related member and a guest on the project', () => {
    expect(read(internal('member', [P1]), projection(P1)).allowed).toBe(true);
    expect(read(internal('guest', [P1]), projection(P1)).allowed).toBe(true);
  });

  it('allows an owner with org-wide scope on any project', () => {
    expect(read(internal('owner', [], true), projection(P2)).allowed).toBe(true);
  });

  it('leaves org-level (projectId null) projection reads unchanged for internal principals', () => {
    expect(read(internal('guest', []), projection(null)).allowed).toBe(true);
  });

  it('keeps rule 10 for client principals: shared project yes, unshared no', () => {
    expect(read(client([P1]), projection(P1, CLIENT_ORG)).allowed).toBe(true);
    expect(read(client([P1]), projection(P2, CLIENT_ORG))).toMatchObject({
      allowed: false,
      code: 'not_project_member',
    });
  });
});
