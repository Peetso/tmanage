# ADR-0014 — Members see the roster, cut to what the UI needs; guests see only the people they share a project with

- **Status:** Accepted (lane P, QA-FIX pass 2026-11-20; the manager may revisit)
- **Date:** 2026-11-20
- **Deciders:** implementation lead (Opus 5.5, lane P); Peter delegated the open product decisions (2026-09-05)
- **Rules affected:** AR-8, AR-9, SE-1; tenancy T-1; **bends a rule:** no
- **Quality scenarios:** security (confidentiality) before convenience, per QM-2
- **Evidence:** QA report M5 and security report S2 (2026-11-20). `apps/api/src/modules/tenancy/members.controller.ts:97-138` (before this change) returned `userId, displayName, role, status` for every active member to any holder of `work.read`, a zero-project member and a guest included. `apps/api/src/modules/people/directory.controller.ts:159-169` (before) also gave every internal viewer each member's **e-mail address** (the address the earlier QA pass saw).

## Context

Two routes answer "who is in this organization":

- `GET /v1/organizations/:slug/members` (`work.read`): the picker behind every "assign to" and "@mention" field (D16).
- `GET /v1/organizations/:slug/people` (`people.view`): the People page.

Clients hold neither capability, so they already get 403 (`capabilities.ts` client ceilings). Every internal role, `guest` included, holds both. The tester's question is whether a member who works on no project should see the whole roster.

What the comparable products do (checked on the web, 2026-11-20):

- **Slack**: the member directory (Home → Directories → People) is open to every member; it can be filtered by account type, and an owner or admin can hide e-mail addresses from it. https://slack.com/help/articles/360003534892 . Guests reach only the channels they are given, and see members "in channels and DMs they can access". https://slack.com/help/articles/202518103-Understand-guest-roles-in-Slack
- **Asana**: guests "can only see what is explicitly shared with them", and two guests see each other's names only if they share a project or team; members see the organization. https://help.asana.com/s/article/guests-faq
- **OWASP ASVS 5.0 V8.2.3** (field level): access to specific fields is limited to consumers with explicit permission to them. https://raw.githubusercontent.com/OWASP/ASVS/master/5.0/en/0x17-V8-Authorization.md

## Decision

1. **Members keep a roster** (names and roles) for mentions and assignment, as in Slack and Asana. A member on zero projects is still a colleague who can be mentioned and given work.
2. **The payload is cut to what the screens need.** Name, user id (what a work item stores) and role (shown as the role chip in People, chat and activity) stay. **Status** and **e-mail** are administration fields, sent only to a viewer whose capabilities include `org.manage`. `status` became optional on both views; `email` is `null`.
3. **Guests see only the people who share a project with them**, plus themselves (Asana's model). A guest on no project sees only themselves.
4. **Clients stay 403** (no `work.read`, no `people.view`), unchanged.
5. The decisions are made once, in `packages/domain/src/policies/member-authority.ts` (`rosterScopeFor`, `seesRosterAdminFields`), and used by both routes (AR-8).

## Alternatives considered

| Option                                   | Pros              | Cons                                                                                        | Why not chosen                                                              |
| ---------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Scope every member to project co-members | Smallest exposure | Breaks @mentions and "assign to" for anyone outside a project; differs from Slack and Asana | Fails the product's main job; the tester asked only for a deliberate choice |
| 403 for guests                           | Simplest          | A guest on a shared project can no longer see who owns the work they review                 | Asana's shared-project model keeps the guest's work possible                |
| Keep everything as is                    | No change         | E-mail and status reach every member and guest                                              | ASVS V8.2.3; no screen needs them outside administration                    |
| Hide `role` too                          | Smaller payload   | The role chip is shown to everyone on People and in chat                                    | It is shown in the UI, so it stays                                          |

## Consequences

- Good: a member or guest can no longer harvest every address; the People page still works for everyone.
- Neutral: `status` was always `active` on both routes (they list active members only), so dropping it hides nothing anyone used.
- Bad: a guest's people list is narrower; an assignee picker on a shared project still finds everyone on that project.
- Residual: `version` (a compare-and-swap counter) and `lastActiveAt` are still sent to members on `/people`. Neither is a contact detail; review them if the People page stops showing "Last active" to members.

## Fitness functions

| Rule                                         | Check (path)                                                                                  | Exists / to build |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------- |
| Zero-project member keeps names, no status   | `apps/api/src/modules/tenancy/members-directory.test.ts` ("S2: a member with zero projects…") | exists            |
| Guest sees shared-project people only        | same file ("S2: a guest sees only…")                                                          | exists            |
| No e-mail or status to a member on `/people` | `apps/api/src/modules/people/directory.controller.test.ts`                                    | exists            |
| The two decisions                            | `packages/domain/src/policies/member-authority.test.ts`                                       | exists            |
| Roster scoping against real MariaDB          | `apps/api/test/mem-002-members-route.db.test.ts` (extend with a guest row)                    | to build          |
