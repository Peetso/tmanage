# Permission test map

Required by `15-AI-EXECUTION-HANDBOOK.md` §5. One row per `12-PERMISSION-MATRIX.md` §2 capability
row: where the **grant** is proved, and where the **prohibition** is proved.

The two columns must not share a source of truth. `CAPABILITY_CEILING`
(`packages/domain/src/policies/capabilities.ts`) is one transcription of §2 and the product obeys
it; `apps/api/test/sec-002-role-prohibitions.db.test.ts` is a second, hand-written transcription of
§2's `No` and `Never` cells that nothing obeys. A test that reads its expectation from the ceiling
cannot notice the ceiling widening — that was finding D18 — so the prohibition column never does.

| §2 row                   | Capability                                       | Prohibition proved                                                                            | Grant proved                                                           |
| ------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Billing/ownership        | `org.manage`                                     | `sec-002-role-prohibitions.db.test.ts` (table + `GET /invitations` 403)                       | `test-001-role-matrix.db.test.ts`                                      |
| Org security/SSO         | `org.security.manage`                            | `sec-002-role-prohibitions.db.test.ts` (table)                                                | — no route yet                                                         |
| Workspace settings       | `workspace.manage`, `project.manage`             | `sec-002-role-prohibitions.db.test.ts` (table)                                                | `proj-001-project-creation.db.test.ts`                                 |
| Create project           | `project.create`                                 | `sec-002-role-prohibitions.db.test.ts` (table)                                                | `proj-001-project-creation.db.test.ts`                                 |
| Manage project members   | `project.member.manage`                          | `sec-002-role-prohibitions.db.test.ts` (table)                                                | `proj-001-repositories.db.test.ts`                                     |
| View internal project    | `work.read`                                      | `sec-002-role-prohibitions.db.test.ts` (table, all four client roles)                         | `test-001-role-matrix.db.test.ts`, `work-001-work-items.db.test.ts`    |
| Moderate messages        | `conversation.moderate`                          | `sec-002-role-prohibitions.db.test.ts` (table, three client roles)                            | `chat-001-conversations.db.test.ts`                                    |
| Create/edit work         | `work.create`, `work.update`, `work.transition`  | `sec-002-role-prohibitions.db.test.ts` (table, three client roles)                            | `work-001-work-items.db.test.ts`                                       |
| Publish to client        | `deliverable.publish`                            | `sec-002-role-prohibitions.db.test.ts` (table)                                                | `sec-001-client-projection.db.test.ts`                                 |
| View client projection   | `client_projection.read`                         | — no `No`/`Never` cell in this row                                                            | `sec-001-client-projection.db.test.ts`, `client-002-portal.db.test.ts` |
| Submit client request    | `client_request.submit`, `client_request.triage` | `sec-002-role-prohibitions.db.test.ts` (table + `GET /client-requests` 403); see divergence 1 | `req-001-client-requests.db.test.ts`                                   |
| Approve governed version | `approval.decide`                                | `sec-002-role-prohibitions.db.test.ts` (table, Client Viewer)                                 | `sec-001-client-projection.db.test.ts`                                 |
| Invite client users      | `client_member.manage`                           | `sec-002-role-prohibitions.db.test.ts` (table)                                                | `client-001-clients.db.test.ts`, `ten-003-invitations.db.test.ts`      |
| View audit log           | `audit.read`                                     | `sec-002-role-prohibitions.db.test.ts` (table)                                                | `aud-001-audit.db.test.ts`                                             |
| Export tenant            | `audit.export`                                   | `sec-002-role-prohibitions.db.test.ts` (table)                                                | `aud-001-audit.db.test.ts`                                             |

## The prohibition grid, written out

This is the half of `12-PERMISSION-MATRIX.md` §2 that this project had never restated: only the
cells reading `No` or `Never`. It is transcribed by hand from §2 and it matches, cell for cell, the
`FORBIDDEN` table in `apps/api/test/sec-002-role-prohibitions.db.test.ts` — read this grid against
§2 with your eyes, and the suite checks the product against it.

`FORBIDDEN` is not a competing transcription of §2's allow/deny _truth_. That truth lives once, in
`packages/test-kit/src/permission-matrix.ts` (`PERMISSION_MATRIX`), guarded against the shipped
ceiling by `apps/api/src/common/http/guards/permission-matrix-fixture.test.ts`. `FORBIDDEN` is this
suite's _scope choice_ — which of §2's `No`/`Never` cells are worth proving as hard prohibitions —
and the suite's `reconciliation` block asserts every `FORBIDDEN` cell is also in
`PERMISSION_MATRIX[role].denied`, so the two can never drift into contradiction. What stays unique
to this suite is the product-behaviour check, the HTTP-403s and the audit count.

`·` means the cell is **not** a prohibition: `Full`, `Yes`, `Policy`, `Scope`, `Project`, `Member`,
`Limited`, `Optional`, `Explicit`, `Own only`, `Assigned`, `If reviewer` and the rest are ceilings
the evaluator in `authorize.ts` narrows at decision time. Asserting one of those as a refusal here
would be wrong, so none of them are counted.

