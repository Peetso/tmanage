# ADR-0015 — The AI acts with the account's full rights, and reaches platform admin only through a step-up-bound path

- **Status:** Proposed (part 1 built 2026-11-23, part 2 waits for design review)
- **Date:** 2026-11-23
- **Deciders:** Peter (owner) decided the principle; implementation lead (Opus 5.5) proposes the design; Fable 5.2 reviews it (CO-1)
- **Rules affected:** SE-8, SE-1, SE-3, HT-1; **bends a rule:** yes. It bends plan 62 §4.1 step 5 ("never manage, never billing") and the bound-token rule F01 part b (`bound-token-allowlist.ts`) for platform routes only
- **Quality scenarios:** QA-SE-* (no privilege beyond the member), QA-AV-1
- **Evidence:** `apps/api/src/modules/copilot/copilot-chat.service.ts` `chatScopesFor`; `apps/api/src/modules/copilot/ai-preview.ts` `changeGateFor`; `apps/api/src/modules/platform-admin/platform-admin.guard.ts` (rules 1–5); `apps/api/src/common/http/guards/bound-token-allowlist.ts`; `work/pass-2026-11-23/AI-MCP-PARITY-AUDIT.md`

## Context

On 2026-11-23 the owner said, as an absolute rule: "THE AI SHOULD DO ANYTHING THAT I CAN DO". He also said: "both [the external MCP and the in-app AI] should do whatever the account has the right to do ... the MCP connected to a site admin should be able to access the admin platform and any action in it".

Before this, the system worked like this:

- **The in-app chat** ran with `read` or `read write` only. Manage ops such as invitations could not be reached.
- **The registry** (`OPS` plus `NEVER`) holds 1,627 routes. 725 of them are in `NEVER`. 238 of those are platform admin, and the rest have reasons that are no longer accepted.
- **The external MCP** consent page turned manage and billing off by default.
- **Platform admin** (`PlatformAdminGuard`) accepts only a browser session. A personal access token is refused (rule 2). Every route except two needs a fresh step-up in that same session (rule 5), and some need two-person approval (`TwoPersonApprovalGuard`). Bound tokens are refused on every `@NoTenant()` route unless the route is on an allowlist.

## Decision

### Part 1 — built 2026-11-23 (commits `b841bb5f` and the parity commit)

1. **In-app chat scopes.** With the owner's `read_write` setting, a turn runs with every scope (`CHAT_FULL_SCOPES`). The `read` setting stays read only. The member's capabilities still filter the tool catalogue (`capabilitySatisfied`), and the API's `@RequireCapability` still decides every inner request.
2. **The card is the safety, not the scope.**
   - Every change is proposed on a card.
   - "Run at once" covers only ops that meet all of these: `risk: write`, `scope: write`, not `DELETE`, sensitivity `none`, and has an undo.
   - Manage, billing, destructive and confirm-class ops always go on a card. Confirm-class ops are frozen in `pending_ai_actions` and run once, as the member, when the member confirms.
   - The untrusted-content taint rule is unchanged.
3. **External MCP consent.** Every scope the person can grant is on by default. Billing still needs an owner or admin role: the server refuses it (`resolveGrantedScopes`) and the page greys it out. The person can still switch any scope off. Granted scopes really expose manage ops (test `parity-2026-11-23.test.ts`).
4. **Parity rule.** A route stays in `NEVER` only for one of these reasons:
   - **K1:** sign-in, password, two-step, sessions, recovery, account creation, OAuth/consent, or issuing a third-party credential or token.
   - **K2:** the AI approving its own pending actions or cards, or reaching its own surface.
   - **K3:** showing or minting a raw secret.
   - **K4:** the route is not an action of an account (public, transport, telemetry).
   - **K5:** an existing op already covers it.

   Every other route becomes an op. Batch 1 (the iteration writes) is done. The remaining batches are listed in the audit.

### Part 2 — proposed: platform admin for AI principals

