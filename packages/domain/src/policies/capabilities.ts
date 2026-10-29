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
  // ---- platform-admin v2 · PA-01 (SPEC §3.3) ----
  // The permission matrix (areas × view/create/edit/delete/approve/export/manage) needs one
  // capability per meaningful cell. Appended, never inserted: a custom role key's mask is rebuilt
  // from `custom_roles.capabilities_json` on every request, and appending keeps every existing
  // nibble where it was. SPEC §3.3 calls them "22"; its bold list names 24 and every one is kept,
  // so the list is 56 long.
  'project.delete',
  'work.delete',
  'work.export',
  'conversation.delete',
  'conversation.export',
  'doc.delete',
  'doc.export',
  'decision.read',
  'decision.write',
  'decision.delete',
  'meeting.delete',
  'file.delete',
  'storage.manage',
  'people.view',
  'people.invite',
  'people.edit',
  'roles.assign',
  'billing.view',
  'billing.manage',
  'settings.view',
  'ai.use',
  'ai.manage',
  'report.view',
  'report.export',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** PA-01: the capabilities SPEC §3.3 added (its bold cells), in `CAPABILITIES` order. */
export const MATRIX_NEW_CAPABILITIES: readonly Capability[] = [
  'project.delete',
  'work.delete',
  'work.export',
  'conversation.delete',
  'conversation.export',
  'doc.delete',
  'doc.export',
  'decision.read',
  'decision.write',
  'decision.delete',
  'meeting.delete',
  'file.delete',
  'storage.manage',
  'people.view',
  'people.invite',
  'people.edit',
  'roles.assign',
  'billing.view',
  'billing.manage',
  'settings.view',
  'ai.use',
  'ai.manage',
  'report.view',
  'report.export',
];

/** `12-PERMISSION-MATRIX.md` §1. Internal principals. */
export const INTERNAL_ROLES = [
  'owner',
  'org_admin',
  'workspace_admin',
  'manager',
  'moderator',
  'member',
  'guest',
  /**
   * platform-admin v2 · PA-01 (SPEC P3, §3.2). The hidden membership a TManage platform admin
   * holds while a Support session is live in this organization: the full ceiling, org-wide
   * scope, internal. Never offered in a role picker and never granted through an org route
   * (`role-grant-ceiling.ts` refuses it); only the Support-session service writes it, and the
   * membership resolver accepts it only while its `platform_support_sessions` row is live.
   * Listed last so the "most-privileged first" order of the real roles is unchanged.
   */
  'platform_support',
] as const;

/** The internal role only a Support session writes; never assignable from an org screen. */
export const PLATFORM_SUPPORT_ROLE = 'platform_support' as const;

/**
 * The internal roles a person can be given from an organization screen or seeded as a real
 * member: every internal role except the hidden Support-session role. Role pickers, role grids
 * and per-role test sweeps iterate this; `INTERNAL_ROLES` is the full vocabulary the resolver
 * and the ceiling table know.
 */
export const ASSIGNABLE_INTERNAL_ROLES = [
  'owner',
  'org_admin',
  'workspace_admin',
  'manager',
  'moderator',
  'member',
  'guest',
] as const satisfies readonly (typeof INTERNAL_ROLES)[number][];

/** Is this the hidden Support-session role? */
export function isPlatformSupportRole(role: string): boolean {
  return role === PLATFORM_SUPPORT_ROLE;
}

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

  /** PA-01. A live Support session acts with the owner's ceiling (SPEC P3). */
  platform_support: [...CAPABILITIES],

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
    // PA-01 (SPEC §3.3): every new matrix capability except billing, settings, roles and the AI
    // connector's administration.
    'project.delete',
    'work.delete',
    'work.export',
    'conversation.delete',
    'conversation.export',
    'doc.delete',
    'doc.export',
    'decision.read',
    'decision.write',
    'decision.delete',
    'meeting.delete',
    'file.delete',
    'storage.manage',
    'people.view',
    'people.invite',
    'people.edit',
    'ai.use',
    'report.view',
    'report.export',
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
    // PA-01 (SPEC §3.3): delete on their projects' work, docs, meetings, decisions and files (the
    // project relation still gates which projects), the exports, and the member set below.
    // `conversation.delete` keeps the authority over other people's messages `conversation.moderate`
    // gives a manager.
    'work.delete',
    'work.export',
    'conversation.delete',
    'conversation.export',
    'doc.delete',
    'doc.export',
    'decision.read',
    'decision.write',
    'decision.delete',
    'meeting.delete',
    'file.delete',
    'people.view',
    'ai.use',
    'report.view',
    'report.export',
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
    // PA-01 (SPEC §3.3): a moderator deletes messages; the decision register keeps the reach it
    // had through `meeting.*`; plus the member set (directory, reports, AI connector).
    'conversation.delete',
    'decision.read',
    'decision.write',
    'people.view',
    'ai.use',
    'report.view',
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
    // PA-01 (SPEC §3.3): directory, reports, AI connector, and the decision register.
    'decision.read',
    'decision.write',
    'people.view',
    'ai.use',
    'report.view',
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
    // PA-01 (SPEC §3.3): the directory and reading decisions. `report.view` and `ai.use` keep what
    // a guest already reached through `work.read` before insights and token minting moved.
    'decision.read',
    'people.view',
    'ai.use',
    'report.view',
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
 * A custom role (Control > Roles, ADM-08) as a principal carries it: a value that names the
 * role AND the capability set the server loaded for it on this request.
 *
 * `memberships.role` stores a custom role's id. The id alone says nothing about what the role
 * may do, and every `hasCapability(principal.role, ...)` call site only has the role value in
 * hand, so the membership resolver builds this key from the tenant-scoped `custom_roles` row
 * and puts it on the principal. The key is `custom:<role id>:<hex mask over CAPABILITIES>`:
 * pure, built per request (so an edited role is honoured on the next request, with no cache to
 * go stale) and short enough for any column a role name is compared against.
 *
 * It is a branded string, so it can only be produced by {@link customRoleKey} without a cast,
 * and a raw stored value can never pass for one. Only allowlisted capabilities are encoded —
 * an unknown string in the stored JSON is dropped, never granted. A custom role is an
 * internal role: {@link isClientRole} is false for it, and the internal-only guard in
 * `authorize()` still refuses an internal-only capability to any client principal.
 */