Columns are `12-PERMISSION-MATRIX.md` §1's eleven roles, in §2's order: Owner, Org Admin, Workspace
Admin, Manager, Moderator, Member, Guest, Client Admin, Client Reviewer, Client Member, Client
Viewer.

| §2 row                   | Own  | OrgA | WsA | Mgr | Mod | Mem | Gst | CliA  | CliR  | CliM  | CliV  |
| ------------------------ | ---- | ---- | --- | --- | --- | --- | --- | ----- | ----- | ----- | ----- |
| Billing/ownership        | ·    | ·    | No  | No  | No  | No  | No  | No    | No    | No    | No    |
| Org security/SSO         | ·    | ·    | No  | No  | No  | No  | No  | No    | No    | No    | No    |
| Workspace settings       | ·    | ·    | ·   | ·   | No  | No  | No  | No    | No    | No    | No    |
| Create project           | ·    | ·    | ·   | ·   | No  | No  | No  | No    | No    | No    | No    |
| Manage project members   | ·    | ·    | ·   | ·   | ·   | No  | No  | No    | No    | No    | No    |
| View internal project    | ·    | ·    | ·   | ·   | ·   | ·   | ·   | Never | Never | Never | Never |
| Moderate messages        | ·    | ·    | ·   | ·   | ·   | ·   | ·   | No    | No    | ·     | No    |
| Create/edit work †       | ·    | ·    | ·   | ·   | ·   | ·   | ·   | No    | No    | ·     | No    |
| Publish to client        | ·    | ·    | ·   | ·   | ·   | ·   | No  | No    | No    | No    | No    |
| View client projection   | ·    | ·    | ·   | ·   | ·   | ·   | ·   | ·     | ·     | ·     | ·     |
| Submit client request    | No ‡ | No ‡ | No  | No  | No  | No  | No  | ·     | ·     | ·     | ·     |
| Approve governed version | ·    | ·    | ·   | ·   | ·   | ·   | ·   | ·     | ·     | ·     | No    |
| Invite client users      | ·    | ·    | ·   | ·   | No  | No  | No  | ·     | No    | No    | No    |
| View audit log           | ·    | ·    | ·   | ·   | No  | ·   | No  | ·     | ·     | ·     | No    |
| Export tenant            | ·    | ·    | No  | No  | No  | No  | No  | No    | No    | No    | No    |

† "Create/edit work" is one §2 row over three capabilities — `work.create`, `work.update` and
`work.transition` — so each of its three `No` columns is three assertions, nine in all.

‡ Held in `MATRIX_DIVERGENCES` and deliberately **not** asserted; see divergence 1 below.

Count the grid and it comes to 83 asserted cells: 9 + 9 + 7 + 7 + 6 + 4 + 3 + (3 × 3) + 5 + 0 + 5 +
1 + 6 + 3 + 9. The suite asserts that per-row split as literals, so deleting a single cell fails its
own row rather than disappearing into a total.

Every one of the eleven roles is accounted for. Nine carry asserted prohibitions; Owner and Org
Admin carry exactly one §2 prohibition between them and it is the divergence below, so they are
accounted for there instead — the suite asserts that placement explicitly rather than leaving an
empty result to be read as coverage.

Denied attempts are also required to be security events (`25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md`
§12). `sec-002-role-prohibitions.db.test.ts` counts `security.capability_denied` rows against a
literal; `test-001-role-matrix.db.test.ts` counts them against a derived total.

## Known divergences between §2 and the product

Recorded, not reconciled. Closing any of these is a permission change, which
`15-AI-EXECUTION-HANDBOOK.md` §7 requires to move the matrix, threat model, API policy, scoped
repository rules and isolation tests together.

1. **"Submit client request" is `No` for every internal role**, but `CAPABILITY_CEILING` gives
   `owner` every capability and `org_admin` every capability but `org.manage`, so both hold
   `client_request.submit`. The refusal happens object-side instead: the portal services reject an
   internal principal because a client request with no client organization cannot exist. Proved in
   `req-001-client-requests.db.test.ts` and `inbox-001-portal-inbox.db.test.ts`, and recorded in the
   comment at `test-001-role-matrix.db.test.ts:125-137`. Held in `MATRIX_DIVERGENCES` in the
   prohibitions suite and deliberately not asserted.
2. **"Billing/ownership" gives Org Admin `Policy`**, but the ceiling withholds `org.manage` from
   every role but Owner. The product is stricter than the matrix. The prohibitions suite asserts the
   Org Admin `/invitations` 403 as today's behaviour and flags the cell in place; if policy is ever
   allowed to grant it, that one row moves and the five `No` rows must not.
