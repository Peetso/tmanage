import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { CLIENT_ROLES, INTERNAL_ROLES, hasCapability, uuidv7 } from '@tmanage/domain';
import type { Capability, InternalRole, Role } from '@tmanage/domain';
import { ACCEPTED_CEILING_DIVERGENCES, PERMISSION_MATRIX } from '@tmanage/test-kit';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';
import {
  bootHttpHarness,
  reseed,
  signIn as harnessSignIn,
  stopHarness,
} from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';

/**
 * SEC-002 — the prohibitions of `12-PERMISSION-MATRIX.md` §2, restated by hand.
 *
 * ## The rule that makes this file worth having
 *
 * > **This file must not import `hasCapability`, `capabilitiesFor`, `CAPABILITY_CEILING`,
 * > `INTERNAL_ONLY_CAPABILITIES` or `isInternalOnlyCapability` for the purpose of computing
 * > an expectation.**
 *
 * `hasCapability` is imported here as the **subject under test** and never as a source of
 * truth: every expectation below is a literal `false`, transcribed by hand from the
 * governing matrix. Do not "simplify" a case by asking the domain what the answer should
 * be — that is precisely the defect this file exists to close.
 *
 * The role name lists (`INTERNAL_ROLES`, `CLIENT_ROLES`) and the `Capability` type are
 * imported because they are vocabulary, not verdicts.
 *
 * ## Why this file exists (D18, 2026-09-05 production review)
 *
 * `test-001-role-matrix.db.test.ts:194` computes each cell's expected verdict with
 * `hasCapability(role, cell.capability)` — the product's own ceiling table. That is a good
 * wiring check and the review says to retain it, but it cannot detect an *accidental*
 * widening: grant `guest` the capability `org.manage` and the grid simply expects `guest`
 * to pass `/invitations`, `guest` passes, and the suite stays green.
 *
 * The review's fix: "retain the harness and add an independently maintained security
 * acceptance matrix for critical prohibitions from the governing permission specification."
 * Its acceptance sentence: "deliberately giving a low-privilege role a prohibited
 * capability makes an independent test fail, even if hasCapability now returns true."
 *
 * So there are now two transcriptions of §2 in the repository —
 * `packages/domain/src/policies/capabilities.ts` (`CAPABILITY_CEILING`, which the product
 * obeys) and the tables below (which nothing obeys) — and this file fails when they
 * disagree about a prohibition.
 *
 * ## What is in scope, and what deliberately is not
 *
 * §2 writes many cells as `Policy`, `Scope`, `Project`, `Member`, `Limited`, `Optional`,
 * `Explicit`, `Own only` or `If reviewer`. **None of those are prohibitions.** The ceiling
 * grants them and the evaluator in `authorize.ts` narrows them at decision time, so
 * asserting one of them as `false` here would be wrong. Only cells reading exactly `No` or
 * `Never` are transcribed.
 *
 * Capability names are mapped to matrix rows by reading the capability list at
 * `packages/domain/src/policies/capabilities.ts` lines 20-58 — the vocabulary — and never
 * by looking at which role currently holds what.
 *
 * ## Two places where this transcription disagrees with the product
 *
 * Recorded rather than reconciled, because §7 of `15-AI-EXECUTION-HANDBOOK.md` makes a
 * permission change a coordinated edit across matrix, threat model, API policy, repository
 * rules and isolation tests. See `MATRIX_DIVERGENCES` below and
 * `docs/security/permission-test-map.md`.
 *
 * ## Reconciliation with the canonical §2 transcription (`@tmanage/test-kit`)
 *
 * `packages/test-kit/src/permission-matrix.ts` (slice x11) is the repository's *single*
 * hand-written transcription of §2's allow/deny truth, guarded once against the shipped
 * ceiling by `permission-matrix-fixture.test.ts`. This suite is deliberately not a second
 * competing transcription of that truth: the `describe('reconciliation …')` block below
 * asserts that every cell this suite chooses to prove as a hard prohibition is also denied in
 * that canonical fixture, so the two can never drift into contradiction. What stays uniquely
 * this suite's is the *scope choice* — which (role, capability) pairs are worth proving as
 * hard prohibitions, restricted to §2's literal `No`/`Never` cells — and the layers x11 does
 * not have: the product-behaviour check (`hasCapability` returns `false`), the HTTP-403s, and
 * the `security.capability_denied` audit count.
 *
 * The one place §2's prose is read two ways is guest's `Own only` / `Explicit`. x11 reads
 * those as denials (`guest.denied` holds `conversation.write`, `work.create`,
 * `work.transition`); this suite reads them as scope narrowings and excludes them from
 * `FORBIDDEN`. That is not a contradiction — `FORBIDDEN` is a subset of x11's `denied`, so
 * both readings coexist — and it is resolved explicitly, and machine-checked, in the
 * reconciliation block's "guest reading" case rather than left to prose.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

function signIn(userId: string): Promise<Session> {
  return harnessSignIn(app, userId, { csrf: false });
}

async function get(path: string, session: Session): Promise<InjectedResponse> {
  return (await app.inject({
    method: 'GET',
    url: `/v1/organizations/northstar-studio${path}`,
    headers: { cookie: session.cookie },
  })) as unknown as InjectedResponse;
}

/** One person per internal role, seeded directly — the matrix needs every column. */
const roleUsers = new Map<InternalRole, string>();

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

