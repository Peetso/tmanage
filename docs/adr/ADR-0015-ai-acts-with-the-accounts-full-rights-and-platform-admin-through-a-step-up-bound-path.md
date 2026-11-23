# ADR-0015 — The AI acts with the account's full rights, and reaches platform admin only through a step-up-bound path

- **Status:** Accepted (part 1 built 2026-11-23; part 2 reviewed by Fable 5.2, verdict "FIX, then GO", F1–F11 applied as written, and built 2026-11-23)
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

### Part 2 — built 2026-11-23: platform admin for AI principals

The design review (`work/pass-2026-11-23/ADR-0015-FABLE-REVIEW.md`, Fable 5.2, verdict "FIX, then GO") asked for eleven changes, F1–F11. All eleven were taken as written. Each point below names the fix it carries.

5. **Platform ops in the registry.**
   - The `platform.*` op family covers every `/v1/platform/*` route (`registry/parity-b3-platform-{a,b,c,core}.ts`). Each op has `capability: null` and `platformPermission`: the route's `@RequirePlatformPermission`, or `null` where the route has none, which means any platform admin (`GET /me`, `GET /support-sessions/:id`).
   - `pop()` in `registry/platform-op.ts` decides each op's class, so no lane file chooses it:
     - a `GET` is `risk: read`, `scope: read`;
     - every other method is `risk: confirm`, `scope: manage`.
   - `buildOpRequest` builds these paths without `:orgSlug`. An argument that a `DELETE` route reads from the query string is listed in `queryArgs`.
   - `registry-sync.test.ts` mirrors `platformPermission` from the route, the same way it mirrors the capability.
   - **Platform sensitivities** are never `money` or `hr`.
   - **The public AI OpenAPI document** leaves the family out.
6. **The catalogue filters by platform rights** (`tool-catalog.ts` `platformSatisfied`, `mcp/platform-rights.ts`).
   - When the surface is built, the account's platform record is read with `resolvePlatformAdmin`, the same function the guard uses. A platform op is listed only when the account holds its permission.
   - Without platform rights (a non-admin, a PAT, or an OAuth grant outside its window), no platform op is listed, described or found. A call by id answers `Not permitted`, and no request is sent.
7. **The inner request carries a step-up binding (F2, F3, F4).**
   - `InternalGrantPayload.stepUpSessionId` is set by the server, from request state only. Its two sources:
     - **(a)** the in-app chat: the chat request's own cookie session (`copilot/chat-step-up-session.ts`, cookie scheme only);
     - **(b)** the approve page: the approving cookie session, with `pendingActionId` added (F3).
   - A PAT-minted grant never gets a binding (F2).
   - The tool input schemas are strict, so a model argument cannot carry one.
   - `PlatformAdminGuard` accepts an `ai_grant` only with a non-empty binding. It then checks rules 3–5 against the **bound** session. The live step-up is read at run time, and the bound session must still be live (`isSessionLive`). `me` and `step-up` are exempt for the person's own screen only, never for a grant.
   - The bound-token exception in `TenantContextGuard` is exact (F4). All three must hold:
     - the scheme is `ai_grant`;
     - the grant has a `stepUpSessionId`;
     - the matched handler or class is guarded by `PlatformAdminGuard`, read from the `__guards__` metadata through `PLATFORM_ADMIN_GUARD_MARK`.

     There is no `/v1/platform` string match, and the F01 allowlist is unchanged.
8. **External MCP clients: the `tmanage:platform` consent scope (F1, F11).**
   - **Consent-only scope.** `tmanage:platform` is in `CONSENT_SCOPES`. It is never in `KNOWN_SCOPES`, so a PAT or the company token policy can never hold it.
   - **Who sees it.** The consent page shows it only to a platform admin, and it is never pre-ticked.
   - **When it can be ticked.** Only with two-step sign-in on, and a step-up in this browser session no older than 10 minutes (`PLATFORM_CONSENT_STEP_UP_FRESH_MS`). The server refuses it otherwise (`resolveGrantedScopes`, audit code `consent_platform_refused`).
   - **What the grant records** (migration 0408): the consenting session as `oauth_grants.platform_step_up_session_id`, and its own window end as `platform_until`.
   - **The window** is `PLATFORM_AI_SCOPE_MINUTES`: 5–240 minutes, default 60, and never past the step-up's own end.
   - **When the reach stops.** The guard checks the live step-up and session on every call, so a sign-out or revoked session ends the reach at once.
   - **No refresh.** A refresh token issues new access tokens on the same grant, so it cannot move `platform_until`. A new window needs a new consent with a fresh step-up.
   - **Approval.** Platform changes are frozen in `pending_ai_actions` and approved on the approve page (F3).
   - **Rate cap.** At most 30 platform proposals per person and AI client per hour; the next one gets 429 `rate_limited` (`PLATFORM_PROPOSALS_PER_HOUR`).
