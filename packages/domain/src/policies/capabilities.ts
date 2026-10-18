/**
 * Capabilities and the role -> capability ceiling.
 *
 * Sources: `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §4 (capability list) and
 * `12-PERMISSION-MATRIX.md` §2 (role matrix).
 *
 * ## What this file is, and what it is not
 *
 * A capability grant here is a **ceiling**, not an authorization. `12-PERMISSION-MATRIX.md` §1:
 * "Roles grant capability ceilings. Actual access also requires tenant membership,
 * project/object relation, audience, direct share, policy, and active account."
 *
 * So `hasCapability()` answering `true` means only "this role is not categorically barred".
 * Every real decision runs the full evaluator in `authorize.ts`, which additionally checks
 * tenant, relation, audience, object state, and account status. Nothing in the API may
 * authorize on a capability check alone — that is what the deny-by-default evaluator is for.
 */

export const CAPABILITIES = [
  'org.manage',
  'org.security.manage',
  'workspace.manage',
  'project.create',
  'project.manage',
  'project.member.manage',
  'conversation.read',
  'conversation.write',
  'conversation.moderate',
  'work.read',
  'work.create',
  'work.update',
  'work.transition',
  /**
   * CAL-01 / MTG-01 (x90). Meetings have no row in `12-PERMISSION-MATRIX.md` §2, so their
   * ceiling is not a transcription but a decision, recorded here and mirrored in the
   * hand-written fixture: a meeting is internal project content of exactly the kind a work
   * item is, so `meeting.read` is granted to the roles that hold `work.read` and
   * `meeting.write` to the roles that hold `work.create` (internal, minus guest, who may read
   * internal work but not originate it). Both are internal-only (see below); no client
   * projection of a meeting is defined, so no client role holds either. Widening client access
   * would be a `12-PERMISSION-MATRIX` / `25 §4` edit and a product decision, not this slice.
   */
  'meeting.read',
  'meeting.write',
  /**
   * DOC-01 (x91). Documents have no row in `12-PERMISSION-MATRIX.md` §2, so their ceiling is not
   * a transcription but a decision, recorded here and mirrored in the hand-written fixture: a
   * document is internal project content of exactly the kind a work item (and a meeting) is, so
   * `doc.read` is granted to the roles that hold `work.read` and `doc.write` to the roles that
   * hold `work.create` (internal, minus guest, who may read internal work but not originate it).
   * Both are internal-only (see below): doc 38 marks docs "collaboration later" and no client
   * projection of a document is defined, so no client role holds either. Widening client access
   * would be a `12-PERMISSION-MATRIX` / `25 §4` edit and a product decision, not this slice.
   */
  'doc.read',
  'doc.write',
  /**
   * CLIENT-002. `12-PERMISSION-MATRIX` §1 has a "View client projection" row and this
   * codebase had no capability for it, so the one surface every client role exists to read
   * could not be authorized at all.
   *
   * It is the **only** read capability a client principal holds. `work.read` is internal-only
   * and always will be: §2 gives every client role "View internal project: Never", and the
   * portal serves the projection described in §4 rather than the internal record.
   */
  'client_projection.read',
  'client_request.submit',
  'client_request.triage',
  'deliverable.create',
  'deliverable.review',
  'deliverable.publish',
  'approval.read',
  'approval.decide',
  'client_member.manage',
  'audit.read',
  'audit.export',
  'member.offboard',
  'file.upload',
  'file.download',
  'search.use',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** `12-PERMISSION-MATRIX.md` §1. Internal principals. */
export const INTERNAL_ROLES = [
  'owner',
  'org_admin',
  'workspace_admin',
  'manager',
  'moderator',
  'member',
  'guest',
] as const;

/**
 * The roles a person can hold *on a project* — a subset of {@link INTERNAL_ROLES}.
 *
 * `owner`, `org_admin` and `workspace_admin` describe a person's place in the organization, not
 * on one project, so the project team list never offers them (ADM-17). `moderator` is a chat
 * role. Ordered most-privileged first, like `INTERNAL_ROLES`. A `project_memberships` row written
 * before this list existed may still carry another internal role; it is shown and can be changed
 * away from, but never newly assigned.
 */
export const PROJECT_ROLES = ['manager', 'member', 'guest'] as const;

/** The project role the person who creates a project receives (PRJ-01). */
export const PROJECT_CREATOR_ROLE = 'manager' as const;

/** `12-PERMISSION-MATRIX.md` §1. External principals. */
export const CLIENT_ROLES = [
  'client_admin',
  'client_reviewer',
  'client_member',
  'client_viewer',
] as const;

export type InternalRole = (typeof INTERNAL_ROLES)[number];
export type ClientRole = (typeof CLIENT_ROLES)[number];
export type ProjectRole = (typeof PROJECT_ROLES)[number];
export type Role = InternalRole | ClientRole;

/**
 * Which kind of principal is acting.
 *
 * Carried on the immutable `TenantContext` built by the API after it confirms an active
 * membership (`25-AUTH-AND-TENANT-ISOLATION` §2). Never read from a header, body, query
 * string, job payload, or browser storage.
 */
export type PrincipalKind = 'internal' | 'client' | 'service';

/**
 * The role predicates take `string`, not `Role`.
 *
 * They are not only used to discriminate a value already known to be a role. `memberships.role`
 * and `client_memberships.role` are `VARCHAR(64)` — the schema cannot express "one of eleven
 * names" — so the value that arrives when a session is resolved into a `TenantContext` is an
 * arbitrary string until something checks it. These are that check, and a signature demanding
 * `Role` would have forced the caller to assert the very thing it wanted verified.
 *
 * Widening the parameter does not weaken the predicate: each still answers by membership of
 * the frozen list above.
 */
export function isClientRole(role: string): role is ClientRole {
  return (CLIENT_ROLES as readonly string[]).includes(role);
}

export function isInternalRole(role: string): role is InternalRole {
  return (INTERNAL_ROLES as readonly string[]).includes(role);
}

export function isProjectRole(role: string): role is ProjectRole {
  return (PROJECT_ROLES as readonly string[]).includes(role);
}

export function isRole(role: string): role is Role {
  return isInternalRole(role) || isClientRole(role);
}

/**
 * Role -> capability ceiling, transcribed from `12-PERMISSION-MATRIX.md` §2.
 *
 * Where the matrix says "Policy", the capability is granted here and the organization
 * policy narrows it at evaluation time. §4 of the tenant-isolation spec is explicit that
 * organization policy "may narrow access and may never silently widen external access",
 * so a capability absent here can never be re-granted by policy.
 */
const CAPABILITY_CEILING: Readonly<Record<Role, readonly Capability[]>> = {
  owner: [...CAPABILITIES],

  /**
   * ADM-03. §2 reads "Billing/ownership: Policy" for Org Admin, and a `Policy` cell is granted in
   * the ceiling (the header above), so `org.manage` belongs here. Leaving it out locked the
   * organization admin out of nine of the fourteen Control Center pages. The owner-only acts
   * (inviting or offboarding an owner, reassigning an owner's seat) are refused where they happen,
   * not by withholding the whole capability.
   */
  org_admin: [...CAPABILITIES],

  workspace_admin: [
    'workspace.manage',
    'project.create',
    'project.manage',
    'project.member.manage',
    'conversation.read',
    'conversation.write',
    'conversation.moderate',
    'work.read',
    'work.create',
    'work.update',
    'work.transition',
    // x90: meetings mirror the internal work ceiling. read = work.read roles, write =
    // work.create roles.
    'meeting.read',
    'meeting.write',
    // x91: documents mirror the internal work ceiling too (read = work.read, write = work.create).
    'doc.read',
    'doc.write',
    // §2 "View client projection: Scope" — an internal admin can read what a client reads,
    // which is how anybody checks what was published before a client sees it.
    'client_projection.read',
    'client_request.triage',
    'deliverable.create',
    'deliverable.review',
    'deliverable.publish',
    'approval.read',
    'approval.decide',
    'client_member.manage',
    // §2 "View audit log": Workspace Admin is workspace-scoped, not org-wide. The scope
    // narrowing is applied by the evaluator; the capability itself is present.
    'audit.read',
    'member.offboard',
    'file.upload',
    'file.download',
    'search.use',
  ],

  manager: [
    // §2 "Workspace settings: Limited" — narrowed by the evaluator to owned projects.
    'project.manage',
    'project.member.manage',
    // §2 "Create project: Policy" — organization policy decides; ceiling permits it.
    'project.create',
    'conversation.read',
    'conversation.write',
    'conversation.moderate',
    'work.read',
    'work.create',
    'work.update',
    'work.transition',
    // x90: meetings mirror the internal work ceiling (read = work.read, write = work.create).
    'meeting.read',
    'meeting.write',
    // x91: documents mirror the internal work ceiling too (read = work.read, write = work.create).
    'doc.read',
    'doc.write',
    // §2 "View client projection: Project".
    'client_projection.read',
    'client_request.triage',
    'deliverable.create',
    'deliverable.review',
    'deliverable.publish',
    'approval.read',
    'approval.decide',
    'client_member.manage',
    'audit.read',
    'file.upload',
    'file.download',
    'search.use',
  ],

  moderator: [
    'conversation.read',
    'conversation.write',
    'conversation.moderate',
    'work.read',
    // §2 "Create/edit work: Policy" for Moderator.
    'work.create',
    'work.update',
    'work.transition',
    // x90: meetings mirror the internal work ceiling (read = work.read, write = work.create).
    'meeting.read',
    'meeting.write',
    // x91: documents mirror the internal work ceiling too (read = work.read, write = work.create).
    'doc.read',
    'doc.write',
    // §2 "View client projection: Project".
    'client_projection.read',
    // §2 "Publish to client: Optional" — off unless organization policy enables it.
    'deliverable.create',
    'deliverable.review',
    'approval.read',
    'approval.decide',
    'file.upload',
    'file.download',
    'search.use',
  ],

  member: [
    'conversation.read',
    'conversation.write',
    'work.read',
    'work.create',
    'work.update',
    'work.transition',
    // x90: meetings mirror the internal work ceiling (read = work.read, write = work.create).
    'meeting.read',
    'meeting.write',
    // x91: documents mirror the internal work ceiling too (read = work.read, write = work.create).
    'doc.read',
    'doc.write',
    // §2 "View client projection: Project".
    'client_projection.read',
    'deliverable.create',
    'deliverable.review',
    'approval.read',
    // §2 "Approve governed version: If reviewer" — the relation check is the real gate.
    'approval.decide',
    // §2 "View audit log: Own activity" — scope narrowed by the evaluator.
    'audit.read',
    'file.upload',
    'file.download',
    'search.use',
  ],

  guest: [
    // §2: Guest sees an internal project only by explicit grant, and edits work only
    // where explicitly granted. Relation checks carry all of the weight here.
    'conversation.read',
    'work.read',
    'work.update',
    // x90: a guest reads internal work (`work.read`) but does not originate it (no
    // `work.create`); meetings follow the same line — read yes, write no.
    'meeting.read',
    // x91: documents follow the same line — a guest reads internal documents (`doc.read`) but
    // does not originate them (no `doc.write`), mirroring `work.read` / no `work.create`.
    'doc.read',
    // §2 "View client projection: Explicit" — the relation check carries all of the weight.
    'client_projection.read',
    'approval.read',
    'approval.decide',
    'file.download',
    'search.use',
  ],

  // ── Client roles ────────────────────────────────────────────────────────────
  // No client role can ever hold a capability that reads internal content. The absence
  // of `conversation.read`, `work.read`, `deliverable.review`, and `audit.export` here is
  // load-bearing: client surfaces read the client projection, never the internal record.

  client_admin: [
    // §2 "View client projection: Client org". The one read every client role has.
    'client_projection.read',
    'client_request.submit',
    'approval.read',
    // §2 "Approve governed version: Policy" for Client Admin.
    'approval.decide',
    // §2 "Invite client users: Within own client org/policy".
    'client_member.manage',
    // §2 "View audit log: Client-side subset".
    'audit.read',
    'file.upload',
    'file.download',
  ],

  client_reviewer: [
    // §2 "View client projection: Assigned/shared".
    'client_projection.read',
    'client_request.submit',
    'approval.read',
    'approval.decide',
    // §2 "View audit log: Own decisions".
    'audit.read',
    'file.upload',
    'file.download',
  ],

  client_member: [
    // §2 "View client projection: Shared".
    'client_projection.read',
    'client_request.submit',
    'approval.read',
    // §2 "Approve governed version: If assigned".
    'approval.decide',
    'audit.read',
    'file.upload',
    'file.download',
  ],

  client_viewer: [
    // §2 "View client projection: Shared". A viewer reads and does nothing else.
    'client_projection.read',
    // §2 "Submit client request: Policy" for Client Viewer — ceiling allows, policy decides.
    'client_request.submit',
    'approval.read',
    // §2 "Approve governed version: No" — deliberately absent.
    'file.download',
  ],
};

/** Every role, exhaustive over `Role` by construction. */
const ALL_ROLES = [...INTERNAL_ROLES, ...CLIENT_ROLES] as const;

/**
 * Precomputed lookup sets, so `hasCapability` is O(1) rather than a linear array scan on
 * every authorization decision.
 *
 * Built by reducing over `ALL_ROLES` rather than `Object.entries`, because `Object.entries`
 * widens the key to `string` and loses the guarantee that every `Role` is populated.
 */
const CEILING_SETS: Readonly<Record<Role, ReadonlySet<Capability>>> = Object.freeze(
  ALL_ROLES.reduce(
    (acc, role) => {
      acc[role] = new Set<Capability>(CAPABILITY_CEILING[role]);
      return acc;
    },
    {} as Record<Role, Set<Capability>>,
  ),
);

/**
 * Does this role's ceiling permit the capability at all?
 *
 * Not an authorization decision. See the file header.
 */
export function hasCapability(role: Role, capability: Capability): boolean {
  return CEILING_SETS[role].has(capability);
}

export function capabilitiesFor(role: Role): readonly Capability[] {
  return CAPABILITY_CEILING[role];
}

/**
 * Capabilities that no external principal may ever hold, under any role, policy, or share.
 *
 * This is a second, independent guard over the table above: even if a future edit
 * mistakenly adds one of these to a client role, `authorize.ts` refuses it. Belt and
 * braces, because the cost of getting this wrong is a client seeing internal content.
 */
export const INTERNAL_ONLY_CAPABILITIES: readonly Capability[] = [
  'org.manage',
  'org.security.manage',
  'workspace.manage',
  'project.create',
  'project.manage',
  'project.member.manage',
  'conversation.read',
  'conversation.write',
  'conversation.moderate',
  'work.read',
  'work.create',
  'work.update',
  'work.transition',
  // x90: meetings are internal — no client projection is defined, so deny client access by
  // default, the belt-and-braces second guard `authorize.ts` applies over the ceiling table.
  'meeting.read',
  'meeting.write',
  // x91: documents are internal too — doc 38 marks docs "collaboration later" and no client
  // projection of a document is defined, so deny client access by default, the same belt-and-
  // braces second guard `authorize.ts` applies over the ceiling table.
  'doc.read',
  'doc.write',
  'client_request.triage',
  'deliverable.create',
  'deliverable.review',
  'deliverable.publish',
  'audit.export',
  'member.offboard',
  'search.use',
];

const INTERNAL_ONLY_SET: ReadonlySet<Capability> = new Set(INTERNAL_ONLY_CAPABILITIES);

export function isInternalOnlyCapability(capability: Capability): boolean {
  return INTERNAL_ONLY_SET.has(capability);
}