// ── Test 1 · the prohibitions of §2, written out ──────────────────────────────

interface Prohibition {
  readonly role: Role;
  readonly capability: Capability;
  readonly matrixRow: string;
}

/**
 * Transcribed by hand from `12-PERMISSION-MATRIX.md` §2. Never generated, never imported.
 *
 * One entry per cell the matrix marks `No` or `Never`. The `matrixRow` field names the row
 * it came from so a reader can check the transcription against the document without
 * running anything.
 */
const FORBIDDEN: readonly Prohibition[] = [
  // §2 "Billing/ownership" | Full | Policy | No | No | No | No | No | No | No | No | No |
  // Owner is `Full` and Org Admin is `Policy`; neither is a prohibition.
  { role: 'workspace_admin', capability: 'org.manage', matrixRow: 'Billing/ownership' },
  { role: 'manager', capability: 'org.manage', matrixRow: 'Billing/ownership' },
  { role: 'moderator', capability: 'org.manage', matrixRow: 'Billing/ownership' },
  { role: 'member', capability: 'org.manage', matrixRow: 'Billing/ownership' },
  { role: 'guest', capability: 'org.manage', matrixRow: 'Billing/ownership' },
  { role: 'client_admin', capability: 'org.manage', matrixRow: 'Billing/ownership' },
  { role: 'client_reviewer', capability: 'org.manage', matrixRow: 'Billing/ownership' },
  { role: 'client_member', capability: 'org.manage', matrixRow: 'Billing/ownership' },
  { role: 'client_viewer', capability: 'org.manage', matrixRow: 'Billing/ownership' },

  // §2 "Org security/SSO" | Full | Full | No | No | No | No | No | No | No | No | No |
  { role: 'workspace_admin', capability: 'org.security.manage', matrixRow: 'Org security/SSO' },
  { role: 'manager', capability: 'org.security.manage', matrixRow: 'Org security/SSO' },
  { role: 'moderator', capability: 'org.security.manage', matrixRow: 'Org security/SSO' },
  { role: 'member', capability: 'org.security.manage', matrixRow: 'Org security/SSO' },
  { role: 'guest', capability: 'org.security.manage', matrixRow: 'Org security/SSO' },
  { role: 'client_admin', capability: 'org.security.manage', matrixRow: 'Org security/SSO' },
  { role: 'client_reviewer', capability: 'org.security.manage', matrixRow: 'Org security/SSO' },
  { role: 'client_member', capability: 'org.security.manage', matrixRow: 'Org security/SSO' },
  { role: 'client_viewer', capability: 'org.security.manage', matrixRow: 'Org security/SSO' },

  // §2 "Workspace settings" | Full | Full | Full | Limited | No | No | No | No | No | No | No |
  // Manager is `Limited`, which the evaluator narrows; not a prohibition.
  { role: 'moderator', capability: 'workspace.manage', matrixRow: 'Workspace settings' },
  { role: 'member', capability: 'workspace.manage', matrixRow: 'Workspace settings' },
  { role: 'guest', capability: 'workspace.manage', matrixRow: 'Workspace settings' },
  { role: 'client_admin', capability: 'workspace.manage', matrixRow: 'Workspace settings' },
  { role: 'client_reviewer', capability: 'workspace.manage', matrixRow: 'Workspace settings' },
  { role: 'client_member', capability: 'workspace.manage', matrixRow: 'Workspace settings' },
  { role: 'client_viewer', capability: 'workspace.manage', matrixRow: 'Workspace settings' },

  // §2 "Create project" | Yes | Yes | Yes | Policy | No | No | No | No | No | No | No |
  { role: 'moderator', capability: 'project.create', matrixRow: 'Create project' },
  { role: 'member', capability: 'project.create', matrixRow: 'Create project' },
  { role: 'guest', capability: 'project.create', matrixRow: 'Create project' },
  { role: 'client_admin', capability: 'project.create', matrixRow: 'Create project' },
  { role: 'client_reviewer', capability: 'project.create', matrixRow: 'Create project' },
  { role: 'client_member', capability: 'project.create', matrixRow: 'Create project' },
  { role: 'client_viewer', capability: 'project.create', matrixRow: 'Create project' },

  // §2 "Manage project members" | Yes | Yes | Yes | Yes | Policy | No | No | No | No | No | No |
  // Moderator is `Policy`; not a prohibition.
  { role: 'member', capability: 'project.member.manage', matrixRow: 'Manage project members' },
  { role: 'guest', capability: 'project.member.manage', matrixRow: 'Manage project members' },
  {
    role: 'client_admin',
    capability: 'project.member.manage',
    matrixRow: 'Manage project members',
  },
  {
    role: 'client_reviewer',
    capability: 'project.member.manage',
    matrixRow: 'Manage project members',
  },
  {
    role: 'client_member',
    capability: 'project.member.manage',
    matrixRow: 'Manage project members',
  },
  {
    role: 'client_viewer',
    capability: 'project.member.manage',
    matrixRow: 'Manage project members',
  },

  // §2 "View internal project" | Scope | Scope | Scope | Member | Member | Member | Explicit |
  //                            | Never | Never | Never | Never |
  // Every internal cell is a scope, not a prohibition. Every client cell is `Never`, and the
  // capability that reads the internal record is `work.read` — the portal reads
  // `client_projection.read` instead, which is §2's separate "View client projection" row.
  { role: 'client_admin', capability: 'work.read', matrixRow: 'View internal project' },
  { role: 'client_reviewer', capability: 'work.read', matrixRow: 'View internal project' },
  { role: 'client_member', capability: 'work.read', matrixRow: 'View internal project' },
  { role: 'client_viewer', capability: 'work.read', matrixRow: 'View internal project' },

  // §2 "Moderate messages" | Scope | Scope | Scope | Project | Project | Own only | Own only |
  //                        | No | No | Own only | No |
  // `Own only` is a relation narrowing, not a prohibition, so Member, Guest and Client Member
  // are out of scope for this row. The three `No` cells are transcribed.
  { role: 'client_admin', capability: 'conversation.moderate', matrixRow: 'Moderate messages' },
  { role: 'client_reviewer', capability: 'conversation.moderate', matrixRow: 'Moderate messages' },
  { role: 'client_viewer', capability: 'conversation.moderate', matrixRow: 'Moderate messages' },

  // §2 "Create/edit work" | Scope | Scope | Scope | Project | Policy | Assigned/member |
  //                       | Explicit | No | No | Client requests/actions | No |
  // Client Member's cell is `Client requests/actions`, a scope rather than a prohibition, so
  // it is not transcribed here. The three `No` client cells cover the three write
  // capabilities that act on the internal work record.
  { role: 'client_admin', capability: 'work.create', matrixRow: 'Create/edit work' },
  { role: 'client_admin', capability: 'work.update', matrixRow: 'Create/edit work' },
  { role: 'client_admin', capability: 'work.transition', matrixRow: 'Create/edit work' },
  { role: 'client_reviewer', capability: 'work.create', matrixRow: 'Create/edit work' },
  { role: 'client_reviewer', capability: 'work.update', matrixRow: 'Create/edit work' },
  { role: 'client_reviewer', capability: 'work.transition', matrixRow: 'Create/edit work' },
  { role: 'client_viewer', capability: 'work.create', matrixRow: 'Create/edit work' },
  { role: 'client_viewer', capability: 'work.update', matrixRow: 'Create/edit work' },
  { role: 'client_viewer', capability: 'work.transition', matrixRow: 'Create/edit work' },

  // §2 "Publish to client" | Policy | Policy | Policy | Yes | Optional | Optional | No |
  //                        | No | No | No | No |
  // `Optional` (Moderator, Member) means off unless policy enables it — not a prohibition.
  { role: 'guest', capability: 'deliverable.publish', matrixRow: 'Publish to client' },
  { role: 'client_admin', capability: 'deliverable.publish', matrixRow: 'Publish to client' },
  { role: 'client_reviewer', capability: 'deliverable.publish', matrixRow: 'Publish to client' },
  { role: 'client_member', capability: 'deliverable.publish', matrixRow: 'Publish to client' },
  { role: 'client_viewer', capability: 'deliverable.publish', matrixRow: 'Publish to client' },

  // §2 "Submit client request" | No | No | No | No | No | No | No | Yes | Yes | Yes | Policy |
  // Every internal role is `No`. Owner and Org Admin are held out into
  // `MATRIX_DIVERGENCES` below, because the product's ceiling grants them the capability
  // and refuses them a layer deeper instead. That is a finding, not something to reconcile
  // here.
  {
    role: 'workspace_admin',
    capability: 'client_request.submit',
    matrixRow: 'Submit client request',
  },
  { role: 'manager', capability: 'client_request.submit', matrixRow: 'Submit client request' },
  { role: 'moderator', capability: 'client_request.submit', matrixRow: 'Submit client request' },
  { role: 'member', capability: 'client_request.submit', matrixRow: 'Submit client request' },
  { role: 'guest', capability: 'client_request.submit', matrixRow: 'Submit client request' },

  // §2 "Approve governed version" | If reviewer ×7 | Policy | Assigned | If assigned | No |
  // Every cell but the last is a relation or policy narrowing. Client Viewer's is the row's
  // only prohibition.
  { role: 'client_viewer', capability: 'approval.decide', matrixRow: 'Approve governed version' },

  // §2 "Invite client users" | Policy | Policy | Policy | Policy | No | No | No |
  //                          | Within own client org/policy | No | No | No |
  { role: 'moderator', capability: 'client_member.manage', matrixRow: 'Invite client users' },
  { role: 'member', capability: 'client_member.manage', matrixRow: 'Invite client users' },
  { role: 'guest', capability: 'client_member.manage', matrixRow: 'Invite client users' },
  { role: 'client_reviewer', capability: 'client_member.manage', matrixRow: 'Invite client users' },
  { role: 'client_member', capability: 'client_member.manage', matrixRow: 'Invite client users' },
  { role: 'client_viewer', capability: 'client_member.manage', matrixRow: 'Invite client users' },

  // §2 "View audit log" | Full | Full | Workspace scope | Project sensitive subset | No |
  //                     | Own activity | No | Client-side subset | Own decisions |
  //                     | Own activity | No |
  // Only three cells read `No`; every other cell is a scope the evaluator narrows.
  { role: 'moderator', capability: 'audit.read', matrixRow: 'View audit log' },
  { role: 'guest', capability: 'audit.read', matrixRow: 'View audit log' },
  { role: 'client_viewer', capability: 'audit.read', matrixRow: 'View audit log' },

  // §2 "Export tenant" | Owner | Policy | No | No | No | No | No | No | No | No | No |
  // The only export capability in the vocabulary is `audit.export`.
  { role: 'workspace_admin', capability: 'audit.export', matrixRow: 'Export tenant' },
  { role: 'manager', capability: 'audit.export', matrixRow: 'Export tenant' },
  { role: 'moderator', capability: 'audit.export', matrixRow: 'Export tenant' },
  { role: 'member', capability: 'audit.export', matrixRow: 'Export tenant' },
  { role: 'guest', capability: 'audit.export', matrixRow: 'Export tenant' },
  { role: 'client_admin', capability: 'audit.export', matrixRow: 'Export tenant' },
  { role: 'client_reviewer', capability: 'audit.export', matrixRow: 'Export tenant' },
  { role: 'client_member', capability: 'audit.export', matrixRow: 'Export tenant' },
  { role: 'client_viewer', capability: 'audit.export', matrixRow: 'Export tenant' },
];

