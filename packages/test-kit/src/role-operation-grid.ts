/**
 * The generated role × operation grid — TEST-001's second half, made a harness.
 *
 * ## What was missing, and what this adds
 *
 * `apps/api/test/test-001-role-matrix.db.test.ts` already drives §11's grid for the internal
 * roles, but over a **hand-maintained** list of five route families. That list is a second
 * place the capability vocabulary lives: add a twenty-ninth capability to
 * `25-AUTH-AND-TENANT-ISOLATION` §4 and nothing in that suite notices — the new capability has
 * no row, so it is never exercised and never refused, and the grid stays green while a whole
 * column of the matrix goes untested. That is the silent pass this module removes.
 *
 * This generator builds the grid from the **real** capability and role tables in
 * `@tmanage/domain` (`CAPABILITIES`, `INTERNAL_ROLES`, `CLIENT_ROLES`). Every capability in
 * `CAPABILITIES` must be accounted for — either mapped to a representative HTTP operation in
 * `GUARDED_OPERATIONS`, or listed in `UNGUARDED_CAPABILITIES` with the reason it has no route
 * guard. `assertCatalogCoversEveryCapability()` fails loudly when a capability is in neither,
 * so a newly declared capability breaks this module (and the DB suite that consumes it, and the
 * generator's own unit test) until a human decides which list it belongs in. That is the whole
 * point: the coverage of §11's operation axis is now a checked property, not a hand count.
 *
 * ## The grid's subject is the guard, and how each cell is judged
 *
 * `CapabilityGuard` (`apps/api/src/common/http/guards/capability.guard.ts`) answers one
 * question — "does this role's ceiling include this capability at all?" — and, on a refusal,
 * writes exactly one `security.capability_denied` audit row (§12, AUD-001). It is the *only*
 * writer of that action. So the DB suite judges a cell not by the HTTP status alone but by that
 * row:
 *
 * - **allowed cell** → the guard let the request through, so **no new** `security.capability_denied`
 *   row appears. What the handler then does (200, a 400 on an empty body, a deeper object-level
 *   403, a 404 on a bogus id) is a different layer's decision and not this grid's subject.
 * - **denied cell** → the guard refused, so **exactly one** new row appears and the status is 403.
 *
 * Judging by the audit row rather than the status is what lets one generated sweep cover every
 * surface without special cases. The owner and org_admin ceilings hold `client_request.submit`
 * as a blanket-grant artefact (see `ACCEPTED_CEILING_DIVERGENCES`), so an internal principal
 * *passes the guard* on a portal route and is then refused a layer deeper by the portal service
 * — a 403 that is **not** a guard denial and writes no row. An allowed cell that asserted
 * `status !== 403` would wrongly fail there; an allowed cell that asserts "no new denial row"
 * is correct there. That seam was the finding recorded in `test-001-role-matrix.db.test.ts`;
 * here it needs no exclusion because the audit row draws the line for us.
 *
 * ## Why the expectation is the transcription, not `hasCapability`
 *
 * Each cell's `expectedAllowed` comes from `expectedCeilingGrants` — `@tmanage/test-kit`'s
 * hand-written transcription of `12-PERMISSION-MATRIX.md` §2 (plus its four fixed, documented
 * divergences), which imports no value from the domain and cannot see `CAPABILITY_CEILING`.
 * Deriving the expectation from `hasCapability` instead was finding D18 / C1: the guard is built
 * from `hasCapability`, so both sides of the comparison would move together and a widened
 * ceiling would stay green. Because the transcription is independent, flipping one ceiling cell
 * in the domain turns the corresponding grid cell red — which is the mutation check that proves
 * this harness is load-bearing rather than tautological.
 */
import { CAPABILITIES, CLIENT_ROLES, INTERNAL_ROLES, isInternalRole } from '@tmanage/domain';
import type { Capability, Role } from '@tmanage/domain';
import { expectedCeilingGrants } from './permission-matrix.js';

/** HTTP verbs the grid drives. */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * Which principal surface a route lives on.
 *
 * `internal` routes hang off `/v1/organizations/:orgSlug`; `portal` routes off
 * `/v1/organizations/:orgSlug/portal`. The distinction is documentary here — the grid judges
 * every cell by the guard's audit row regardless of surface — but it is carried so a reader can
 * see at a glance why an internal principal on a portal route is an allowed-by-guard cell.
 */