declare const customRoleKeyBrand: unique symbol;
export type CustomRoleKey = string & { readonly [customRoleKeyBrand]: true };

/** What a principal's role can be: a built-in role, or a custom role with its loaded set. */
export type PrincipalRole = Role | CustomRoleKey;

const CUSTOM_ROLE_PREFIX = 'custom:';
const CUSTOM_ROLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MASK_LENGTH = Math.ceil(CAPABILITIES.length / 4);
const CUSTOM_ROLE_KEY = new RegExp(`^custom:([0-9a-f-]{36}):([0-9a-f]{${MASK_LENGTH}})$`);

/** Is this a well-formed custom role id (a lowercase UUID, as `custom_roles.id` stores it)? */
export function isCustomRoleId(value: string): boolean {
  return CUSTOM_ROLE_ID.test(value);
}

/** Build the principal role for a custom role from its id and its stored capability list. */
export function customRoleKey(customRoleId: string, capabilities: Iterable<string>): CustomRoleKey {
  if (!isCustomRoleId(customRoleId)) throw new Error('custom role id is not a lowercase UUID');
  const held = new Set<string>(capabilities);
  let mask = '';
  for (let start = 0; start < CAPABILITIES.length; start += 4) {
    let nibble = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      const capability = CAPABILITIES[start + bit];
      if (capability !== undefined && held.has(capability)) nibble |= 1 << bit;
    }
    mask += nibble.toString(16);
  }
  return `${CUSTOM_ROLE_PREFIX}${customRoleId}:${mask}` as CustomRoleKey;
}

interface DecodedCustomRole {
  readonly id: string;
  readonly set: ReadonlySet<Capability>;
  readonly list: readonly Capability[];
}

/** Decoding is pure; the memo only saves re-parsing the same key, so it can never go stale. */
const DECODED = new Map<string, DecodedCustomRole>();
const DECODED_LIMIT = 1024;

function decodeCustomRole(role: string): DecodedCustomRole | null {
  const cached = DECODED.get(role);
  if (cached) return cached;
  const match = CUSTOM_ROLE_KEY.exec(role);
  if (!match) return null;
  const [, id, mask] = match;
  if (id === undefined || mask === undefined || !isCustomRoleId(id)) return null;
  const list = CAPABILITIES.filter((_capability, index) => {
    const nibble = Number.parseInt(mask.charAt(Math.floor(index / 4)), 16);
    return (nibble & (1 << (index % 4))) !== 0;
  });
  const decoded: DecodedCustomRole = Object.freeze({
    id,
    set: new Set<Capability>(list),
    list: Object.freeze(list),
  });
  if (DECODED.size >= DECODED_LIMIT) DECODED.clear();
  DECODED.set(role, decoded);
  return decoded;
}

/** Is this value a custom role key built by {@link customRoleKey}? */
export function isCustomRoleKey(role: string): role is CustomRoleKey {
  return decodeCustomRole(role) !== null;
}

/** The custom role id inside a principal role, or null for a built-in role. */
export function customRoleIdOf(role: string): string | null {
  return decodeCustomRole(role)?.id ?? null;
}

const EMPTY_SET: ReadonlySet<Capability> = new Set<Capability>();

/**
 * The capability set a principal role holds: a built-in role's ceiling, or exactly the custom
 * role's loaded set. Any other string holds nothing — deny by default, never a crash.
 */
export function capabilitySetFor(role: string): ReadonlySet<Capability> {
  if (isRole(role)) return CEILING_SETS[role];
  return decodeCustomRole(role)?.set ?? EMPTY_SET;
}

/**
 * Does this role's ceiling permit the capability at all? For a custom role, is the capability
 * in the set its row grants?
 *
 * Not an authorization decision. See the file header.
 */
export function hasCapability(role: PrincipalRole, capability: Capability): boolean {
  return capabilitySetFor(role).has(capability);
}

export function capabilitiesFor(role: PrincipalRole): readonly Capability[] {
  if (isRole(role)) return CAPABILITY_CEILING[role];
  return decodeCustomRole(role)?.list ?? [];
}

/**
 * Parse a custom role's stored `capabilities_json` defensively, keeping only allowlisted
 * capability names. Malformed JSON, a non-array, or an unknown string grants nothing.
 */
export function parseCustomRoleCapabilities(json: string): readonly Capability[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const stored = new Set<unknown>(parsed);
  return CAPABILITIES.filter((capability) => stored.has(capability));
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
  // PA-01 (SPEC §3.3): every new matrix capability is internal-only. Client roles gain nothing,
  // and no per-member override can widen a client principal past this guard.
  ...MATRIX_NEW_CAPABILITIES,
];

const INTERNAL_ONLY_SET: ReadonlySet<Capability> = new Set(INTERNAL_ONLY_CAPABILITIES);

export function isInternalOnlyCapability(capability: Capability): boolean {
  return INTERNAL_ONLY_SET.has(capability);
}