/**
 * Cells where this hand transcription and `CAPABILITY_CEILING` disagree, recorded and **not**
 * asserted.
 *
 * §2's "Submit client request" row is `No` for all seven internal roles. The ceiling gives
 * `owner` and `org_admin` every capability (ADM-03), so both hold
 * `client_request.submit`. The refusal happens one layer deeper: the portal services reject
 * any internal principal because a client request with no client organization is a row the
 * table cannot hold, which is proved in `req-001-client-requests.db.test.ts` and
 * `inbox-001-portal-inbox.db.test.ts` and recorded in the comment at
 * `test-001-role-matrix.db.test.ts:125-137`.
 *
 * Asserting these two here would make the suite red on an unmodified checkout and would
 * pre-empt a decision this slice may not take: closing the gap is a permission change, and
 * `15-AI-EXECUTION-HANDBOOK.md` §7 requires the matrix, threat model, API policy, scoped
 * repository rules and isolation tests to move together. Left as a documented finding.
 */
const MATRIX_DIVERGENCES: readonly Prohibition[] = [
  { role: 'owner', capability: 'client_request.submit', matrixRow: 'Submit client request' },
  { role: 'org_admin', capability: 'client_request.submit', matrixRow: 'Submit client request' },
];

// ── Test 2 · what no external principal may ever hold ─────────────────────────