9. **Audit (F9, F10).** Platform audit rows record the AI client and the pending action it executes. The values come from the actor the guard proved, never the body, and are stored as `platform_admin_audit_events.ai_client_name` and `ai_pending_action_id` (migration 0408). A reason stored together with an AI client records that the AI drafted it and the person approved it.
10. **F5 — fresh re-authentication at approval.**
    - Ops marked `freshReauth` get the `step_up` card, like money and HR. `changeGateFor` handles this, and `approveInPerson` refuses without a fresh `x-reauth-token`. The marked ops are `PLATFORM_FRESH_REAUTH_ROUTES` plus every change that needs `platform.team.manage` or `platform.permissions.edit` (`PLATFORM_FRESH_REAUTH_PERMISSIONS`: the admin team and presets, the two-person policy, a company's roles and role matrix, a member's overrides).
    - The F5 set covers:
      - suspension, reactivation, deletion, purge and ownership transfer of a company;
      - a member's role and permission overrides, and the plan;
      - support-session start and extend;
      - another person's password reset, sign-out, disable and enable, two-step reset and required flag, and ending their sessions;
      - every network-access rule;
      - AI access, the AI budget, the AI test list and packs;
      - billing mode, public sign-up, retention and integrations;
      - the second-admin approve;
      - key rotation.
    - Ownership transfer is also `destructive` in its sensitivity (it is undone only by another transfer).
    - Every other platform change is a plain card.
    - A card lists up to 24 fields (`MAX_CARD_FIELDS`, was 12; the platform incident and announcement changes carry up to 19). A sweep keeps every op's input within one card, and the chat still refuses a change whose card would hide a field.
11. **F6 — platform reads are untrusted.** `isUntrustedOp` is true for every platform read, by rule. So the result is wrapped as untrusted, and the turn is tainted.
12. **F7 — route by route.**
    - 236 audited platform routes, plus `keys/status` and `keys/rotate`, moved from `NEVER: platform_admin` to ops. The reason `platform_admin` no longer exists.
    - Two routes stay `NEVER`, each with its own reason:
      - `POST /v1/platform/step-up`, `platform_step_up` (K1: the human factor itself);
      - `GET /v1/platform/organizations/:id/content/files/:fileId/download`, `platform_binary_transport` (K4: a binary stream; the file read op gives the details, and the person opens the file in Platform admin).
    - Key rotation is an op because its answer shows no raw key (K3 does not apply).
    - The route table is `work/pass-2026-11-23/AI-MCP-PARITY-AUDIT.md` (rows marked `OPENED-P`, 236).
    - `registry-sync.test.ts` fails on any platform route that is neither a platform op nor one of these two.
13. **F8 — support visits: option (b), with the reason.**
    - The AI can start, extend and end a support visit. The visit belongs to the person's browser session (the actor's `sessionId` is the bound session).
    - The AI acts on any company through the `platform.*` content and lifecycle ops.
    - A bound token stays refused _inside_ the support membership (`tenant-context.guard.ts`). The reason is technical:
      - the internal grant is bound to one workspace, the admin's own;
      - the support membership is bound to the browser session and the visited workspace;
      - letting a grant cross into the visited workspace would need a second tenant binding that no grant carries today.
    - Option (a), a grant scoped to the visit with the visit's own limits, is left for a later batch with its own test.
14. **F9 — the card.**
    - The approve page shows the action in plain words and the target company or person by name. The server looks the name up with the platform read, bound to the viewing session.
    - It also shows the platform permission used, whether a second admin is needed while the two-person rule is on, and the reason text.
    - Every platform change input takes one target: no platform change input holds a list of target ids.
    - The two-person rule is unchanged (`TwoPersonApprovalGuard`). One admin's AI cannot fill both roles, because the actor is the person (governance test).
15. **F10 — which workspace.**
    - A platform action is frozen and approved under the admin's own bound workspace.
    - The platform AI switch and that workspace's AI switch both apply, as for every AI call.
    - Platform ops are offered only on a grant bound to a workspace the admin is a member of. A bound grant always is.

## Alternatives considered

