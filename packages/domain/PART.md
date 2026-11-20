---
part: package/domain
kind: package
context: shared-kernel
owner: implementation-lead
lifecycle: production
depends_on: []
provides_api: []
consumes_api: []
tables_owned: []
rules: [AR-1, AR-8, AR-9, AR-11, AR-12, DA-10, AS-2, QM-2, PR-1]
ux_rules: [UX-15]
last_verified_commit: 954d80b32e5fbe6379a1c4e71bb45a616aa9ce65
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane G)
---

# package/domain

## Purpose and bounded context

`@tmanage/domain` is the **inner ring** (Clean Architecture dependency rule, AR-1): pure value objects, policies and state machines that the API, the worker and the web all import, so that a business or security rule is decided **once** (AR-8). It holds no I/O, no framework and no other workspace package.

- Context: **shared kernel** (VIEWS §4 "Packages: `packages/domain` (pure policies: shared kernel, inner ring)"). Every bounded context depends on it; it depends on nothing.
- Consumers (non-test files importing `@tmanage/domain`, grep at HEAD): `apps/api/src` 1,012, `apps/web/src` 103, `apps/worker/src` 60; `apps/server` and `apps/mcp-server` 0.
- Entry points (`package.json` `exports`): `.` (`dist/index.js`, 68 `export *`/`export {}` lines in `src/index.ts`), plus server-only subpaths `./realtime-ticket`, `./field-cipher`, `./zatca-sign` (use `node:crypto`) and `./contact-addresses`.

## Domain model and invariants

Areas (folders under `src/`): `policies` (capabilities, roles, `authorize`, effective permissions, client ceiling, audience, audit catalogue, automation conditions/flows, platform permissions), `state-machines` (approval, client-request, deliverable, invitation, offboarding, upload, work-item on a generic `StateMachine`), `money` (minor units, invoicing, rates, burn, profitability), `finance` (tax document rules, ZATCA TLV/UBL/sign, accounting exports), `security` (sign-in policy, two-step scope, incident clocks, public-link manager, field cipher), `events` (outbox event catalogue), `signals` (work signals engine), `calendar`, `schedule` (critical path, dependencies, recurrence), `time`, `notifications` (quiet hours, routing), `flags`, `value-objects` (uuid-v7, slug, rich text, content hash), `i18n` (`glossary.json`, country locale), `legal`, `import`, `export`, `quick-add`, `realtime`, `growth`, `work`.

| # | Invariant (checkable) | Where | Proof |
| --- | --- | --- | --- |
| DM-1 | The package imports no driver, framework or `@tmanage/*` package. | ESLint `no-restricted-imports` for `packages/domain/**` (`eslint.config.js:72-100`) | `pnpm lint`; `package.json` has only `devDependencies` (typescript, vitest) |
| DM-2 | Server-only modules (`node:crypto`) never reach the browser entry. | subpath exports; ESLint ban for web on `@tmanage/domain/{field-cipher,realtime-ticket,zatca-sign}` (`eslint.config.js:185-195`) | `src/client-safe-entry.test.ts:59` (walks the `.` entry for `node:`/builtins, `:46`) |
| DM-3 | `authorize()` is deny-by-default and total: every path returns `{allowed:true}` or `{allowed:false, code, detail}`; the tenant check runs before object reasoning. | `policies/authorize.ts:196-203` (decision type), `:257` (`authorize`), `:269` (tenant first) | `policies/authorize.test.ts:72,102,131,362,388,410` |
| DM-4 | Organization policy narrows a role's ceiling, never widens it. | `policies/authorize.ts` | `authorize.test.ts:362` |
| DM-5 | A client principal never holds an internal-only capability. | `policies/client-ceiling.ts:15` (`CLIENT_CAPABILITY_ALLOWLIST`), `:38` | `client-ceiling.test.ts`; `authorize.test.ts:131` |
| DM-6 | The role vocabulary is closed: `INTERNAL_ROLES` (`policies/capabilities.ts:162`), `CLIENT_ROLES` (`:220`); `platform_support` is never assignable (`ASSIGNABLE_INTERNAL_ROLES` `:190`). | `capabilities.ts:162-198` | `authorize.test.ts:74` (sweeps every role), `platform-permissions.test.ts` |
| DM-7 | Money is an integer in minor units with an ISO 4217 currency; arithmetic in `bigint`; tax rounded half-up per line; unknown currencies refused. | `money/money.ts:1-17`, `:19` (`CURRENCY_DIGITS`), `:74` (`divideHalfUp`), `:82` | `money/money.test.ts`, `invoicing.test.ts` |
| DM-8 | Legal transitions are data: a `StateMachine` returns a `TransitionResult` (`illegal_transition` / `missing_requirement`) and never throws. | `state-machines/state-machine.ts:14-24` | `state-machines/state-machines.test.ts` |
| DM-9 | Every outbox event type is in one catalogue with its aggregate type. | `events/outbox.ts:42` (`OUTBOX_EVENT_CATALOG`), `:368-370` | `events/outbox.test.ts` |
| DM-10 | Feature-flag resolution is deterministic per (flag, organization) bucket. | `flags/flag-chain.ts:26-58` | `flags/flag-chain.test.ts` |