/**
 * Hand-transcribed from `12-PERMISSION-MATRIX.md` §2 (client columns), §3 and §4.
 *
 * Every capability here is one that §2 marks `No` or `Never` in **all four** client columns,
 * or that §3's audience rule ("`internal`: never visible to external principals") and §4's
 * projection exclusion list put out of a client's reach:
 *
 * - `org.manage`            — §2 "Billing/ownership": `No` in all four client columns.
 * - `org.security.manage`   — §2 "Org security/SSO": `No` ×4.
 * - `workspace.manage`      — §2 "Workspace settings": `No` ×4.
 * - `project.create`        — §2 "Create project": `No` ×4.
 * - `project.manage`        — §2 "Workspace settings" / "Manage project members": `No` ×4;
 *                             administering internal structure is `internal` under §3.
 * - `project.member.manage` — §2 "Manage project members": `No` ×4.
 * - `work.read`             — §2 "View internal project": `Never` ×4.
 * - `conversation.read`     — §4 excludes "private channel/thread" from the projection, and
 * - `conversation.write`      §2 "View internal project" is `Never` ×4; internal threads are
 *                             part of the internal record, not of the projection.
 * - `deliverable.create`    — the deliverable pipeline is `internal` under §3 until it is
 * - `deliverable.review`      published, and §4 excludes "staff review" from the projection.
 * - `deliverable.publish`   — §2 "Publish to client": `No` ×4.
 * - `client_request.triage` — §2 gives clients only "Submit client request"; triage is the
 *                             internal handling queue, `internal` under §3.
 * - `member.offboard`       — §2 "Manage project members": `No` ×4; offboarding an internal
 *                             member is internal administration under §3.
 * - `audit.export`          — §2 "Export tenant": `No` ×4.
 *
 * Deliberately absent, and why: `conversation.moderate` and `work.create` / `work.update` /
 * `work.transition` are `No` for three client roles but not the fourth (§2 gives Client Member
 * `Own only` and `Client requests/actions`), so they are asserted per role in `FORBIDDEN`
 * instead. `search.use` has no row in §2 at all and cannot be transcribed from it.
 *
 * `capabilities.ts:340` holds a list of this shape (`INTERNAL_ONLY_CAPABILITIES`). It is
 * **not** imported, and the two are not identical — see `docs/security/permission-test-map.md`.
 */