| Option                                                  | Pros                    | Cons                                                                           | Why not chosen                               |
| ------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| Keep "never manage, never billing"                      | Smallest attack surface | Breaks the owner's absolute rule; invitations fail                             | Owner decision                               |
| Full scopes and run-at-once for everything              | Fastest for the member  | A prompt injection could invite outsiders or change billing with no human look | The card is the compensating control         |
| Let a PAT or OAuth token call `/v1/platform/*` directly | Simple                  | Undoes F01; a leaked token becomes platform admin without step-up              | Step-up binding (7–8) keeps the human factor |
| Platform reads without step-up for AI                   | Smooth                  | Rule 5 exists because platform data spans every company                        | Rejected                                     |
| External platform scope on the 24-hour browser window   | One window to explain   | A bearer token on another machine reads every company for a day (review F1)    | Own window, 60 minutes by default (point 8)  |

## Consequences

- **Good:** the AI can do what the member can do. A member without a right is refused by the same checks as the website.
- **Bad:** a tricked model can now _propose_ manage, billing and platform changes. Each one waits on a card the member reads and confirms. Money and HR still need step-up and a typed amount.
- **Compensating control:** the card for every manage, billing, destructive and confirm-class op; the taint rule (every platform read taints); a live step-up bound to the person's browser session for every platform call; fresh re-auth on the F5 set; the external scope's own short window; a cap on platform proposals; two-person approval unchanged.
- **Exit condition:** none. This is the product rule.
- **Left for a later batch:** F8 option (a), an AI grant acting inside a support visit (point 13).

## Fitness functions

| Rule                                                                                                                                                                       | Check (path)                                                                    | Exists / to build      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------- |
| Chat runs with full scopes only on `read_write`                                                                                                                            | `apps/api/src/modules/copilot/ai-full-rights.test.ts`                           | Exists                 |
| Manage, billing and DELETE ops always on a card                                                                                                                            | `apps/api/src/modules/copilot/ai-preview.test.ts` (sweep over `OPS`)            | Exists                 |
| A member without the capability is refused, nothing sent                                                                                                                   | `ai-full-rights.test.ts`, `ai-actions/registry/parity-2026-11-23.test.ts`       | Exists                 |
| Every `PlatformAdminGuard` route is a `platform.*` op (permission mirrored) or NEVER with `platform_step_up`/`platform_binary_transport`; `platform_admin` count is 0 (F7) | `ai-actions/registry/registry-sync.test.ts`                                     | Exists                 |
| Every platform read is `read`; every platform change is `confirm`/`manage`, never money or hr; the F5 set is `freshReauth` and gets the `step_up` card                     | `ai-actions/registry/platform-admin-ai.test.ts`                                 | Exists                 |
| Every platform read is untrusted (F6)                                                                                                                                      | `platform-admin-ai.test.ts`                                                     | Exists                 |
| No platform op takes a step-up binding, grant or session id as an argument (F2/F3)                                                                                         | `platform-admin-ai.test.ts` (strict schemas)                                    | Exists                 |
| A non-admin or a PAT sees, describes, finds and runs no platform op; nothing is sent (F2)                                                                                  | `platform-admin-ai.test.ts`, `mcp/platform-ai-binding.test.ts`                  | Exists                 |
| A grant without binding or a PAT: 404; no live step-up, an ended session or a past window: 403 `reauthentication_required`; `me` is not exempt for a grant                 | `platform-admin/platform-admin.guard.test.ts`                                   | Exists                 |
| The external platform scope is off by default, admins only, needs a fresh step-up and two-step, and ends at `PLATFORM_AI_SCOPE_MINUTES` (F1/F11)                           | `oauth/consent.test.ts`, `mcp/platform-ai-binding.test.ts`                      | Exists                 |
| F5: a platform suspension approve without fresh re-auth is refused and runs nothing; an approved one runs bound to the approving session with the pending action id        | `mcp/pending-actions-platform.test.ts`                                          | Exists                 |
| Platform proposals are capped at 30 per person and client per hour                                                                                                         | `mcp/pending-actions-platform.test.ts`                                          | Exists                 |
| The card names the target and shows permission, reason and second admin (F9)                                                                                               | `pending-actions-platform.test.ts`, `platform-admin-ai.test.ts`                 | Exists                 |
| The platform audit row records the AI client and pending action (F10)                                                                                                      | `platform-admin/platform-audit.service.test.ts`                                 | Exists                 |
| One admin's AI cannot both request and approve a two-person action                                                                                                         | `platform-admin/governance/governance.service.test.ts`                          | Exists                 |
| Routes a bound token reaches outside a tenant = allowlist + platform routes, nothing else (F4)                                                                             | `platform-admin-ai.test.ts`, `common/http/guards/bound-token-allowlist.test.ts` | Exists                 |
| An AI grant acting inside a support visit (F8 option a)                                                                                                                    | —                                                                               | To build (later batch) |