5. **Platform ops in the registry.**
   - A `platform.*` op family for `/v1/platform/*`, with `capability: null` and a new field `platformPermission` (the route's `@RequirePlatformPermission`).
   - `registry-sync.test.ts` checks that field against the route, the same way it checks capabilities.
   - `buildOpRequest` builds these paths without `:orgSlug`.
   - Every platform op that changes something is `risk: confirm`.
6. **The catalogue filters by platform rights.** When the surface is built, the account's platform record is read (`PlatformAdminLookup.findAccount` / `findPlatformAdmin`). A platform op is listed only when the account holds its permission.
   - A non-admin never sees the ops.
   - A call by id answers "Unknown or not permitted action", the same as for any op the member lacks.
7. **The inner request carries a step-up binding.** An internal AI grant may reach `/v1/platform/*`, and only an internal grant: a PAT or an external OAuth token sent straight to REST stays refused, so F01 holds. `PlatformAdminGuard` accepts such a grant only when:
   - **(a)** the account is a platform admin with the route's permission (rules 3–4, unchanged);
   - **(b)** the grant carries `stepUpSessionId`, the browser session the member stepped up in. For the in-app chat this is the chat request's own cookie session. Rule 5 is then checked against that session, unchanged.
8. **External MCP clients have no browser session.**
   - They get platform ops only through a new consent scope, `tmanage:platform`. The consent page offers it only to platform admins, and only right after a fresh step-up.
   - The grant records that step-up session, and its platform scope expires with the step-up window (`PLATFORM_STEP_UP_MINUTES`).
   - Platform changes are frozen and approved on the approve page in person, so the cookie session, the step-up and `TwoPersonApprovalGuard` all apply unchanged.
9. **Audit.** Platform audit rows record the AI client ("via TManage AI" or the OAuth client's name), as tenant audit rows already do.

## Alternatives considered

| Option                                                  | Pros                    | Cons                                                                           | Why not chosen                               |
| ------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| Keep "never manage, never billing"                      | Smallest attack surface | Breaks the owner's absolute rule; invitations fail                             | Owner decision                               |
| Full scopes and run-at-once for everything              | Fastest for the member  | A prompt injection could invite outsiders or change billing with no human look | The card is the compensating control         |
| Let a PAT or OAuth token call `/v1/platform/*` directly | Simple                  | Undoes F01; a leaked token becomes platform admin without step-up              | Step-up binding (7–8) keeps the human factor |
| Platform reads without step-up for AI                   | Smooth                  | Rule 5 exists because platform data spans every company                        | Rejected                                     |

## Consequences

- **Good:** the AI can do what the member can do. A member without a right is refused by the same checks as the website.
- **Bad:** a tricked model can now _propose_ manage, billing and platform changes. Each one waits on a card the member reads and confirms. Money and HR still need step-up and a typed amount.
- **Compensating control:** the card for every manage, billing, destructive and confirm-class op; the taint rule; step-up for platform; two-person approval unchanged.
- **Exit condition:** none. This is the product rule. Part 2 starts only after the design review accepts points 5–9.

## Fitness functions

| Rule                                                             | Check (path)                                                              | Exists / to build                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------- |
| Chat runs with full scopes only on `read_write`                  | `apps/api/src/modules/copilot/ai-full-rights.test.ts`                     | Exists                                |
| Manage, billing and DELETE ops always on a card                  | `apps/api/src/modules/copilot/ai-preview.test.ts` (sweep over `OPS`)      | Exists                                |
| A member without the capability is refused, nothing sent         | `ai-full-rights.test.ts`, `ai-actions/registry/parity-2026-11-23.test.ts` | Exists                                |
| Every route is an op or a NEVER entry with a K1–K5 reason        | `registry-sync.test.ts` + a reason allowlist                              | To build (with the remaining batches) |
| Platform op listed only for an admin with the permission         | `platform` catalogue test                                                 | To build (part 2)                     |
| Platform inner request without a live step-up session is refused | guard test                                                                | To build (part 2)                     |