const NEVER_EXTERNAL: readonly Capability[] = [
  'org.manage',
  'org.security.manage',
  'workspace.manage',
  'project.create',
  'project.manage',
  'project.member.manage',
  'work.read',
  'conversation.read',
  'conversation.write',
  'deliverable.create',
  'deliverable.review',
  'deliverable.publish',
  'client_request.triage',
  'member.offboard',
  'audit.export',
];

// ── Test 3 · the same prohibitions over HTTP ──────────────────────────────────

/**
 * The capability-gated list routes the product has today, and the roles §2 forbids them to.
 *
 * This is a thin list on purpose: the product exposes five capability-gated list routes
 * (see the grid at `test-001-role-matrix.db.test.ts:116-123`), and only two of them are
 * gated by a capability the matrix denies to anyone. `work.read` and `conversation.read`
 * are held by every internal role, so `/work-items`, `/conversations` and `/inbox` have no
 * internal prohibition to prove. **The table-level tests above are what carry the
 * guarantee** until more capability-gated routes exist; do not invent routes to fatten this
 * list.
 *
 * Every status code below is a literal written from §2, not a value derived from the
 * ceiling.
 */
const HTTP_PROHIBITIONS: readonly {
  readonly path: string;
  readonly capability: Capability;
  readonly role: InternalRole;
  readonly matrixRow: string;
}[] = [
  // §2 "Billing/ownership": Owner is `Full` and Org Admin `Policy`, which the ceiling grants
  // (ADM-03, CQ-06 moved the Org Admin row out of this list, as this note said it would).
  // The five `No` rows under it must not move.
  {
    path: '/invitations',
    capability: 'org.manage',
    role: 'workspace_admin',
    matrixRow: 'Billing/ownership',
  },
  {
    path: '/invitations',
    capability: 'org.manage',
    role: 'manager',
    matrixRow: 'Billing/ownership',
  },
  {
    path: '/invitations',
    capability: 'org.manage',
    role: 'moderator',
    matrixRow: 'Billing/ownership',
  },
  {
    path: '/invitations',
    capability: 'org.manage',
    role: 'member',
    matrixRow: 'Billing/ownership',
  },
  { path: '/invitations', capability: 'org.manage', role: 'guest', matrixRow: 'Billing/ownership' },

  // Triage is the internal side of the client-request queue: `internal` under §3, and §2
  // gives Moderator, Member and Guest no cell that reaches it.
  {
    path: '/client-requests',
    capability: 'client_request.triage',
    role: 'moderator',
    matrixRow: 'Submit client request (internal triage, §3)',
  },
  {
    path: '/client-requests',
    capability: 'client_request.triage',
    role: 'member',
    matrixRow: 'Submit client request (internal triage, §3)',
  },
  {
    path: '/client-requests',
    capability: 'client_request.triage',
    role: 'guest',
    matrixRow: 'Submit client request (internal triage, §3)',
  },
];