Purity note (IP-3): time is passed in as a parameter with a default (`export/project-export.ts:112` `at = new Date()`, `value-objects/uuid-v7.ts:48` `Date.now()` default); `security/field-cipher.ts:207` uses `randomBytes`. These are the only non-pure points found; they are on defaults or on a server-only subpath.

## Public API and contracts

Exported decision functions (selection; the decision's single home under AR-8):

| Decision | Export |
| --- | --- |
| May this principal do X on this object? | `authorize`, `isAuthorized` (`policies/authorize.ts:257,407`), `principalHoldsCapability` (`:101`), `effectiveCapabilitySet` (`:109`), `mayGrantCapability` (`:426`) |
| What can a role do? | `capabilitySetFor` (`policies/capabilities.ts:686`), `CAPABILITIES` (`:19`) |
| A member's effective permissions | `computeEffectivePermissions` (`policies/effective-permissions.ts:101`) |
| Is this content client-visible? | `isClientReadableAudience`, `isVisibilityWidening`, `findForbiddenClientFields` (`policies/audience.ts:38,64,125`) |
| Two-step required for this role? | `twoStepRequiredFor`, `twoStepScopeCovers`, `TWO_STEP_ADMIN_ROLES` (`security/sign-in-policy.ts:167,156,27`) |
| Sign-in method allowed? | `evaluateSignIn`, `parseSignInPolicy`, `validateSignInPolicyPatch` (`sign-in-policy.ts:146,72,103`) |
| Flag on for this org? | `resolveFlagChain` (`flags/flag-chain.ts:58`) |
| Money | `money`, `divideHalfUp`, `currencyDigits` (`money/money.ts:82,74,55`) |

Not HTTP. The API's wire shapes live in `packages/contracts` and `e2e/contracts/api-web-shapes.ts`; this package supplies only the types and pure functions they reference.

## Data: tables and migrations

n/a — reason: the inner ring owns no tables and runs no SQL (DM-1). Catalogues here (outbox event types, audit actions in `policies/audit.ts`, capability strings) are referenced by DB columns elsewhere, for example `membership_permission_overrides.capability` holds one string from `CAPABILITIES` (`apps/api/migrations/0242_membership_permission_overrides.sql`).

## Permissions and tenant rules

This package **is** the permission model: role → capability ceilings, client ceiling, `authorize()` with tenant-first checks, policy-narrows-never-widens. It does not resolve who the caller is; `api/tenancy` builds the `Principal` and the API guards call these functions. The web imports the same matrix for display (`EffectivePermissionsPanel.tsx`, `RoleMatrixEditor.tsx`, `lib/capability-labels.ts`, per ARCH-REVIEW DC-2), which is the allowed AR-8 form.

**Decisions still outside the package (DC-2 class, re-verified at HEAD):**

| Decision | Where it is decided today | Divergence |
| --- | --- | --- |
| Password minimum length | `src/security/password-policy.ts`: `PASSWORD_POLICY = { minLength: 15, maxLength: 256 }` (NIST SP 800-63B-4 §3.1.1.2), `passwordLength`, `passwordTooShort`; read by `apps/api/src/modules/identity/password.ts` and the web forms (`363cdfac`) | one value |
| "Admin roles" set | domain `TWO_STEP_ADMIN_ROLES` (`sign-in-policy.ts:27-31`) and again `apps/api/src/modules/tenancy/org-policy.ts:18`; web `CalendarConnections.tsx:61` `{owner, org_admin, admin}` | web copy wrong (`admin` is not a role) |
| Org-wide default roles | `apps/api/src/modules/tenancy/principal.repository.ts:42` | not shared |
| Billing-granting roles | `apps/api/src/modules/oauth/consent.ts:24` | not shared |

## Runtime, background work and failure modes

n/a — reason: a library of pure functions; it runs inside its callers' processes and has no jobs, connections or outbound calls. Failure mode: a wrong rule here is wrong everywhere at once, which is why changes need the table tests in §10 and, per QM-2, security rules win over convenience.

## UX rules for its screens

n/a — reason: no screens. One UI-facing asset: `src/i18n/glossary.json` is the arc42 §12 glossary source (PART-DOCS §5); UI copy itself lives in the web catalogs (UX-15), not here.

## Standards that apply

| Rule | Today | Target |
| --- | --- | --- |
| AR-1 | Met: lint `eslint.config.js:72-100`; no runtime dependencies. `node:*` builtins are not in the banned list; only 3 server-only files use `node:crypto`. | Add `node:*` (except `node:crypto` on the 3 subpaths) to the ban so the rule is mechanical. |
| AR-8 | Partial: permissions, two-step, money, flags, audience and the password policy live here; several role sets do not (§5). | Named role sets; AR-8 lint on literals. |
| AR-9 | `AuthorizationDecision` is a required, explicit allow/deny (`authorize.ts:196-203`). | Keep; never add an optional decision field. |
| AR-11 | `invitationStateMachine`, `offboardingStateMachine`, `deliverableStateMachine` have 0 importers in `apps/` (grep). | Wire them into the owning services or delete them. |
| AR-12 | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (`tsconfig.base.json:10-12`); 0 `any` and 0 `as unknown as` in non-test source. | Keep. |
| DA-10 | Money in minor units + currency (DM-7); dates passed in. | Keep. |
| AS-2 | Outbox catalogue documents consumer dedupe properties (`events/outbox.ts:527,904`). | Add the dedupe key to each catalogue entry as a typed field. |
| IP-3 | Functional core: met (see purity note). | Keep clocks and randomness as parameters. |
| IP-15 | **Not met:** no property-based tests (no `fast-check` in `src/`). | Properties for `authorize` (deny-by-default, narrowing), `money` (sum of rounded lines), `StateMachine`, `recurrence`. |
| IP-16 | Not run. | Mutation testing on `policies/` and `money/` first (highest blast radius). |

## How to change this part

1. **New rule shared by API and web:** a pure function in the matching folder, exported from `src/index.ts`; table test beside it; the API calls it; the web either imports it (display) or reads the API's decision (enforcement). Never copy the rule.
2. **New capability or role:** `policies/capabilities.ts` (vocabulary + ceilings), then `client-ceiling.ts` if client-visible, then the role-matrix db tests in `apps/api/test/test-001-role-matrix.db.test.ts`.
3. **New state machine:** a definition on `state-machines/state-machine.ts`; the owning service must use it (no unused machines).
4. **Anything needing a secret or `node:crypto`:** its own subpath export in `package.json`, added to the web ban list and to `client-safe-entry.test.ts`.
5. Checks: `pnpm --filter @tmanage/domain typecheck`, `pnpm --filter @tmanage/domain test`, `pnpm lint`; then `typecheck` of api, web and worker (all consume it).

## Tests and fitness checks

- 59 test files beside 100 source files (vitest, `package.json` `test`). Core ones: `policies/authorize.test.ts`, `effective-permissions.test.ts`, `client-ceiling.test.ts`, `custom-role.test.ts`, `platform-permissions.test.ts`, `finance-capabilities.test.ts`, `wave9-s4-client-projection.test.ts`, `state-machines/state-machines.test.ts`, `money/*.test.ts`, `finance/zatca/*.test.ts`, `events/outbox.test.ts`, `flags/flag-chain.test.ts`, `security/sign-in-policy.test.ts`, `client-safe-entry.test.ts`.
- Fitness: ESLint inner-ring ban (`eslint.config.js:72-100`), browser-entry walk (`client-safe-entry.test.ts`). **Missing:** AR-8 literal lint (role sets, password minimum), property tests (IP-15), mutation score (IP-16), unused-export check (AR-11).

## Open defects, decisions and risks

| Id | Class | Finding | Pri | Exit |
| --- | --- | --- | --- | --- |
| DOM-D1 | DC-2 | **Fixed `363cdfac`:** `PASSWORD_POLICY` here (15), used by API and web; test `src/security/password-policy.test.ts`. | closed | — |
| DOM-D2 | DC-2 | Admin-role set duplicated (`sign-in-policy.ts:27`, tenancy `org-policy.ts:18`, web literal wrong). | P1 | One named export; delete the copies. |
| DOM-D3 | AR-11 | Three state machines unused by any app. | P2 | Adopt or delete. |
| DOM-D4 | IP-15 | No property-based tests for the highest-blast-radius rules. | P2 | fast-check suites for authorize and money. |
| DOM-D5 | AR-1 | `node:*` not mechanically banned in the inner ring. | P2 | Extend the lint pattern. |

ADR-0009 (staged) places the shared HTTP-outcome classifier (HT-2) in `packages/contracts`, not here, because it is a wire concern.

## Glossary

| Term | Meaning |
| --- | --- |
| Capability | A named right (`org.manage`, `work.read`, …) from `CAPABILITIES`. |
| Ceiling | The most a role (or a client) can ever hold; policy and overrides only move inside it. |
| Audience | Visibility of content: `internal`, `client_visible`, `client_action_required`. |
| Minor units | Smallest currency unit (halala, fils, cent) stored as an integer. |
| Shared kernel | Model shared by all contexts; changed only with every consumer's tests green. |
