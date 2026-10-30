/**
 * The hand-written permission matrix — an independent restatement of
 * `docs/planning/12-PERMISSION-MATRIX.md` §2.
 *
 * ## Why this file exists
 *
 * Three permission tests used to derive their expected answer from the code under test:
 *
 * - `apps/api/test/test-001-role-matrix.db.test.ts` read `hasCapability(role, capability)`
 *   as its `expected` (finding D18 / C1);
 * - `apps/worker/src/consumers/client-request-notifications.test.ts` compared
 *   `mayTriageClientRequests(...)` against `hasCapability(role, 'client_request.triage')`,
 *   which for an org-wide candidate is the very expression the function evaluates — `X === X`
 *   over eleven iterations (C2);
 * - `apps/api/test/membership-resolver.db.test.ts` asserted `context.capabilities` equals
 *   `capabilitiesFor(role)`, the exact call the resolver makes to build it (C3).
 *
 * Each of those reads the ceiling table it is meant to check, so both sides of the comparison
 * move together and a widened ceiling stays green. This file is the missing second opinion:
 * a human read §2 of the matrix document and typed out, for every one of the eleven roles,
 * which of the thirty capabilities that role holds and which it does not. It imports
 * **no** value from `@tmanage/domain` — only the `Capability` and `Role` types, which are the
 * vocabulary, not the answer. Nothing here is computed from `hasCapability`,
 * `capabilitiesFor`, or `CAPABILITY_CEILING`.
 *
 * ## The one rule for editing it
 *
 * Change a line here **only** after reading `12-PERMISSION-MATRIX.md` §2 and concluding the
 * document says so. Never change a line here to make a test pass. If
 * `apps/api/src/common/http/guards/permission-matrix-fixture.test.ts` fails, the product's
 * ceiling and this transcription disagree, and that is a question for a person: either the
 * ceiling drifted (fix the ceiling) or the matrix document changed (fix this file, and cite
 * the change).
 *
 * ## Which §2 row each capability is transcribed from
 *
 * §2 has fifteen rows; `25-AUTH-AND-TENANT-ISOLATION` §4 names thirty capabilities, so
 * several capabilities share a row. The mapping used throughout this file:
 *
 * | §2 row                    | capabilities                                                   |
 * | ------------------------- | -------------------------------------------------------------- |
 * | Billing/ownership         | `org.manage`                                                    |
 * | Org security/SSO          | `org.security.manage`                                           |
 * | Workspace settings        | `workspace.manage`, `project.manage`, `member.offboard`         |
 * | Create project            | `project.create`                                                |
 * | Manage project members    | `project.member.manage`                                         |
 * | View internal project     | `conversation.read`, `work.read`, `search.use`                  |
 * | Moderate messages         | `conversation.write`, `conversation.moderate`                   |
 * | Create/edit work          | `work.create`, `work.update`, `work.transition`, `file.upload`  |
 * | Publish to client         | `deliverable.create`, `deliverable.review`, `deliverable.publish` |
 * | View client projection    | `client_projection.read`, `file.download`                       |
 * | Submit client request     | `client_request.submit`                                         |
 * | Approve governed version  | `approval.read`, `approval.decide`                              |
 * | Invite client users       | `client_member.manage`                                          |
 * | View audit log            | `audit.read`                                                    |
 * | Export tenant             | `audit.export`                                                  |
 *
 * `client_request.triage` has **no** §2 row — §2 only states who *submits*. Its source is
 * `23-ERD-AND-STATE-MACHINES.md` §6 ("Only internal manager may accept/defer/decline") read
 * with `21-REQUIREMENTS-TRACEABILITY.md` FR-01 ("client member submits; project manager
 * triages") and its role table row ("Manager | triage, plan, blocker, publish, approval"):
 * manager and the three administrative tiers above manager, nobody else. That secondary
 * source is named again on every role's `client_request.triage` line below.
 *
 * `meeting.read` and `meeting.write` (x90) also have **no** §2 row. Doc 12 has no meeting
 * entry, so their ceiling is a decision rather than a transcription: a meeting is internal
 * project content of the same kind a work item is, so `meeting.read` mirrors the roles that
 * hold `work.read` and `meeting.write` mirrors those that hold `work.create` (internal minus
 * guest). Recorded in `packages/domain/src/policies/capabilities.ts`; every meeting line below
 * cites that decision rather than a §2 cell.
 *
 * `doc.read` and `doc.write` (x91) are the same shape of decision: doc 12 has no document row,
 * a document is internal project content of the same kind a work item and a meeting are, so
 * `doc.read` mirrors `work.read`'s roles and `doc.write` mirrors `work.create`'s (internal minus
 * guest). Recorded in the same capabilities file; every doc line below cites that decision.
 *
 * ## platform-admin v2 · PA-01 — the 24 matrix capabilities and `platform_support`
 *
 * The capabilities `project.delete` … `report.export` have no §2 row either; their source is the
 * ceiling paragraph under the matrix table in the platform-admin SPEC §3.3 ("owner/org_admin get
 * all; workspace_admin gets all but billing/settings/roles/ai.manage; manager gets delete on own
 * projects' work/docs/meetings/decisions + export; moderator gets `conversation.delete`; member
 * gets `people.view`, `report.view`, `ai.use`, `decision.read/write`; guest gets `people.view`,
 * `decision.read`; client roles gain nothing"). Three readings are flagged: the moderator keeps
 * the member set and the decision register it reached through `meeting.*`; the guest keeps
 * `report.view` and `ai.use` it reached through `work.read` before insights and token minting
 * moved; manager holds `file.delete`, the delete of the files area. Each such line cites
 * "SPEC §3.3 ceiling paragraph". `platform_support` (SPEC §3.2) is transcribed as the owner.
 *
 * ## How the qualifying words in §2 are read
 *
 * §2's cells are not booleans. A ceiling is "is this role categorically barred?", so:
 *
 * - `Full`, `Yes`, `Scope`, `Project`, `Member`, `Explicit`, `Assigned/shared`, `Shared`,
 *   `Client org`, `Own activity`, `Own decisions`, `If reviewer`, `If assigned`,
 *   `Workspace scope`, `Limited`, `Owner` → **granted**; the qualifier is a relation, scope or
 *   audience narrowing that `authorize()` applies at decision time.
 * - `Policy` → **granted**. §1 and §4 of the authorization spec both say organization policy
 *   "may narrow access and may never silently widen external access", so a policy-gated cell
 *   must exist in the ceiling for policy to have anything to narrow.
 * - `Optional` → **denied**. Unlike `Policy`, `Optional` is read as off by default; the
 *   capability is absent until the organization turns the feature on, which is a ceiling
 *   change, not a narrowing. This affects only `deliverable.publish` for Moderator and Member.
 * - `No`, `Never` → **denied**.
 * - `Own only` → **denied** for `conversation.moderate`: acting on your own message is
 *   `conversation.write`, and the moderation capability is the authority over *other people's*
 *   messages.
 *
 * Those four readings — `Optional`, `Own only`, `Limited`, and guest's `Explicit` — are the
 * places where §2's prose does not reduce to a boolean on its own. Each is flagged again at
 * the line it decides, so a reviewer can disagree with the reading without hunting for it.
 */
import type { Capability, Role } from '@tmanage/domain';

/**
 * One role's row of §2, stated in both directions.
 *
 * Both lists are written out. `denied` is not "everything not in `granted`" — writing the
 * denials by hand is what makes a newly added capability a compile-and-test failure instead
 * of a silent default, and it is what lets a reader check this file against §2 by eye without
 * holding the capability list in their head.
 */