/**
 * One `security.capability_denied` row per refusal above, and nothing else.
 *
 * Written as a literal, not as `HTTP_PROHIBITIONS.length` and certainly not as a count
 * derived from `hasCapability`: eight requests are made, eight are refused, eight security
 * events are expected. The equality against the table's length is itself asserted, so the
 * two statements have to agree. (Nine until CQ-06/ADM-03 moved the Org Admin
 * "Billing/ownership = Policy" row out of the table, as its note said it would.)
 */
const EXPECTED_DENIAL_EVENTS = 8;

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'the_role_prohibitions_suite' }));
  world = await reseed(db);

  for (const role of INTERNAL_ROLES) {
    const userId = uuidv7();
    await db.admin.execute(
      `insert into users (id, email, display_name, email_verified_at)
       values (?, ?, ?, utc_timestamp(3))`,
      [userId, `${role.replace(/_/g, '-')}@prohibitions.northstar.example`, `Prohibited ${role}`],
    );
    await db.admin.execute(
      `insert into memberships (id, organization_id, user_id, role, has_org_wide_scope)
       values (?, ?, ?, ?, ?)`,
      [
        uuidv7(),
        world.northstar.organizationId,
        userId,
        role,
        role === 'owner' || role === 'org_admin',
      ],
    );
    roleUsers.set(role, userId);
  }
}, 300_000);

afterAll(async () => {
  await stopHarness({ app, db });
});