3. **`INTERNAL_ONLY_CAPABILITIES` (`capabilities.ts:340`) is stricter than §2** for
   `conversation.moderate`, `work.create`, `work.update` and `work.transition`: §2 gives Client
   Member `Own only` and `Client requests/actions` in those rows, while the domain list bars every
   client role outright. The hand transcription follows §2 and asserts only the three client roles
   whose cells read `No`. `search.use` appears in the domain list but has no §2 row at all, so it is
   not transcribed.
4. **Guest's `Own only`/`Explicit` cells are read two ways.** The canonical fixture
   (`PERMISSION_MATRIX`, slice x11) reads guest's `Own only` (`conversation.write`) and `Explicit`
   (`work.create`, `work.transition`) as denials; this suite reads them as scope narrowings and does
   not assert them as hard prohibitions. This is resolved rather than left open: `FORBIDDEN` is a
   subset of x11's `denied`, so both readings coexist without contradiction, and the suite's
   `reconciliation` block machine-checks that these three guest cells stay in x11's `denied` and out
   of `FORBIDDEN`. x11 owns the stricter reading in its ceiling guard; this suite abstains rather
   than over-claiming what §2 states.

## Coverage

The prohibitions suite covers 14 of §2's 15 rows in 83 hand-written cells — every row that marks at
least one role `No` or `Never`. The one uncovered row, "View client projection", has no `No`/`Never`
cell at all: every one of its eleven columns is a scope. Only `No` and `Never` cells are asserted:
`Policy`, `Scope`, `Project`, `Member`, `Limited`, `Optional`, `Explicit`, `Own only` and
`If reviewer` are narrowings applied by the evaluator in `authorize.ts`, not prohibitions.

The HTTP half is thin because the product exposes five capability-gated list routes and only two are
gated by a capability the matrix denies to anyone. The table-level assertions carry the guarantee
until more routes exist.

## platform-admin v2 · PA-01 — the 24 matrix capabilities

PA-01 added 24 capabilities (56 in total) so every cell of the permission matrix (SPEC §3.3) is
one capability, plus the `platform_support` role (TManage support inside an organization, never
assignable from the organization) and per-member overrides (`membership_permission_overrides`,
0242). The truth stays in `packages/test-kit/src/permission-matrix.ts`; each new capability's row
there cites the SPEC §3.3 ceiling paragraph, and the fixture test pins the count at 56 and keeps
every new capability away from the client roles.

| Capability(ies)                                                                                                                                                                                                                                 | Prohibition proved                                                                                                                                     | Grant proved                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `work.delete`, `file.delete`                                                                                                                                                                                                                    | `permission-matrix-fixture.test.ts` (member, guest, clients); role-operation grid                                                                      | `test-001-role-grid.db.test.ts` (DELETE work item, DELETE folder)                                          |
| `decision.read`, `decision.write`                                                                                                                                                                                                               | `permission-matrix-fixture.test.ts` (client roles)                                                                                                     | `test-001-role-grid.db.test.ts` (`GET`/`POST /decisions`)                                                  |
| `people.view`                                                                                                                                                                                                                                   | `permission-matrix-fixture.test.ts` (client roles)                                                                                                     | `test-001-role-grid.db.test.ts` (`GET /people`)                                                            |
| `roles.assign`                                                                                                                                                                                                                                  | `permission-matrix-fixture.test.ts`; `membership-overrides.controller.test.ts` (403 without it)                                                        | `perm-001-membership-overrides.db.test.ts`                                                                 |
| `billing.view`, `billing.manage`                                                                                                                                                                                                                | `permission-matrix-fixture.test.ts` (everyone but owner, org admin, support)                                                                           | `test-001-role-grid.db.test.ts` (`/billing/contacts`)                                                      |
| `ai.use`, `report.view`                                                                                                                                                                                                                         | `permission-matrix-fixture.test.ts` (client roles)                                                                                                     | `test-001-role-grid.db.test.ts` (`/me/personal-access-tokens`, `/insights/portfolio`)                      |
| `project.delete`, `work.export`, `conversation.delete`, `conversation.export`, `doc.delete`, `doc.export`, `decision.delete`, `meeting.delete`, `storage.manage`, `people.invite`, `people.edit`, `settings.view`, `ai.manage`, `report.export` | `permission-matrix-fixture.test.ts` (ceiling only)                                                                                                     | — declared, not yet on a route (`UNGUARDED_CAPABILITIES` in `role-operation-grid.ts`)                      |
| overrides (allow / deny)                                                                                                                                                                                                                        | `authorize.test.ts`, `override-ceiling.test.ts`, `perm-001-membership-overrides.db.test.ts` (an allow beyond the caller is a 403, an owner takes none) | `authorize.test.ts`, `perm-001-membership-overrides.db.test.ts` (an allow opens a route, a deny closes it) |
| `platform_support`                                                                                                                                                                                                                              | `membership-resolver.repository.test.ts`, `perm-002-platform-support-resolver.db.test.ts` (no live session = no membership)                            | the same two files (a live session resolves org-wide)                                                      |