export interface RolePermissionRow {
  /** Capabilities §2 places inside this role's ceiling. */
  readonly granted: readonly Capability[];
  /** Capabilities §2 places outside it. */
  readonly denied: readonly Capability[];
}

/**
 * `12-PERMISSION-MATRIX.md` §2, transcribed by hand, role by role.
 *
 * Read a column of §2 top to bottom and you should be able to walk one entry below in the
 * same order: the `granted` and `denied` lists are both written in the capability order of
 * `25-AUTH-AND-TENANT-ISOLATION` §4, and every line carries the §2 row and the literal cell
 * value it came from.
 */
export const PERMISSION_MATRIX: Readonly<Record<Role, RolePermissionRow>> = {
  // ── Internal principals ─────────────────────────────────────────────────────
  /**
   * §2's Owner column has an entry in every row and a denial in exactly one: "Submit client
   * request | No". An owner is an internal principal and internal principals do not raise
   * client requests; the request table has no row shape for one.
   */
  owner: {
    granted: [
      // x90: meetings have no §2 row; ceiling decided to mirror internal work (read =
      // work.read roles, write = work.create roles). Recorded in capabilities.ts.
      'meeting.read',
      'meeting.write',
      // x91: documents have no §2 row either; ceiling mirrors internal work (read = work.read,
      // write = work.create). Recorded in capabilities.ts.
      'doc.read',
      'doc.write',
      'org.manage', // Billing/ownership: "Full"
      'org.security.manage', // Org security/SSO: "Full"
      'workspace.manage', // Workspace settings: "Full"
      'project.create', // Create project: "Yes"
      'project.manage', // Workspace settings: "Full"
      'project.member.manage', // Manage project members: "Yes"
      'conversation.read', // View internal project: "Scope"
      'conversation.write', // Moderate messages: "Scope"
      'conversation.moderate', // Moderate messages: "Scope"
      'work.read', // View internal project: "Scope"
      'work.create', // Create/edit work: "Scope"
      'work.update', // Create/edit work: "Scope"
      'work.transition', // Create/edit work: "Scope"
      'client_projection.read', // View client projection: "Scope"
      'client_request.triage', // no §2 row; 23-ERD §6 + 21-TRACEABILITY FR-01, manager and above
      'deliverable.create', // Publish to client: "Policy"
      'deliverable.review', // Publish to client: "Policy"
      'deliverable.publish', // Publish to client: "Policy"
      'approval.read', // Approve governed version: "If reviewer"
      'approval.decide', // Approve governed version: "If reviewer"
      'client_member.manage', // Invite client users: "Policy"
      'audit.read', // View audit log: "Full"
      'audit.export', // Export tenant: "Owner"
      'member.offboard', // Workspace settings: "Full"
      'file.upload', // Create/edit work: "Scope"
      'file.download', // View internal project: "Scope"
      'search.use', // View internal project: "Scope"
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'project.delete', // SPEC §3.3 ceiling paragraph
      'work.delete', // SPEC §3.3 ceiling paragraph
      'work.export', // SPEC §3.3 ceiling paragraph
      'conversation.delete', // SPEC §3.3 ceiling paragraph
      'conversation.export', // SPEC §3.3 ceiling paragraph
      'doc.delete', // SPEC §3.3 ceiling paragraph
      'doc.export', // SPEC §3.3 ceiling paragraph
      'decision.read', // SPEC §3.3 ceiling paragraph
      'decision.write', // SPEC §3.3 ceiling paragraph
      'decision.delete', // SPEC §3.3 ceiling paragraph
      'meeting.delete', // SPEC §3.3 ceiling paragraph
      'file.delete', // SPEC §3.3 ceiling paragraph
      'storage.manage', // SPEC §3.3 ceiling paragraph
      'people.view', // SPEC §3.3 ceiling paragraph
      'people.invite', // SPEC §3.3 ceiling paragraph
      'people.edit', // SPEC §3.3 ceiling paragraph
      'roles.assign', // SPEC §3.3 ceiling paragraph
      'billing.view', // SPEC §3.3 ceiling paragraph
      'billing.manage', // SPEC §3.3 ceiling paragraph
      'settings.view', // SPEC §3.3 ceiling paragraph
      'ai.use', // SPEC §3.3 ceiling paragraph
      'ai.manage', // SPEC §3.3 ceiling paragraph
      'report.view', // SPEC §3.3 ceiling paragraph
      'report.export', // SPEC §3.3 ceiling paragraph
      'finance.view', // 52-23 §10: finance reads, were project.manage
      'finance.manage', // 52-23 §10: finance writes, were workspace.manage
    ],
    denied: [
      'client_request.submit', // Submit client request: "No"
    ],
  },

  /**
   * §2's Org Admin column differs from Owner's in two rows: "Billing/ownership | Policy" and
   * "Export tenant | Policy" where Owner reads "Full" and "Owner". Both are `Policy`, so both
   * are granted here per the reading stated in the file header.
   */
  org_admin: {
    granted: [
      // x90: mirrors internal work (read = work.read, write = work.create). See owner.
      'meeting.read',
      'meeting.write',
      // x91: documents mirror internal work too (read = work.read, write = work.create). See owner.
      'doc.read',
      'doc.write',
      'org.manage', // Billing/ownership: "Policy"
      'org.security.manage', // Org security/SSO: "Full"
      'workspace.manage', // Workspace settings: "Full"
      'project.create', // Create project: "Yes"
      'project.manage', // Workspace settings: "Full"
      'project.member.manage', // Manage project members: "Yes"
      'conversation.read', // View internal project: "Scope"
      'conversation.write', // Moderate messages: "Scope"
      'conversation.moderate', // Moderate messages: "Scope"
      'work.read', // View internal project: "Scope"
      'work.create', // Create/edit work: "Scope"
      'work.update', // Create/edit work: "Scope"
      'work.transition', // Create/edit work: "Scope"
      'client_projection.read', // View client projection: "Scope"
      'client_request.triage', // no §2 row; 23-ERD §6 + 21-TRACEABILITY FR-01
      'deliverable.create', // Publish to client: "Policy"
      'deliverable.review', // Publish to client: "Policy"
      'deliverable.publish', // Publish to client: "Policy"
      'approval.read', // Approve governed version: "If reviewer"
      'approval.decide', // Approve governed version: "If reviewer"
      'client_member.manage', // Invite client users: "Policy"
      'audit.read', // View audit log: "Full"
      'audit.export', // Export tenant: "Policy"
      'member.offboard', // Workspace settings: "Full"
      'file.upload', // Create/edit work: "Scope"
      'file.download', // View internal project: "Scope"
      'search.use', // View internal project: "Scope"
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'project.delete', // SPEC §3.3 ceiling paragraph
      'work.delete', // SPEC §3.3 ceiling paragraph
      'work.export', // SPEC §3.3 ceiling paragraph
      'conversation.delete', // SPEC §3.3 ceiling paragraph
      'conversation.export', // SPEC §3.3 ceiling paragraph
      'doc.delete', // SPEC §3.3 ceiling paragraph
      'doc.export', // SPEC §3.3 ceiling paragraph
      'decision.read', // SPEC §3.3 ceiling paragraph
      'decision.write', // SPEC §3.3 ceiling paragraph
      'decision.delete', // SPEC §3.3 ceiling paragraph
      'meeting.delete', // SPEC §3.3 ceiling paragraph
      'file.delete', // SPEC §3.3 ceiling paragraph
      'storage.manage', // SPEC §3.3 ceiling paragraph
      'people.view', // SPEC §3.3 ceiling paragraph
      'people.invite', // SPEC §3.3 ceiling paragraph
      'people.edit', // SPEC §3.3 ceiling paragraph
      'roles.assign', // SPEC §3.3 ceiling paragraph
      'billing.view', // SPEC §3.3 ceiling paragraph
      'billing.manage', // SPEC §3.3 ceiling paragraph
      'settings.view', // SPEC §3.3 ceiling paragraph
      'ai.use', // SPEC §3.3 ceiling paragraph
      'ai.manage', // SPEC §3.3 ceiling paragraph
      'report.view', // SPEC §3.3 ceiling paragraph
      'report.export', // SPEC §3.3 ceiling paragraph
      'finance.view', // 52-23 §10: finance reads, were project.manage
      'finance.manage', // 52-23 §10: finance writes, were workspace.manage
    ],
    denied: [
      'client_request.submit', // Submit client request: "No"
    ],
  },
  /**
   * platform-admin v2 · PA-01 (SPEC P3, §3.2). The hidden Support-session membership. It is not
   * a §2 column: SPEC §3.2 gives it "the full capability ceiling", the owner's column, so it is
   * transcribed as the owner is — every capability, and "Submit client request: No" like every
   * internal column (the blanket grant is recorded as an accepted divergence below).
   */
  platform_support: {
    granted: [
      'meeting.read', // SPEC §3.2: full ceiling, as owner
      'meeting.write', // SPEC §3.2: full ceiling, as owner
      'doc.read', // SPEC §3.2: full ceiling, as owner
      'doc.write', // SPEC §3.2: full ceiling, as owner
      'org.manage', // SPEC §3.2: full ceiling, as owner
      'org.security.manage', // SPEC §3.2: full ceiling, as owner
      'workspace.manage', // SPEC §3.2: full ceiling, as owner
      'project.create', // SPEC §3.2: full ceiling, as owner
      'project.manage', // SPEC §3.2: full ceiling, as owner
      'project.member.manage', // SPEC §3.2: full ceiling, as owner
      'conversation.read', // SPEC §3.2: full ceiling, as owner
      'conversation.write', // SPEC §3.2: full ceiling, as owner
      'conversation.moderate', // SPEC §3.2: full ceiling, as owner
      'work.read', // SPEC §3.2: full ceiling, as owner
      'work.create', // SPEC §3.2: full ceiling, as owner
      'work.update', // SPEC §3.2: full ceiling, as owner
      'work.transition', // SPEC §3.2: full ceiling, as owner
      'client_projection.read', // SPEC §3.2: full ceiling, as owner
      'client_request.triage', // SPEC §3.2: full ceiling, as owner
      'deliverable.create', // SPEC §3.2: full ceiling, as owner
      'deliverable.review', // SPEC §3.2: full ceiling, as owner
      'deliverable.publish', // SPEC §3.2: full ceiling, as owner
      'approval.read', // SPEC §3.2: full ceiling, as owner
      'approval.decide', // SPEC §3.2: full ceiling, as owner
      'client_member.manage', // SPEC §3.2: full ceiling, as owner
      'audit.read', // SPEC §3.2: full ceiling, as owner
      'audit.export', // SPEC §3.2: full ceiling, as owner
      'member.offboard', // SPEC §3.2: full ceiling, as owner
      'file.upload', // SPEC §3.2: full ceiling, as owner
      'file.download', // SPEC §3.2: full ceiling, as owner
      'search.use', // SPEC §3.2: full ceiling, as owner
      'project.delete', // SPEC §3.2: full ceiling, as owner
      'work.delete', // SPEC §3.2: full ceiling, as owner
      'work.export', // SPEC §3.2: full ceiling, as owner
      'conversation.delete', // SPEC §3.2: full ceiling, as owner
      'conversation.export', // SPEC §3.2: full ceiling, as owner
      'doc.delete', // SPEC §3.2: full ceiling, as owner
      'doc.export', // SPEC §3.2: full ceiling, as owner
      'decision.read', // SPEC §3.2: full ceiling, as owner
      'decision.write', // SPEC §3.2: full ceiling, as owner
      'decision.delete', // SPEC §3.2: full ceiling, as owner
      'meeting.delete', // SPEC §3.2: full ceiling, as owner
      'file.delete', // SPEC §3.2: full ceiling, as owner
      'storage.manage', // SPEC §3.2: full ceiling, as owner
      'people.view', // SPEC §3.2: full ceiling, as owner
      'people.invite', // SPEC §3.2: full ceiling, as owner
      'people.edit', // SPEC §3.2: full ceiling, as owner
      'roles.assign', // SPEC §3.2: full ceiling, as owner
      'billing.view', // SPEC §3.2: full ceiling, as owner
      'billing.manage', // SPEC §3.2: full ceiling, as owner
      'settings.view', // SPEC §3.2: full ceiling, as owner
      'ai.use', // SPEC §3.2: full ceiling, as owner
      'ai.manage', // SPEC §3.2: full ceiling, as owner
      'report.view', // SPEC §3.2: full ceiling, as owner
      'report.export', // SPEC §3.2: full ceiling, as owner
      'finance.view', // 52-23 §10: finance reads, were project.manage
      'finance.manage', // 52-23 §10: finance writes, were workspace.manage
    ],
    denied: [
      'client_request.submit', // internal principal; same reading as owner
    ],
  },

  /**
   * Workspace Admin is the first column where §2 starts saying No: "Billing/ownership | No",
   * "Org security/SSO | No", "Export tenant | No".
   */
  workspace_admin: {
    granted: [
      // x90: mirrors internal work (read = work.read, write = work.create). See owner.
      'meeting.read',
      'meeting.write',
      // x91: documents mirror internal work too (read = work.read, write = work.create). See owner.
      'doc.read',
      'doc.write',
      'workspace.manage', // Workspace settings: "Full"
      'project.create', // Create project: "Yes"
      'project.manage', // Workspace settings: "Full"
      'project.member.manage', // Manage project members: "Yes"
      'conversation.read', // View internal project: "Scope"
      'conversation.write', // Moderate messages: "Scope"
      'conversation.moderate', // Moderate messages: "Scope"
      'work.read', // View internal project: "Scope"
      'work.create', // Create/edit work: "Scope"
      'work.update', // Create/edit work: "Scope"
      'work.transition', // Create/edit work: "Scope"
      'client_projection.read', // View client projection: "Scope"
      'client_request.triage', // no §2 row; 23-ERD §6 + 21-TRACEABILITY FR-01
      'deliverable.create', // Publish to client: "Policy"
      'deliverable.review', // Publish to client: "Policy"
      'deliverable.publish', // Publish to client: "Policy"
      'approval.read', // Approve governed version: "If reviewer"
      'approval.decide', // Approve governed version: "If reviewer"
      'client_member.manage', // Invite client users: "Policy"
      'audit.read', // View audit log: "Workspace scope"
      'member.offboard', // Workspace settings: "Full"
      'file.upload', // Create/edit work: "Scope"
      'file.download', // View internal project: "Scope"
      'search.use', // View internal project: "Scope"
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'project.delete', // SPEC §3.3 ceiling paragraph
      'work.delete', // SPEC §3.3 ceiling paragraph
      'work.export', // SPEC §3.3 ceiling paragraph
      'conversation.delete', // SPEC §3.3 ceiling paragraph
      'conversation.export', // SPEC §3.3 ceiling paragraph
      'doc.delete', // SPEC §3.3 ceiling paragraph
      'doc.export', // SPEC §3.3 ceiling paragraph
      'decision.read', // SPEC §3.3 ceiling paragraph
      'decision.write', // SPEC §3.3 ceiling paragraph
      'decision.delete', // SPEC §3.3 ceiling paragraph
      'meeting.delete', // SPEC §3.3 ceiling paragraph
      'file.delete', // SPEC §3.3 ceiling paragraph
      'storage.manage', // SPEC §3.3 ceiling paragraph
      'people.view', // SPEC §3.3 ceiling paragraph
      'people.invite', // SPEC §3.3 ceiling paragraph
      'people.edit', // SPEC §3.3 ceiling paragraph
      'ai.use', // SPEC §3.3 ceiling paragraph
      'report.view', // SPEC §3.3 ceiling paragraph
      'report.export', // SPEC §3.3 ceiling paragraph
      'finance.view', // 52-23 §10: finance reads, were project.manage
      'finance.manage', // 52-23 §10: finance writes, were workspace.manage
    ],
    denied: [
      'org.manage', // Billing/ownership: "No"
      'org.security.manage', // Org security/SSO: "No"
      'client_request.submit', // Submit client request: "No"
      'audit.export', // Export tenant: "No"
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'billing.view', // SPEC §3.3 ceiling paragraph
      'billing.manage', // SPEC §3.3 ceiling paragraph
      'settings.view', // SPEC §3.3 ceiling paragraph
      'roles.assign', // SPEC §3.3 ceiling paragraph
      'ai.manage', // SPEC §3.3 ceiling paragraph
    ],
  },

  /**
   * Manager's "Workspace settings | Limited" is one of the four cells §2 does not reduce to a
   * boolean. Read here as: no authority over the workspace itself (`workspace.manage` denied,
   * and with it `member.offboard`, which removes a person from the organization), full
   * authority over the projects the manager runs (`project.manage` granted). The narrowing to
   * owned projects is the evaluator's relation check, not the ceiling's.
   */
  manager: {
    granted: [
      // x90: mirrors internal work (read = work.read, write = work.create). See owner.
      'meeting.read',
      'meeting.write',
      // x91: documents mirror internal work too (read = work.read, write = work.create). See owner.
      'doc.read',
      'doc.write',
      'project.create', // Create project: "Policy"
      'project.manage', // Workspace settings: "Limited" — project-level half
      'project.member.manage', // Manage project members: "Yes"
      'conversation.read', // View internal project: "Member"
      'conversation.write', // Moderate messages: "Project"
      'conversation.moderate', // Moderate messages: "Project"
      'work.read', // View internal project: "Member"
      'work.create', // Create/edit work: "Project"
      'work.update', // Create/edit work: "Project"
      'work.transition', // Create/edit work: "Project"
      'client_projection.read', // View client projection: "Project"
      'client_request.triage', // no §2 row; 23-ERD §6 "Only internal manager may accept/defer/decline"
      'deliverable.create', // Publish to client: "Yes"
      'deliverable.review', // Publish to client: "Yes"
      'deliverable.publish', // Publish to client: "Yes"
      'approval.read', // Approve governed version: "If reviewer"
      'approval.decide', // Approve governed version: "If reviewer"
      'client_member.manage', // Invite client users: "Policy"
      'audit.read', // View audit log: "Project sensitive subset"
      'file.upload', // Create/edit work: "Project"
      'file.download', // View internal project: "Member"
      'search.use', // View internal project: "Member"
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'work.delete', // SPEC §3.3 ceiling paragraph
      'work.export', // SPEC §3.3 ceiling paragraph
      'conversation.delete', // SPEC §3.3 ceiling paragraph
      'conversation.export', // SPEC §3.3 ceiling paragraph
      'doc.delete', // SPEC §3.3 ceiling paragraph
      'doc.export', // SPEC §3.3 ceiling paragraph
      'decision.read', // SPEC §3.3 ceiling paragraph
      'decision.write', // SPEC §3.3 ceiling paragraph
      'decision.delete', // SPEC §3.3 ceiling paragraph
      'meeting.delete', // SPEC §3.3 ceiling paragraph
      'file.delete', // SPEC §3.3 ceiling paragraph
      'people.view', // SPEC §3.3 ceiling paragraph
      'ai.use', // SPEC §3.3 ceiling paragraph
      'report.view', // SPEC §3.3 ceiling paragraph
      'report.export', // SPEC §3.3 ceiling paragraph
      'finance.view', // 52-23 §10: finance reads, were project.manage
    ],
    denied: [
      'org.manage', // Billing/ownership: "No"
      'org.security.manage', // Org security/SSO: "No"
      'workspace.manage', // Workspace settings: "Limited" — workspace-level half withheld
      'client_request.submit', // Submit client request: "No"
      'audit.export', // Export tenant: "No"
      'member.offboard', // Workspace settings: "Limited" — offboarding is org-level
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'project.delete', // SPEC §3.3 ceiling paragraph
      'storage.manage', // SPEC §3.3 ceiling paragraph
      'people.invite', // SPEC §3.3 ceiling paragraph
      'people.edit', // SPEC §3.3 ceiling paragraph
      'roles.assign', // SPEC §3.3 ceiling paragraph
      'billing.view', // SPEC §3.3 ceiling paragraph
      'billing.manage', // SPEC §3.3 ceiling paragraph
      'settings.view', // SPEC §3.3 ceiling paragraph
      'ai.manage', // SPEC §3.3 ceiling paragraph
      'finance.manage', // 52-23 §10: finance is internal; held by the project.manage / workspace.manage holders only
    ],
  },

  /**
   * Moderator: "Manage project members | Policy" is granted here per the `Policy` reading, and
   * "Publish to client | Optional" is denied per the `Optional` reading. Those two cells are
   * the whole difference between this column and a plain member's.
   */
  moderator: {
    granted: [
      // x90: mirrors internal work (read = work.read, write = work.create). See owner.
      'meeting.read',
      'meeting.write',
      // x91: documents mirror internal work too (read = work.read, write = work.create). See owner.
      'doc.read',
      'doc.write',
      'project.member.manage', // Manage project members: "Policy"
      'conversation.read', // View internal project: "Member"
      'conversation.write', // Moderate messages: "Project"
      'conversation.moderate', // Moderate messages: "Project"
      'work.read', // View internal project: "Member"
      'work.create', // Create/edit work: "Policy"
      'work.update', // Create/edit work: "Policy"
      'work.transition', // Create/edit work: "Policy"
      'client_projection.read', // View client projection: "Project"
      'deliverable.create', // Publish to client: "Optional" — creating a version is not publishing it
      'deliverable.review', // Publish to client: "Optional" — internal review is not publishing
      'approval.read', // Approve governed version: "If reviewer"
      'approval.decide', // Approve governed version: "If reviewer"
      'file.upload', // Create/edit work: "Policy"
      'file.download', // View internal project: "Member"
      'search.use', // View internal project: "Member"
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'conversation.delete', // SPEC §3.3 ceiling paragraph
      'decision.read', // SPEC §3.3 ceiling paragraph
      'decision.write', // SPEC §3.3 ceiling paragraph
      'people.view', // SPEC §3.3 ceiling paragraph
      'ai.use', // SPEC §3.3 ceiling paragraph
      'report.view', // SPEC §3.3 ceiling paragraph
    ],
    denied: [
      'org.manage', // Billing/ownership: "No"
      'org.security.manage', // Org security/SSO: "No"
      'workspace.manage', // Workspace settings: "No"
      'project.create', // Create project: "No"
      'project.manage', // Workspace settings: "No"
      'client_request.submit', // Submit client request: "No"
      'client_request.triage', // no §2 row; 23-ERD §6 reserves it to the manager tier
      'deliverable.publish', // Publish to client: "Optional" — off until the org enables it
      'client_member.manage', // Invite client users: "No"
      'audit.read', // View audit log: "No"
      'audit.export', // Export tenant: "No"
      'member.offboard', // Workspace settings: "No"
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'project.delete', // SPEC §3.3 ceiling paragraph
      'work.delete', // SPEC §3.3 ceiling paragraph
      'work.export', // SPEC §3.3 ceiling paragraph
      'conversation.export', // SPEC §3.3 ceiling paragraph
      'doc.delete', // SPEC §3.3 ceiling paragraph
      'doc.export', // SPEC §3.3 ceiling paragraph
      'decision.delete', // SPEC §3.3 ceiling paragraph
      'meeting.delete', // SPEC §3.3 ceiling paragraph
      'file.delete', // SPEC §3.3 ceiling paragraph
      'storage.manage', // SPEC §3.3 ceiling paragraph
      'people.invite', // SPEC §3.3 ceiling paragraph
      'people.edit', // SPEC §3.3 ceiling paragraph
      'roles.assign', // SPEC §3.3 ceiling paragraph
      'billing.view', // SPEC §3.3 ceiling paragraph
      'billing.manage', // SPEC §3.3 ceiling paragraph
      'settings.view', // SPEC §3.3 ceiling paragraph
      'ai.manage', // SPEC §3.3 ceiling paragraph
      'report.export', // SPEC §3.3 ceiling paragraph
      'finance.view', // 52-23 §10: finance is internal; held by the project.manage / workspace.manage holders only
      'finance.manage', // 52-23 §10: finance is internal; held by the project.manage / workspace.manage holders only
    ],
  },

  /**
   * Member: "Moderate messages | Own only" — read as `conversation.write` without
   * `conversation.moderate`, because moderation is authority over other people's messages.
   * "View audit log | Own activity" is a scope narrowing, so `audit.read` is granted.
   */
  member: {
    granted: [
      // x90: mirrors internal work (read = work.read, write = work.create). See owner.
      'meeting.read',
      'meeting.write',
      // x91: documents mirror internal work too (read = work.read, write = work.create). See owner.
      'doc.read',
      'doc.write',
      'conversation.read', // View internal project: "Member"
      'conversation.write', // Moderate messages: "Own only" — writing your own is writing
      'work.read', // View internal project: "Member"
      'work.create', // Create/edit work: "Assigned/member"
      'work.update', // Create/edit work: "Assigned/member"
      'work.transition', // Create/edit work: "Assigned/member"
      'client_projection.read', // View client projection: "Project"
      'deliverable.create', // Publish to client: "Optional" — creating a version is not publishing it
      'deliverable.review', // Publish to client: "Optional" — internal review is not publishing
      'approval.read', // Approve governed version: "If reviewer"
      'approval.decide', // Approve governed version: "If reviewer"
      'audit.read', // View audit log: "Own activity"
      'file.upload', // Create/edit work: "Assigned/member"
      'file.download', // View internal project: "Member"
      'search.use', // View internal project: "Member"
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'decision.read', // SPEC §3.3 ceiling paragraph
      'decision.write', // SPEC §3.3 ceiling paragraph
      'people.view', // SPEC §3.3 ceiling paragraph
      'ai.use', // SPEC §3.3 ceiling paragraph
      'report.view', // SPEC §3.3 ceiling paragraph
    ],
    denied: [
      'org.manage', // Billing/ownership: "No"
      'org.security.manage', // Org security/SSO: "No"
      'workspace.manage', // Workspace settings: "No"
      'project.create', // Create project: "No"
      'project.manage', // Workspace settings: "No"
      'project.member.manage', // Manage project members: "No"
      'conversation.moderate', // Moderate messages: "Own only" — no authority over others
      'client_request.submit', // Submit client request: "No"
      'client_request.triage', // no §2 row; 23-ERD §6 reserves it to the manager tier
      'deliverable.publish', // Publish to client: "Optional" — off until the org enables it
      'client_member.manage', // Invite client users: "No"
      'audit.export', // Export tenant: "No"
      'member.offboard', // Workspace settings: "No"
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'project.delete', // SPEC §3.3 ceiling paragraph
      'work.delete', // SPEC §3.3 ceiling paragraph
      'work.export', // SPEC §3.3 ceiling paragraph
      'conversation.delete', // SPEC §3.3 ceiling paragraph
      'conversation.export', // SPEC §3.3 ceiling paragraph
      'doc.delete', // SPEC §3.3 ceiling paragraph
      'doc.export', // SPEC §3.3 ceiling paragraph
      'decision.delete', // SPEC §3.3 ceiling paragraph
      'meeting.delete', // SPEC §3.3 ceiling paragraph
      'file.delete', // SPEC §3.3 ceiling paragraph
      'storage.manage', // SPEC §3.3 ceiling paragraph
      'people.invite', // SPEC §3.3 ceiling paragraph
      'people.edit', // SPEC §3.3 ceiling paragraph
      'roles.assign', // SPEC §3.3 ceiling paragraph
      'billing.view', // SPEC §3.3 ceiling paragraph
      'billing.manage', // SPEC §3.3 ceiling paragraph
      'settings.view', // SPEC §3.3 ceiling paragraph
      'ai.manage', // SPEC §3.3 ceiling paragraph
      'report.export', // SPEC §3.3 ceiling paragraph
      'finance.view', // 52-23 §10: finance is internal; held by the project.manage / workspace.manage holders only
      'finance.manage', // 52-23 §10: finance is internal; held by the project.manage / workspace.manage holders only
    ],
  },

  /**
   * Guest: "View internal project | Explicit" and "Create/edit work | Explicit". Read as a
   * person let into one named thing to read it and amend it in place — `work.read` and
   * `work.update` — but not to originate content: no `work.create`, no `conversation.write`,
   * no `file.upload`. That reading is the fourth of the four §2 cells that do not reduce to a
   * boolean on their own, and it is the one a reviewer is most likely to want to argue with.
   */
  guest: {
    granted: [
      // x90: a guest reads internal work but does not originate it; meetings follow suit —
      // meeting.read granted, meeting.write denied below. Mirrors work.read / no work.create.
      'meeting.read',
      // x91: a guest reads internal documents but does not originate them — doc.read granted,
      // doc.write denied below. Mirrors work.read / no work.create.
      'doc.read',
      'conversation.read', // View internal project: "Explicit"
      'work.read', // View internal project: "Explicit"
      'work.update', // Create/edit work: "Explicit" — amend the named object
      'client_projection.read', // View client projection: "Explicit"
      'approval.read', // Approve governed version: "If reviewer"
      'approval.decide', // Approve governed version: "If reviewer"
      'file.download', // View internal project: "Explicit"
      'search.use', // View internal project: "Explicit"
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'decision.read', // SPEC §3.3 ceiling paragraph
      'people.view', // SPEC §3.3 ceiling paragraph
      'ai.use', // SPEC §3.3 ceiling paragraph
      'report.view', // SPEC §3.3 ceiling paragraph
    ],
    denied: [
      'org.manage', // Billing/ownership: "No"
      'org.security.manage', // Org security/SSO: "No"
      'workspace.manage', // Workspace settings: "No"
      'project.create', // Create project: "No"
      'project.manage', // Workspace settings: "No"
      'project.member.manage', // Manage project members: "No"
      'conversation.write', // Moderate messages: "Own only" — not read as authoring rights
      'conversation.moderate', // Moderate messages: "Own only" — no authority over others
      'work.create', // Create/edit work: "Explicit" — amend, not originate
      'meeting.write', // x90: a guest amends but does not originate; no write, mirroring work.create
      'doc.write', // x91: a guest amends but does not originate; no doc.write, mirroring work.create
      'work.transition', // Create/edit work: "Explicit" — state is the project's, not the guest's
      'client_request.submit', // Submit client request: "No"
      'client_request.triage', // no §2 row; 23-ERD §6 reserves it to the manager tier
      'deliverable.create', // Publish to client: "No"
      'deliverable.review', // Publish to client: "No"
      'deliverable.publish', // Publish to client: "No"
      'client_member.manage', // Invite client users: "No"
      'audit.read', // View audit log: "No"
      'audit.export', // Export tenant: "No"
      'member.offboard', // Workspace settings: "No"
      'file.upload', // Create/edit work: "Explicit" — amend, not originate
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'project.delete', // SPEC §3.3 ceiling paragraph
      'work.delete', // SPEC §3.3 ceiling paragraph
      'work.export', // SPEC §3.3 ceiling paragraph
      'conversation.delete', // SPEC §3.3 ceiling paragraph
      'conversation.export', // SPEC §3.3 ceiling paragraph
      'doc.delete', // SPEC §3.3 ceiling paragraph
      'doc.export', // SPEC §3.3 ceiling paragraph
      'decision.write', // SPEC §3.3 ceiling paragraph
      'decision.delete', // SPEC §3.3 ceiling paragraph
      'meeting.delete', // SPEC §3.3 ceiling paragraph
      'file.delete', // SPEC §3.3 ceiling paragraph
      'storage.manage', // SPEC §3.3 ceiling paragraph
      'people.invite', // SPEC §3.3 ceiling paragraph
      'people.edit', // SPEC §3.3 ceiling paragraph
      'roles.assign', // SPEC §3.3 ceiling paragraph
      'billing.view', // SPEC §3.3 ceiling paragraph
      'billing.manage', // SPEC §3.3 ceiling paragraph
      'settings.view', // SPEC §3.3 ceiling paragraph
      'ai.manage', // SPEC §3.3 ceiling paragraph
      'report.export', // SPEC §3.3 ceiling paragraph
      'finance.view', // 52-23 §10: finance is internal; held by the project.manage / workspace.manage holders only
      'finance.manage', // 52-23 §10: finance is internal; held by the project.manage / workspace.manage holders only
    ],
  },

  // ── External principals ─────────────────────────────────────────────────────
  // §2's "View internal project" row reads "Never" for all four client columns, and §3 says
  // `internal` content is "never visible to external principals". So every capability that
  // reads or writes the internal record — the whole `conversation.*` and `work.*` families,
  // `deliverable.create/review/publish`, `client_request.triage`, `search.use`,
  // `member.offboard`, `audit.export` — is denied to all four, and the citation on each of
  // those lines is that row rather than the capability's own.

  /** Client Admin: the only client column with "Invite client users" and an org-wide view. */
  client_admin: {
    granted: [
      'client_projection.read', // View client projection: "Client org"
      'client_request.submit', // Submit client request: "Yes"
      'approval.read', // Approve governed version: "Policy"
      'approval.decide', // Approve governed version: "Policy"
      'client_member.manage', // Invite client users: "Within own client org/policy"
      'audit.read', // View audit log: "Client-side subset"
      'file.upload', // Submit client request: "Yes" — a request carries attachments
      'file.download', // View client projection: "Client org"
    ],
    denied: [
      // x90: meetings are internal; no client projection is defined, so every client role denies both.
      'meeting.read',
      'meeting.write',
      // x91: documents are internal too; no client projection is defined, so every client role
      // denies both, the same as meetings.
      'doc.read',
      'doc.write',
      'org.manage', // Billing/ownership: "No"
      'org.security.manage', // Org security/SSO: "No"
      'workspace.manage', // Workspace settings: "No"
      'project.create', // Create project: "No"
      'project.manage', // Workspace settings: "No"
      'project.member.manage', // Manage project members: "No"
      'conversation.read', // View internal project: "Never"
      'conversation.write', // Moderate messages: "No"
      'conversation.moderate', // Moderate messages: "No"
      'work.read', // View internal project: "Never"
      'work.create', // Create/edit work: "No"
      'work.update', // Create/edit work: "No"
      'work.transition', // Create/edit work: "No"
      'client_request.triage', // internal side of the request loop; 23-ERD §6
      'deliverable.create', // Publish to client: "No"
      'deliverable.review', // Publish to client: "No"
      'deliverable.publish', // Publish to client: "No"
      'audit.export', // Export tenant: "No"
      'member.offboard', // Workspace settings: "No"
      'search.use', // View internal project: "Never"
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'project.delete', // SPEC §3.3 ceiling paragraph
      'work.delete', // SPEC §3.3 ceiling paragraph
      'work.export', // SPEC §3.3 ceiling paragraph
      'conversation.delete', // SPEC §3.3 ceiling paragraph
      'conversation.export', // SPEC §3.3 ceiling paragraph
      'doc.delete', // SPEC §3.3 ceiling paragraph
      'doc.export', // SPEC §3.3 ceiling paragraph
      'decision.read', // SPEC §3.3 ceiling paragraph
      'decision.write', // SPEC §3.3 ceiling paragraph
      'decision.delete', // SPEC §3.3 ceiling paragraph
      'meeting.delete', // SPEC §3.3 ceiling paragraph
      'file.delete', // SPEC §3.3 ceiling paragraph
      'storage.manage', // SPEC §3.3 ceiling paragraph
      'people.view', // SPEC §3.3 ceiling paragraph
      'people.invite', // SPEC §3.3 ceiling paragraph
      'people.edit', // SPEC §3.3 ceiling paragraph
      'roles.assign', // SPEC §3.3 ceiling paragraph
      'billing.view', // SPEC §3.3 ceiling paragraph
      'billing.manage', // SPEC §3.3 ceiling paragraph
      'settings.view', // SPEC §3.3 ceiling paragraph
      'ai.use', // SPEC §3.3 ceiling paragraph
      'ai.manage', // SPEC §3.3 ceiling paragraph
      'report.view', // SPEC §3.3 ceiling paragraph
      'report.export', // SPEC §3.3 ceiling paragraph
      'finance.view', // 52-23 §10: finance is internal; held by the project.manage / workspace.manage holders only
      'finance.manage', // 52-23 §10: finance is internal; held by the project.manage / workspace.manage holders only
    ],
  },

  /** Client Reviewer: the approval seat. Differs from Client Admin only in the invite row. */
  client_reviewer: {
    granted: [
      'client_projection.read', // View client projection: "Assigned/shared"
      'client_request.submit', // Submit client request: "Yes"
      'approval.read', // Approve governed version: "Assigned"
      'approval.decide', // Approve governed version: "Assigned"
      'audit.read', // View audit log: "Own decisions"
      'file.upload', // Submit client request: "Yes" — a request carries attachments
      'file.download', // View client projection: "Assigned/shared"
    ],
    denied: [
      // x90: meetings are internal; no client projection is defined. See client_admin.
      'meeting.read',
      'meeting.write',
      // x91: documents are internal too; no client projection is defined, so every client role
      // denies both, the same as meetings.
      'doc.read',
      'doc.write',
      'org.manage', // Billing/ownership: "No"
      'org.security.manage', // Org security/SSO: "No"
      'workspace.manage', // Workspace settings: "No"
      'project.create', // Create project: "No"
      'project.manage', // Workspace settings: "No"
      'project.member.manage', // Manage project members: "No"
      'conversation.read', // View internal project: "Never"
      'conversation.write', // Moderate messages: "No"
      'conversation.moderate', // Moderate messages: "No"
      'work.read', // View internal project: "Never"
      'work.create', // Create/edit work: "No"
      'work.update', // Create/edit work: "No"
      'work.transition', // Create/edit work: "No"
      'client_request.triage', // internal side of the request loop; 23-ERD §6
      'deliverable.create', // Publish to client: "No"
      'deliverable.review', // Publish to client: "No"
      'deliverable.publish', // Publish to client: "No"
      'client_member.manage', // Invite client users: "No"
      'audit.export', // Export tenant: "No"
      'member.offboard', // Workspace settings: "No"
      'search.use', // View internal project: "Never"
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'project.delete', // SPEC §3.3 ceiling paragraph
      'work.delete', // SPEC §3.3 ceiling paragraph
      'work.export', // SPEC §3.3 ceiling paragraph
      'conversation.delete', // SPEC §3.3 ceiling paragraph
      'conversation.export', // SPEC §3.3 ceiling paragraph
      'doc.delete', // SPEC §3.3 ceiling paragraph
      'doc.export', // SPEC §3.3 ceiling paragraph
      'decision.read', // SPEC §3.3 ceiling paragraph
      'decision.write', // SPEC §3.3 ceiling paragraph
      'decision.delete', // SPEC §3.3 ceiling paragraph
      'meeting.delete', // SPEC §3.3 ceiling paragraph
      'file.delete', // SPEC §3.3 ceiling paragraph
      'storage.manage', // SPEC §3.3 ceiling paragraph
      'people.view', // SPEC §3.3 ceiling paragraph
      'people.invite', // SPEC §3.3 ceiling paragraph
      'people.edit', // SPEC §3.3 ceiling paragraph
      'roles.assign', // SPEC §3.3 ceiling paragraph
      'billing.view', // SPEC §3.3 ceiling paragraph
      'billing.manage', // SPEC §3.3 ceiling paragraph
      'settings.view', // SPEC §3.3 ceiling paragraph
      'ai.use', // SPEC §3.3 ceiling paragraph
      'ai.manage', // SPEC §3.3 ceiling paragraph
      'report.view', // SPEC §3.3 ceiling paragraph
      'report.export', // SPEC §3.3 ceiling paragraph
      'finance.view', // 52-23 §10: finance is internal; held by the project.manage / workspace.manage holders only
      'finance.manage', // 52-23 §10: finance is internal; held by the project.manage / workspace.manage holders only
    ],
  },

  /**
   * Client Member: "Moderate messages | Own only" and "Create/edit work | Client
   * requests/actions" both sit inside the client projection, which no capability in the
   * `conversation.*` or `work.*` families reaches — those read the internal record, and §2
   * gives this column "View internal project: Never".
   */
  client_member: {
    granted: [
      'client_projection.read', // View client projection: "Shared"
      'client_request.submit', // Submit client request: "Yes"
      'approval.read', // Approve governed version: "If assigned"
      'approval.decide', // Approve governed version: "If assigned"
      'audit.read', // View audit log: "Own activity"
      'file.upload', // Submit client request: "Yes" — a request carries attachments
      'file.download', // View client projection: "Shared"
    ],
    denied: [
      // x90: meetings are internal; no client projection is defined. See client_admin.
      'meeting.read',
      'meeting.write',
      // x91: documents are internal too; no client projection is defined, so every client role
      // denies both, the same as meetings.
      'doc.read',
      'doc.write',
      'org.manage', // Billing/ownership: "No"
      'org.security.manage', // Org security/SSO: "No"
      'workspace.manage', // Workspace settings: "No"
      'project.create', // Create project: "No"
      'project.manage', // Workspace settings: "No"
      'project.member.manage', // Manage project members: "No"
      'conversation.read', // View internal project: "Never"
      'conversation.write', // Moderate messages: "Own only" — inside the projection, not the record
      'conversation.moderate', // Moderate messages: "Own only" — no authority over others
      'work.read', // View internal project: "Never"
      'work.create', // Create/edit work: "Client requests/actions" — not the internal record
      'work.update', // Create/edit work: "Client requests/actions" — not the internal record
      'work.transition', // Create/edit work: "Client requests/actions" — not the internal record
      'client_request.triage', // internal side of the request loop; 23-ERD §6
      'deliverable.create', // Publish to client: "No"
      'deliverable.review', // Publish to client: "No"
      'deliverable.publish', // Publish to client: "No"
      'client_member.manage', // Invite client users: "No"
      'audit.export', // Export tenant: "No"
      'member.offboard', // Workspace settings: "No"
      'search.use', // View internal project: "Never"
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'project.delete', // SPEC §3.3 ceiling paragraph
      'work.delete', // SPEC §3.3 ceiling paragraph
      'work.export', // SPEC §3.3 ceiling paragraph
      'conversation.delete', // SPEC §3.3 ceiling paragraph
      'conversation.export', // SPEC §3.3 ceiling paragraph
      'doc.delete', // SPEC §3.3 ceiling paragraph
      'doc.export', // SPEC §3.3 ceiling paragraph
      'decision.read', // SPEC §3.3 ceiling paragraph
      'decision.write', // SPEC §3.3 ceiling paragraph
      'decision.delete', // SPEC §3.3 ceiling paragraph
      'meeting.delete', // SPEC §3.3 ceiling paragraph
      'file.delete', // SPEC §3.3 ceiling paragraph
      'storage.manage', // SPEC §3.3 ceiling paragraph
      'people.view', // SPEC §3.3 ceiling paragraph
      'people.invite', // SPEC §3.3 ceiling paragraph
      'people.edit', // SPEC §3.3 ceiling paragraph
      'roles.assign', // SPEC §3.3 ceiling paragraph
      'billing.view', // SPEC §3.3 ceiling paragraph
      'billing.manage', // SPEC §3.3 ceiling paragraph
      'settings.view', // SPEC §3.3 ceiling paragraph
      'ai.use', // SPEC §3.3 ceiling paragraph
      'ai.manage', // SPEC §3.3 ceiling paragraph
      'report.view', // SPEC §3.3 ceiling paragraph
      'report.export', // SPEC §3.3 ceiling paragraph
      'finance.view', // 52-23 §10: finance is internal; held by the project.manage / workspace.manage holders only
      'finance.manage', // 52-23 §10: finance is internal; held by the project.manage / workspace.manage holders only
    ],
  },

  /**
   * Client Viewer: §2's narrowest column. "Approve governed version | No" and "View audit log
   * | No" are the two cells that separate it from Client Member, and "Submit client request |
   * Policy" is the one thing it may do besides read.
   */
  client_viewer: {
    granted: [
      'client_projection.read', // View client projection: "Shared"
      'client_request.submit', // Submit client request: "Policy"
      // Reading, not deciding. §2's "Approve governed version: No" governs the decision; the
      // decision's *state* is an allowlisted field of the client projection under §4
      // ("decision"), which this column reads as "Shared". A fifth cell that does not reduce
      // to a boolean on its own — flagged here for the same reason as the other four.
      'approval.read',
      'file.download', // View client projection: "Shared"
    ],
    denied: [
      // x90: meetings are internal; no client projection is defined. See client_admin.
      'meeting.read',
      'meeting.write',
      // x91: documents are internal too; no client projection is defined, so every client role
      // denies both, the same as meetings.
      'doc.read',
      'doc.write',
      'org.manage', // Billing/ownership: "No"
      'org.security.manage', // Org security/SSO: "No"
      'workspace.manage', // Workspace settings: "No"
      'project.create', // Create project: "No"
      'project.manage', // Workspace settings: "No"
      'project.member.manage', // Manage project members: "No"
      'conversation.read', // View internal project: "Never"
      'conversation.write', // Moderate messages: "No"
      'conversation.moderate', // Moderate messages: "No"
      'work.read', // View internal project: "Never"
      'work.create', // Create/edit work: "No"
      'work.update', // Create/edit work: "No"
      'work.transition', // Create/edit work: "No"
      'client_request.triage', // internal side of the request loop; 23-ERD §6
      'deliverable.create', // Publish to client: "No"
      'deliverable.review', // Publish to client: "No"
      'deliverable.publish', // Publish to client: "No"
      'approval.decide', // Approve governed version: "No"
      'client_member.manage', // Invite client users: "No"
      'audit.read', // View audit log: "No"
      'audit.export', // Export tenant: "No"
      'member.offboard', // Workspace settings: "No"
      'file.upload', // no client write surface besides a request this role may not always raise
      'search.use', // View internal project: "Never"
      // ---- platform-admin v2 · PA-01: SPEC §3.3 matrix capabilities ----
      'project.delete', // SPEC §3.3 ceiling paragraph
      'work.delete', // SPEC §3.3 ceiling paragraph
      'work.export', // SPEC §3.3 ceiling paragraph
      'conversation.delete', // SPEC §3.3 ceiling paragraph
      'conversation.export', // SPEC §3.3 ceiling paragraph
      'doc.delete', // SPEC §3.3 ceiling paragraph
      'doc.export', // SPEC §3.3 ceiling paragraph
      'decision.read', // SPEC §3.3 ceiling paragraph
      'decision.write', // SPEC §3.3 ceiling paragraph
      'decision.delete', // SPEC §3.3 ceiling paragraph
      'meeting.delete', // SPEC §3.3 ceiling paragraph
      'file.delete', // SPEC §3.3 ceiling paragraph
      'storage.manage', // SPEC §3.3 ceiling paragraph
      'people.view', // SPEC §3.3 ceiling paragraph
      'people.invite', // SPEC §3.3 ceiling paragraph
      'people.edit', // SPEC §3.3 ceiling paragraph
      'roles.assign', // SPEC §3.3 ceiling paragraph
      'billing.view', // SPEC §3.3 ceiling paragraph
      'billing.manage', // SPEC §3.3 ceiling paragraph
      'settings.view', // SPEC §3.3 ceiling paragraph
      'ai.use', // SPEC §3.3 ceiling paragraph
      'ai.manage', // SPEC §3.3 ceiling paragraph
      'report.view', // SPEC §3.3 ceiling paragraph
      'report.export', // SPEC §3.3 ceiling paragraph
      'finance.view', // 52-23 §10: finance is internal; held by the project.manage / workspace.manage holders only
      'finance.manage', // 52-23 §10: finance is internal; held by the project.manage / workspace.manage holders only
    ],
  },
};