describe('§2 prohibitions, transcribed by hand and not derived', () => {
  for (const { role, capability, matrixRow } of FORBIDDEN) {
    it(`'${role}' must never hold '${capability}' (§2 "${matrixRow}")`, () => {
      expect(
        hasCapability(role, capability),
        `${role} holds ${capability}, which "${matrixRow}" marks No/Never`,
      ).toBe(false);
    });
  }

  it('the transcription covers every §2 row that marks at least one role No or Never', () => {
    // A guard against a future edit quietly deleting cells out of the table above. Both the
    // row names and the number of prohibitions each row contributes are hand-written from
    // §2; nothing here is counted off the table it is checking, so dropping a cell fails
    // its row rather than hiding inside a total.
    //
    // "Submit client request" is 5 rather than 7: §2 marks all seven internal roles `No`,
    // and Owner and Org Admin are held in `MATRIX_DIVERGENCES` (see the note above).
    // "View client projection" is absent on purpose — all eleven of its cells are scopes.
    const expectedCellsPerRow: readonly (readonly [string, number])[] = [
      ['Billing/ownership', 9],
      ['Org security/SSO', 9],
      ['Workspace settings', 7],
      ['Create project', 7],
      ['Manage project members', 6],
      ['View internal project', 4],
      ['Moderate messages', 3],
      ['Create/edit work', 9],
      ['Publish to client', 5],
      ['Submit client request', 5],
      ['Approve governed version', 1],
      ['Invite client users', 6],
      ['View audit log', 3],
      ['Export tenant', 9],
    ];

    for (const [row, cells] of expectedCellsPerRow) {
      const actual = FORBIDDEN.filter((entry) => entry.matrixRow === row).length;
      expect(actual, `§2 row "${row}" should contribute ${cells} prohibitions`).toBe(cells);
    }

    // No row may appear that the list above does not name — the guard has to be closed in
    // both directions, or a renamed row would silently stop being checked.
    const named = new Set(expectedCellsPerRow.map(([row]) => row));
    for (const entry of FORBIDDEN) {
      expect(named.has(entry.matrixRow), `unknown §2 row "${entry.matrixRow}"`).toBe(true);
    }

    expect(FORBIDDEN.length).toBe(83);
  });

  it('every one of the eleven roles is accounted for, none silently absent', () => {
    // The defect this file closes is a *widening* nobody notices. A role that quietly drops
    // out of the transcription is the same failure wearing a different hat, so the roster is
    // written out by hand — eleven names from `12-PERMISSION-MATRIX.md` §1 — and each one
    // must be named somewhere in this suite.
    //
    // Owner and Org Admin have exactly one §2 prohibition between them ("Submit client
    // request"), and the product's ceiling grants it, so they are accounted for through
    // `MATRIX_DIVERGENCES` instead of `FORBIDDEN`. That is stated here rather than left to be
    // inferred from an empty result: if either ever gains an assertable prohibition, this
    // test is the place that has to be revisited on purpose.
    const rolesWithAssertedProhibitions: readonly Role[] = [
      'workspace_admin',
      'manager',
      'moderator',
      'member',
      'guest',
      'client_admin',
      'client_reviewer',
      'client_member',
      'client_viewer',
    ];
    const rolesRecordedAsDivergences: readonly Role[] = ['owner', 'org_admin'];

    const asserted = new Set(FORBIDDEN.map((entry) => entry.role));
    for (const role of rolesWithAssertedProhibitions) {
      expect(asserted.has(role), `'${role}' has no asserted prohibition left`).toBe(true);
    }

    const diverged = new Set(MATRIX_DIVERGENCES.map((entry) => entry.role));
    for (const role of rolesRecordedAsDivergences) {
      expect(diverged.has(role), `'${role}' is no longer accounted for anywhere`).toBe(true);
      expect(asserted.has(role), `'${role}' gained an assertion without a decision`).toBe(false);
    }

    // The two lists together are exactly §1's roster, with nothing invented and nothing lost.
    expect([...rolesWithAssertedProhibitions, ...rolesRecordedAsDivergences].sort()).toEqual(
      [...INTERNAL_ROLES, ...CLIENT_ROLES].sort(),
    );
  });

  it('every client role is covered by the external prohibition list', () => {
    // `NEVER_EXTERNAL` is asserted per client role below; this guarantees the loop that does
    // it cannot become empty, and that the list keeps its hand-written length.
    expect(CLIENT_ROLES.length).toBe(4);
    expect(NEVER_EXTERNAL.length).toBe(15);
  });

  it('records the two cells where §2 and the product ceiling disagree', () => {
    // Not an assertion about the product — an assertion that the finding is still written
    // down. If someone closes the gap, this fails and the note gets revisited on purpose.
    expect(MATRIX_DIVERGENCES.map((entry) => `${entry.role}:${entry.capability}`)).toEqual([
      'owner:client_request.submit',
      'org_admin:client_request.submit',
    ]);
  });
});

describe('no external principal reads internal content', () => {
  for (const role of CLIENT_ROLES) {
    for (const capability of NEVER_EXTERNAL) {
      it(`'${role}' can never hold '${capability}'`, () => {
        expect(
          hasCapability(role, capability),
          `${role} is an external principal and ${capability} reads internal content`,
        ).toBe(false);
      });
    }
  }
});

describe('the prohibition holds over HTTP, with its security event', () => {
  for (const cell of HTTP_PROHIBITIONS) {
    it(`'${cell.role}' is refused GET ${cell.path} (§2 "${cell.matrixRow}")`, async () => {
      const session = await signIn(roleUsers.get(cell.role) as string);
      const response = await get(cell.path, session);
      expect(
        response.statusCode,
        `${cell.role} must be refused ${cell.path} (${cell.capability})`,
      ).toBe(403);
    });
  }

  it('each refusal left exactly one security event, and nothing else did', async () => {
    // §12 of `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md`: denied sensitive attempts are
    // security events with safe metadata. The count is a literal, so a guard that stops
    // auditing fails here rather than passing quietly.
    expect(HTTP_PROHIBITIONS.length).toBe(EXPECTED_DENIAL_EVENTS);

    const rows = await observe(
      `select count(*) as n from audit_events
        where organization_id = ? and action = 'security.capability_denied'`,
      [world.northstar.organizationId],
    );
    expect(Number(rows[0]?.['n'])).toBe(EXPECTED_DENIAL_EVENTS);
  });
});