export type OperationSurface = 'internal' | 'portal';

/**
 * One column of §11's operation axis: a capability paired with a representative route that the
 * `CapabilityGuard` protects with that capability.
 *
 * The route is representative, not exhaustive — one guarded route per capability is enough to
 * exercise the guard for that capability against every role. `path` is relative to
 * `/v1/organizations/:orgSlug`; portal routes begin with `/portal`.
 */
export interface GuardedOperation {
  readonly capability: Capability;
  readonly method: HttpMethod;
  readonly path: string;
  readonly surface: OperationSurface;
  /**
   * True when a 404 from this route can only mean the route itself vanished (a collection
   * endpoint with no id in its path). Allowed cells on a collection route additionally assert
   * `status !== 404`, catching a re-gated or deleted route; id-bearing routes cannot, because a
   * 404 there is an ordinary "no such object" from the handler after the guard already passed.
   */
  readonly collection: boolean;
  /** The exact `@RequireCapability` site this column mirrors, for the reader. */
  readonly declaredAt: string;
}

/**
 * The representative guarded route for every capability that has a route-level
 * `@RequireCapability`. One per capability; collection endpoints are chosen where a capability
 * has one, so the allowed-cell route-exists check applies as widely as possible.
 */
export const GUARDED_OPERATIONS: readonly GuardedOperation[] = [
  {
    capability: 'org.manage',
    method: 'GET',
    path: '/invitations',
    surface: 'internal',
    collection: true,
    declaredAt: 'tenancy/invitations.controller.ts @Get() org.manage',
  },
  {
    capability: 'project.create',
    method: 'POST',
    path: '/projects',
    surface: 'internal',
    collection: true,
    declaredAt: 'projects/projects.controller.ts @Post() project.create',
  },
  {
    capability: 'project.manage',
    method: 'GET',
    path: '/projects/00000000-0000-7000-8000-000000000000/clients',
    surface: 'internal',
    collection: false,
    declaredAt: 'clients/clients.controller.ts @Get(projects/:projectId/clients) project.manage',
  },
  {
    capability: 'conversation.read',
    method: 'GET',
    path: '/conversations',
    surface: 'internal',
    collection: true,
    declaredAt: 'conversations/conversations.controller.ts @Get(conversations) conversation.read',
  },
  {
    capability: 'conversation.write',
    method: 'POST',
    path: '/conversations',
    surface: 'internal',
    collection: true,
    declaredAt: 'conversations/conversations.controller.ts @Post(conversations) conversation.write',
  },
  {
    capability: 'work.read',
    method: 'GET',
    path: '/work-items',
    surface: 'internal',
    collection: true,
    declaredAt: 'work/work-items.controller.ts @Get() work.read',
  },
  {
    capability: 'work.create',
    method: 'POST',
    path: '/work-items',
    surface: 'internal',
    collection: true,
    declaredAt: 'work/work-items.controller.ts @Post() work.create',
  },
  {
    capability: 'work.update',
    method: 'PATCH',
    path: '/work-items/00000000-0000-7000-8000-000000000000',
    surface: 'internal',
    collection: false,
    declaredAt: 'work/work-items.controller.ts @Patch(:workItemId) work.update',
  },
  {
    capability: 'work.transition',
    method: 'POST',
    path: '/work-items/00000000-0000-7000-8000-000000000000/transitions',
    surface: 'internal',
    collection: false,
    declaredAt: 'work/work-items.controller.ts @Post(:workItemId/transitions) work.transition',
  },
  {
    capability: 'meeting.read',
    method: 'GET',
    path: '/meetings',
    surface: 'internal',
    collection: true,
    declaredAt: 'calendar/meetings.controller.ts @Get() meeting.read',
  },
  {
    capability: 'meeting.write',
    method: 'POST',
    path: '/meetings',
    surface: 'internal',
    collection: true,
    declaredAt: 'calendar/meetings.controller.ts @Post() meeting.write',
  },
  {
    capability: 'doc.read',
    method: 'GET',
    path: '/documents',
    surface: 'internal',
    collection: true,
    declaredAt: 'docs/documents.controller.ts @Get() doc.read',
  },
  {
    capability: 'doc.write',
    method: 'POST',
    path: '/documents',
    surface: 'internal',
    collection: true,
    declaredAt: 'docs/documents.controller.ts @Post() doc.write',
  },
  {
    capability: 'client_request.triage',
    method: 'GET',
    path: '/client-requests',
    surface: 'internal',
    collection: true,
    declaredAt: 'requests/client-requests.controller.ts @Get() client_request.triage',
  },
  {
    capability: 'client_member.manage',
    method: 'GET',
    path: '/client-memberships',
    surface: 'internal',
    collection: true,
    declaredAt: 'clients/clients.controller.ts @Get(client-memberships) client_member.manage',
  },
  {
    capability: 'file.upload',
    method: 'GET',
    path: '/upload-sessions',
    surface: 'internal',
    collection: true,
    declaredAt: 'files/upload-sessions.controller.ts @Get() file.upload',
  },
  {
    capability: 'file.download',
    method: 'GET',
    path: '/files/00000000-0000-7000-8000-000000000000/content',
    surface: 'internal',
    collection: false,
    declaredAt: 'files/file-downloads.controller.ts @Get(:fileAssetId/content) file.download',
  },
  {
    capability: 'client_projection.read',
    method: 'GET',
    path: '/portal/projects',
    surface: 'portal',
    collection: true,
    declaredAt: 'clients/portal.controller.ts @Get(projects) client_projection.read',
  },
  {
    capability: 'client_request.submit',
    method: 'GET',
    path: '/portal/requests',
    surface: 'portal',
    collection: true,
    declaredAt: 'clients/portal.controller.ts @Get(requests) client_request.submit',
  },
];