/**
 * Places where the shipped ceiling and the transcription above are known to disagree.
 *
 * This list is the honest alternative to quietly editing `PERMISSION_MATRIX` until the guard
 * goes green. Each entry says what the document says, what the code does, and why the
 * difference was accepted. It is a fixed, hand-written list: it cannot grow without a person
 * adding an entry, so **any new disagreement is a test failure**, which is the whole point of
 * the guard. A stale entry is a failure too — see `permission-matrix.guard.test.ts`.
 *
 * None of these is a widening of what a *client* principal can reach. One is the ceiling
 * being stricter than §2; the other two are wider than §2 but refused a layer deeper.
 */
export interface CeilingDivergence {
  readonly role: Role;
  readonly capability: Capability;
  /** What `CAPABILITY_CEILING` does, against what §2 says. */
  readonly ceiling: 'grants' | 'denies';
  readonly why: string;
}

export const ACCEPTED_CEILING_DIVERGENCES: readonly CeilingDivergence[] = [
  {
    role: 'owner',
    capability: 'client_request.submit',
    ceiling: 'grants',
    why:
      '§2 "Submit client request" reads No for every internal column, and the ceiling gives ' +
      'owner `[...CAPABILITIES]` — a blanket grant rather than a transcription. Wider than ' +
      'the document, but the portal services refuse any internal principal with their own ' +
      '403 (a request with no client organization is a row the table cannot hold), which is ' +
      'proved in the REQ-001 and INBOX-001 suites and recorded in the header of ' +
      'apps/api/test/test-001-role-matrix.db.test.ts. Accepted as a ceiling-shape artefact, ' +
      'not as a permission.',
  },
  {
    role: 'org_admin',
    capability: 'client_request.submit',
    ceiling: 'grants',
    why: 'Same blanket-grant artefact as owner: org_admin is `[...CAPABILITIES]` (ADM-03).',
  },
  {
    role: 'platform_support',
    capability: 'client_request.submit',
    ceiling: 'grants',
    why:
      'PA-01. Same blanket-grant artefact as owner: the Support-session role is `[...CAPABILITIES]` ' +
      '(SPEC §3.2 "full capability ceiling"), and the portal services refuse any internal ' +
      'principal raising a client request.',
  },
  {
    role: 'moderator',
    capability: 'project.member.manage',
    ceiling: 'denies',
    why:
      '§2 "Manage project members" reads Policy for Moderator, which the reading in this ' +
      "file's header would grant. The ceiling denies it outright. Stricter than the " +
      'document; accepted.',
  },
];