// ── Reconciliation · one transcription of §2's values, sourced from x11 ────────

/**
 * The review of x11+x7 asked for one canonical transcription of §2's allow/deny truth, not
 * two that will drift. x11 owns that transcription (`PERMISSION_MATRIX`, guarded against the
 * ceiling by `permission-matrix-fixture.test.ts`); this suite sources its truth from it.
 *
 * These cases assert a *relationship* between this suite's scope choice and the canonical
 * fixture, so neither re-derives the other's answer: `FORBIDDEN` and `NEVER_EXTERNAL` remain
 * this suite's own list of which cells are worth proving as hard prohibitions, and every one
 * of those cells must also be denied in `PERMISSION_MATRIX`. If a future edit to §2 moves a
 * cell from denied to granted in the canonical fixture and forgets this suite, the mismatch
 * fails here rather than leaving two documents quietly disagreeing.
 *
 * They are pure set-membership checks over hand-written literals — no database, no product
 * evaluator — but they live in this file so they travel with the prohibitions they reconcile.
 */
describe('reconciliation with the canonical §2 transcription (@tmanage/test-kit)', () => {
  it('every hand-picked prohibition is also denied in the canonical fixture', () => {
    for (const { role, capability, matrixRow } of FORBIDDEN) {
      expect(
        PERMISSION_MATRIX[role].denied.includes(capability),
        `${role} × ${capability} ("${matrixRow}") is proved here as a hard prohibition but ` +
          `is not in PERMISSION_MATRIX[${role}].denied — the two transcriptions of §2 disagree`,
      ).toBe(true);
    }
  });

  it('every never-external capability is denied for all four client roles in the fixture', () => {
    for (const role of CLIENT_ROLES) {
      for (const capability of NEVER_EXTERNAL) {
        expect(
          PERMISSION_MATRIX[role].denied.includes(capability),
          `${role} × ${capability} is asserted never-external here but is not denied for ` +
            `${role} in the canonical fixture`,
        ).toBe(true);
      }
    }
  });

  it('the recorded divergences match x11 register of accepted ceiling divergences', () => {
    // Owner and Org Admin's `client_request.submit` is a cell where §2 says No but the ceiling
    // grants it. This suite records it in MATRIX_DIVERGENCES; x11 records the same two cells in
    // ACCEPTED_CEILING_DIVERGENCES with `ceiling: 'grants'`. Tie the two registers together so
    // neither can drop the finding without the other noticing.
    const acceptedGrants = new Set(
      ACCEPTED_CEILING_DIVERGENCES.filter((d) => d.ceiling === 'grants').map(
        (d) => `${d.role}:${d.capability}`,
      ),
    );
    for (const { role, capability } of MATRIX_DIVERGENCES) {
      expect(
        acceptedGrants.has(`${role}:${capability}`),
        `${role} × ${capability} is held as a divergence here but x11 does not accept it as a ` +
          `ceiling-grants divergence`,
      ).toBe(true);
    }
  });

  it('resolves the guest "Own only"/"Explicit" reading as an intentional, subset asymmetry', () => {
    // The single cell §2's prose is read two ways. x11 reads guest's `Own only`
    // (`conversation.write`) and `Explicit` (`work.create`, `work.transition`) as denials; this
    // suite reads them as scope narrowings and does not assert them as hard prohibitions. Both
    // readings coexist because FORBIDDEN ⊆ denied: x11 owns the stricter reading in its guard,
    // and this suite abstains rather than over-claiming what §2 states. Asserted, not just
    // described, so a later edit that quietly adopts one reading everywhere trips here.
    const guestInterpretiveDenials: readonly Capability[] = [
      'conversation.write', // §2 "Moderate messages": Own only
      'work.create', // §2 "Create/edit work": Explicit — originate
      'work.transition', // §2 "Create/edit work": Explicit — state is the project's
    ];
    const forbiddenGuestCells = new Set(
      FORBIDDEN.filter((entry) => entry.role === 'guest').map((entry) => entry.capability),
    );
    for (const capability of guestInterpretiveDenials) {
      expect(
        PERMISSION_MATRIX.guest.denied.includes(capability),
        `x11 no longer denies guest ${capability}; the reading conflict has changed shape`,
      ).toBe(true);
      expect(
        forbiddenGuestCells.has(capability),
        `guest ${capability} is now asserted as a hard prohibition here — that adopts x11 ` +
          `reading and must be a deliberate, documented decision`,
      ).toBe(false);
    }
  });
});