/**
 * Why a capability has no route-level guard, so the coverage check can account for it without
 * a route to drive.
 *
 * Two kinds appear here. Some are enforced only at the **object layer** — `authorize.ts` runs
 * inside the service with a real row in hand, which is where audience, relation and publication
 * state can be checked; a route guard could only ever answer the coarse ceiling question and
 * §3 is explicit that "route guards are UX only". Others are **declared but unwired**: §4 lists
 * the capability but no surface exercises it yet, so there is nothing to guard. Either way the
 * capability is deliberately absent from `GUARDED_OPERATIONS`, and saying so here is what keeps
 * the coverage check honest.
 */
export interface UnguardedCapability {
  readonly capability: Capability;
  readonly why: string;
}

/** Every capability with no route-level `@RequireCapability`, each with the reason. */
export const UNGUARDED_CAPABILITIES: readonly UnguardedCapability[] = [
  {
    capability: 'org.security.manage',
    why: 'Declared but unwired: §4/§5 name an org-security/SSO surface that no route or service exercises yet.',
  },
  {
    capability: 'workspace.manage',
    why: 'Declared but unwired: no workspace-settings mutation surface is built, so there is no route to guard.',
  },
  {
    capability: 'project.member.manage',
    why: 'Object-layer only: enforced by authorize() in packages/domain/src/policies/authorize.ts, not a route guard.',
  },
  {
    capability: 'conversation.moderate',
    why: 'Object-layer only: enforced by conversations.service.ts via authorize(); moderation is authority over a specific message, decided with the row loaded.',
  },
  {
    capability: 'deliverable.create',
    why: 'Object-layer only: enforced by authorize() with the deliverable/version row; no route-level guard.',
  },
  {
    capability: 'deliverable.review',
    why: 'Object-layer only: enforced by authorize() with the version row; no route-level guard.',
  },
  {
    capability: 'deliverable.publish',
    why: 'Object-layer only: enforced by authorize() at publish time; no route-level guard.',
  },
  {
    capability: 'approval.read',
    why: 'Object-layer only: enforced by authorize() with the approval row (reviewer/assignment relation); no route-level guard.',
  },
  {
    capability: 'approval.decide',
    why: 'Object-layer only: enforced by authorize() with the approval row; the reviewer relation is the real gate.',
  },
  {
    capability: 'audit.read',
    why: 'Service-layer only: enforced inside audit.service.ts with the scope narrowing §2 requires, not by a route-level @RequireCapability.',
  },
  {
    capability: 'audit.export',
    why: 'Declared but unwired: no tenant-export surface is built, so there is no route to guard.',
  },
  {
    capability: 'member.offboard',
    why: 'Declared but unwired: no offboarding surface is built yet; the capability exists in §4 ahead of its route.',
  },
  {
    capability: 'search.use',
    why: 'Declared but unwired: no search surface is built yet; the capability exists in §4 ahead of its route.',
  },
];