const DIVERGENCE_INDEX: ReadonlyMap<string, CeilingDivergence> = new Map(
  ACCEPTED_CEILING_DIVERGENCES.map((d) => [`${d.role} ${d.capability}`, d]),
);

/**
 * The ceiling this fixture expects the product to hold for a role: the §2 transcription with
 * the accepted divergences applied.
 *
 * Both inputs are hand-written literals in this file, so a test asserting against this is
 * asserting against a human's reading of the matrix document — never against
 * `capabilitiesFor`, `hasCapability`, or `CAPABILITY_CEILING`, none of which this module can
 * see. The returned array is sorted, so callers can compare sets with a plain `toEqual`.
 */
export function expectedCeilingFor(role: Role): readonly Capability[] {
  const row = PERMISSION_MATRIX[role];
  const out = new Set<Capability>(row.granted);
  for (const capability of row.denied) {
    if (DIVERGENCE_INDEX.get(`${role} ${capability}`)?.ceiling === 'grants') {
      out.add(capability);
    }
  }
  for (const capability of row.granted) {
    if (DIVERGENCE_INDEX.get(`${role} ${capability}`)?.ceiling === 'denies') {
      out.delete(capability);
    }
  }
  return [...out].sort();
}

/** Does the expected ceiling for `role` include `capability`? */
export function expectedCeilingGrants(role: Role, capability: Capability): boolean {
  return expectedCeilingFor(role).includes(capability);
}