/** Every role, internal then client — the grid's row axis, taken from the domain tables. */
export const GRID_ROLES: readonly Role[] = [...INTERNAL_ROLES, ...CLIENT_ROLES];

/**
 * One generated cell: a role, the operation it is driven against, and the verdict the §2
 * transcription requires of the guard.
 */
export interface RoleOperationCell {
  readonly role: Role;
  readonly operation: GuardedOperation;
  /** From the independent transcription: true = the guard must allow, false = must refuse. */
  readonly expectedAllowed: boolean;
  /**
   * True where the operation's surface cannot match this role's principal kind — an internal
   * role on a portal route. Such an allowed cell passes the guard (the ceiling holds the
   * capability) and is then refused a layer deeper, so the DB suite still judges it by the
   * absence of a guard-denial row and never by status. Carried so the suite and the reader can
   * see the seam without recomputing it.
   */
  readonly crossSurface: boolean;
}

/**
 * The generator: every role × every guarded operation, with the transcription's verdict.
 *
 * Throws before producing a single cell if any capability is unaccounted for — see
 * `assertCatalogCoversEveryCapability`. The result is stable in `GRID_ROLES` × `GUARDED_OPERATIONS`
 * order so a suite can index it predictably.
 */
export function buildRoleOperationGrid(): readonly RoleOperationCell[] {
  assertCatalogCoversEveryCapability();
  const cells: RoleOperationCell[] = [];
  for (const role of GRID_ROLES) {
    for (const operation of GUARDED_OPERATIONS) {
      cells.push({
        role,
        operation,
        expectedAllowed: expectedCeilingGrants(role, operation.capability),
        crossSurface: operation.surface === 'portal' && isInternalRole(role),
      });
    }
  }
  return cells;
}

/**
 * The number of cells the guard must refuse — every cell whose transcription verdict is deny.
 *
 * The DB suite asserts that the count of `security.capability_denied` rows the sweep produces
 * equals exactly this, so a missing row (a silent refusal) or a surplus row (a phantom attempt)
 * both fail.
 */
export function expectedGuardDenialCount(): number {
  return buildRoleOperationGrid().filter((cell) => !cell.expectedAllowed).length;
}

/**
 * Fail loudly unless every capability is either mapped to a guarded operation or listed as
 * unguarded — and unless every list entry names a real capability, with none listed twice.
 *
 * `capabilities` defaults to the live `CAPABILITIES`; it is a parameter only so the generator's
 * unit test can prove the failure by passing a list with a capability the catalog does not yet
 * cover. Production callers pass nothing.
 */
export function assertCatalogCoversEveryCapability(
  capabilities: readonly Capability[] = CAPABILITIES,
): void {
  const guarded = GUARDED_OPERATIONS.map((op) => op.capability);
  const unguarded = UNGUARDED_CAPABILITIES.map((entry) => entry.capability);

  const guardedSet = new Set<Capability>(guarded);
  const unguardedSet = new Set<Capability>(unguarded);

  if (guardedSet.size !== guarded.length) {
    throw new Error(
      'role-operation-grid: a capability is mapped to more than one guarded operation.',
    );
  }
  if (unguardedSet.size !== unguarded.length) {
    throw new Error('role-operation-grid: a capability is listed as unguarded more than once.');
  }

  const overlap = guarded.filter((cap) => unguardedSet.has(cap));
  if (overlap.length > 0) {
    throw new Error(
      `role-operation-grid: capability listed as both guarded and unguarded: ${overlap.join(', ')}.`,
    );
  }

  const known = new Set<Capability>(capabilities);
  const uncovered = capabilities.filter((cap) => !guardedSet.has(cap) && !unguardedSet.has(cap));
  if (uncovered.length > 0) {
    throw new Error(
      `role-operation-grid: capability with no guarded operation and no unguarded reason: ${uncovered.join(', ')}. ` +
        'Map it to a representative route in GUARDED_OPERATIONS, or record why it has no route guard in UNGUARDED_CAPABILITIES.',
    );
  }

  const stale = [...guarded, ...unguarded].filter((cap) => !known.has(cap));
  if (stale.length > 0) {
    throw new Error(
      `role-operation-grid: catalog names a capability that is not in CAPABILITIES: ${stale.join(', ')}.`,
    );
  }
}
