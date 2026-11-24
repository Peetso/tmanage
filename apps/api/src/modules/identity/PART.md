---
part: api/identity
kind: api-module
context: identity-and-access
owner: implementation-lead
lifecycle: production
depends_on:
  [
    api-common/database,
    api-common/http,
    api/audit,
    api/sso,
    api/personal-access-tokens,
    api/public-site,
    package/config,
    package/mail,
  ]
provides_api:
  [
    '/v1/auth/*',
    '/v1/sessions/*',
    '/v1/me/sessions/*',
    '/v1/password-resets/*',
    '/v1/email-confirmations/*',
    '/v1/organizations/:orgSlug/admin/sessions/*',
    '/v1/organizations/:orgSlug/security/sign-in-policy',
    '/v1/dev/sessions (non-production only)',
    '/v1/platform/security/network-access/*',
  ]
consumes_api: []
tables_owned:
  [
    users,
    sessions,
    session_refresh_tokens,
    user_passwords,
    user_mfa_factors,
    user_recovery_codes,
    user_mfa_email_codes,
    user_passkeys,
    authentication_events,
    credential_change_notices,
    password_reset_tokens,
    email_confirmation_reminders,
    ip_lookups,
    network_block_lists,
    network_block_ranges,
    network_access_allowlist,
    network_access_blocklist,
  ]
rules:
  [
    SE-1,
    SE-2,
    SE-3,
    SE-4,
    SE-5,
    SE-6,
    AR-5,
    AR-6,
    AR-7,
    AR-8,
    AR-9,
    AR-10,
    AR-12,
    HT-1,
    HT-3,
    HT-4,
    DA-1,
    DA-3,
    DA-10,
    DA-12,
    AS-1,
    AS-2,
    ST-1,
    ST-8,
    RT-2,
    QM-2,
    PR-1,
    PR-3,
  ]
ux_rules: []
last_verified_commit: 61717279d7628572badf37ec0f532b2b45221a64
last_verified_date: 2026-11-22
last_verified_by: Claude Opus 5.5 (lane SEC-TRACKER-API)
---

# api/identity

Read this before changing any file under `apps/api/src/modules/identity/**`. Rule IDs refer to
`docs/architecture/ENGINEERING-STANDARD.md` (AR, HT, DA, AS, ST, RT, SE, PR, QM),
`IMPLEMENTATION-PATTERNS.md` (IP) and `UI-UX-DESIGN-STANDARD.md` (UX). Every `file:line` was
checked at `3b7e4fa7`. Paths are relative to this folder unless they start with `apps/`, `e2e/`,
`packages/` or `docs/`.

## Purpose and bounded context

**What it is for.** Identity answers three questions for the whole product, and is the **single
owner** of each (AR-8, SE-2, SE-3):

1. _Who is this?_ — password sign-in, second step (TOTP, e-mail code, recovery code, passkey),
   session issue, refresh rotation, sign-out, revocation.
2. _Is this credential still valid right now?_ — access cookie + refresh rotation with reuse
   detection, idle limit, absolute deadline.
3. _Must this person prove it again?_ — re-authentication / step-up (`x-reauth-token`) and the
   decision whether that needs an authenticator code (`reauthentication-code.ts:14-27`).

It also owns credential self-service (password set/reset, factor enrolment, recovery codes,
passkeys), the device/session list, the organisation's sign-in policy routes, and IP intelligence
for session security (`geo/`).

**Who uses it.** Every browser screen (through the web session check, part `web-shared/session`),
`apps/server/platform-gate.mjs`, the desktop app and the MCP server (bearer credentials,
`bearer-credentials.ts`), platform-admin (`platform-admin.service.ts:168` asks identity for the
step-up decision).

**Context map (VIEWS §4).** Identity & Access is a **shared kernel** with Tenancy, Audit and
Platform (outbox): every other context is downstream of it (session). Relations:

| Direction | Partner | How | Evidence |
| --- | --- | --- | --- |
| upstream of | all modules | `SESSION_SERVICE`, `AUTHENTICATION_SERVICE` tokens, `SessionAuthGuard` | `identity.module.ts:64-78`, `apps/api/src/app.module.ts:1265` |
| downstream of | tenancy (memberships, org policies) | **raw SQL on tenancy tables** (AR-5/AR-7 breach, §11) | `sign-in-policy.repository.ts:45,63,71,99,116,124` |
| downstream of | sso | `SsoEnforcedSignInPolicyGate` | `identity.module.ts:51` |
| downstream of | personal-access-tokens | PAT authenticator for bearer callers | `identity.module.ts:11` |
| downstream of | public-site | reuses `CONTACT_MAX_PER_WINDOW` for the reset admission | `identity.module.ts:37` |
| publisher to | worker | `credential_change_notices` queue → `apps/worker/src/consumers/credential-change-mail.ts` | §6 |

## Domain model and invariants

**Entities.** `User` (`users`), `Session` (`sessions`: id, user, absolute `expires_at`,
`revoked_at`, `revoked_reason`, `idle_limit_minutes`, IP stamps), `RefreshToken`
(`session_refresh_tokens`, hash ledger for reuse detection), `Password` (`user_passwords`, Argon2id
PHC string, `password.ts:30,97`), `MfaFactor` (`user_mfa_factors`, kind TOTP/e-mail,
`confirmedAt`, `isDefault`, encrypted seed via `seed-cipher.ts`), `RecoveryCode`, `MfaEmailCode`,
`Passkey` (`user_passkeys`), `AuthenticationEvent` (append log used for lockout and the security
activity), `CredentialChangeNotice` (mail queue).

**Value objects / tokens (all short-lived, signed or hashed):** access cookie (TTL
`SESSION_TTL_SECONDS` default 900, `packages/config/src/env.ts:342`), refresh token (absolute
lifetime `REFRESH_TTL_SECONDS` default 1,209,600 s = 14 days, `env.ts:343`), challenge token
(`CHALLENGE_TTL_SECONDS = 600`, `challenge-token.ts:52`), re-auth token (`REAUTH_TTL_SECONDS = 300`,
`reauth-token.ts:40`), e-mail code (`EMAIL_CODE_TTL_SECONDS = 600`, resend gap 30 s,
`email-code.ts:19,23`).

**Sign-in state machine.** `POST /v1/auth/password` → `authenticated` (EstablishedView) or
`mfa_required` (ChallengeResponseView with `challengeToken` + offered factors,
`authentication.controller.ts:163-178`) → `POST /v1/auth/mfa` | `mfa/email-code` |
`recovery-code` | `passkey` → `authenticated`.

**Refresh state machine** (`session.service.ts:398-453`, one `identityTransaction`): live token →
revoked? `session_revoked` · expired? `session_expired` · CSRF bad? `csrf_failed` · idle beyond
limit? revoke + `idle_timeout` · else rotate (or `rotation_lost`). Not live but in the superseded
ledger → revoke the whole session, `reuse_detected`. Otherwise `unknown_token`.

**Invariants (checkable)**

| # | Invariant | Where enforced | Proof |
| --- | --- | --- | --- |
| I-1 | A refresh refusal of any kind answers **401** and clears the cookies; a DB/infra error is **not** converted to 401 (it propagates as 5xx). | `session.controller.ts:130-138` (only `RefreshRejectedError` is mapped) | `apps/api/test/sessions.db.test.ts`, `session-token.test.ts` |
| I-2 | A replayed (rotated-away) refresh token revokes the session. | `session.service.ts:445-450` | `apps/api/test/sessions.db.test.ts` |
| I-3 | CSRF on refresh is checked after token lookup and **before** rotation commits (ADR-0004). | `session.service.ts:412-414` | `session-recovery.test.ts` (web), `apps/api/test/id-002-auth-http.db.test.ts` |
| I-4 | A session idle longer than its stamped limit is revoked on its next refresh, in the same transaction. No limit stamped → never idle. | `session.service.ts:74-82,418-424` | `apps/api/src/common/http/guards/r3-idle-signout.test.ts:29,46` |
| I-5 | Re-authentication requires an authenticator code **iff** the person has a confirmed TOTP factor; the same function feeds the enforcement and every read that tells a screen. | `reauthentication-code.ts:14-27`; enforce `authentication.service.ts:1128`; expose `authentication.controller.ts:753`, `authentication.service.ts:1774-1782` → `platform-admin.service.ts:168` | `reauthentication-code.test.ts`, `authentication.enrolment-reauth.test.ts` |
| I-6 | The development sign-in route does not exist in production (not registered, so 404 like any path). | `identity.module.ts:53-66` comment + conditional controller list | `apps/api/test/http-pipeline.db.test.ts` |
| I-7 | Passwords: min 15, max 256 from `PASSWORD_POLICY` (`@tmanage/domain`; NIST SP 800-63B-4 §3.1.1.2: 15 when the password may be the only factor), code points after NFKC, no composition rules, Argon2id. Sign-in never checks length. | `password.ts:89-90`, `packages/domain/src/security/password-policy.ts` | `password.test.ts`, `password-policy.test.ts` |
| I-8 | Refresh token, recovery code, passkey credential and reset token are stored as hashes with a UNIQUE key. | `0003_session_rotation.sql:70`, `0004_credentials.sql:146`, `0329_user_passkeys.sql:44`, `0204_password_reset_tokens.sql:32` | `sessions.db.test.ts`, `recovery-codes.test.ts`, `acc-02-password-reset.db.test.ts` |
| I-9 | Source-based abuse control is asked **before** the user read, Argon2 and the event row; refusals charge only the refusing key. | `sign-in-abuse-control.ts:8-60,470` | `sign-in-abuse-control.test.ts` |
| I-10 | `GET /v1/sessions/current` names the person only (email, displayName) — never an id or token. | `session.controller.ts:169-185`, `session.service.ts:233-235` | contract `e2e/contracts/api-web-shapes.ts:2983` |

## Public API and contracts

All routes are behind the global guard chain (§5). Status codes follow HT-1: 401 only for missing
or invalid credentials, 403 refusal, 404 hidden, 409 conflict, 429 rate limit.

| Method path | Guard marks | Success | Notable failures | File:line |
| --- | --- | --- | --- | --- |
| POST `/v1/auth/password` | `@Public` | 200 (`authenticated` or `mfa_required`; 200 not 201 by design, `:214-221`) | 401 bad credentials, 429 abuse control | `authentication.controller.ts:219-221` |
| POST `/v1/auth/mfa` | `@Public` | 200 | 401 | `:319-321` |
| POST `/v1/auth/mfa/email-code` | `@Public` | 200 | 429 resend gap | `:345-347` |
| POST `/v1/auth/recovery-code` | `@Public` | 200 | 401 | `:368-370` |
| POST `/v1/auth/reauth` | `@NoTenant` + session | 200 (re-auth token) | 401 | `:514-516` |
| POST `/v1/auth/password/set` | `@NoTenant` + reauth | 204 | 400/401 | `:573-575` |
| POST `/v1/auth/factors/totp` · `/confirm` | `@NoTenant` + reauth | 201 · 200 | 409 | `:638-640`, `:675-677` |
| GET `/v1/auth/factors` | `@NoTenant` | 200 `FactorsView` incl. **`reauthNeedsAuthenticatorCode`** (required field) | — | `:720-756`, view `:187-197` |
| POST `/v1/auth/factors/email` · `/confirm` | `@NoTenant` + reauth | 201 · 200 | 409 not verified / already on, 429 | `:762-764`, `:797-799` |
| POST `/v1/auth/factors/:id/default` | `@NoTenant` | 204 | 404 | `:842-844` |
| GET `/v1/auth/security-activity` | `@NoTenant` | 200 | — | `:879` |
| DELETE `/v1/auth/factors/:id` | `@NoTenant` + reauth | 204 | 404 | `:901-903` |
| POST `/v1/auth/recovery-codes` | `@NoTenant` + reauth | 200 | — | `:929-931` |
| GET/POST/DELETE `/v1/auth/passkeys…`, GET `security-score`, `security-devices` | session | 200/201/204 | 404 | `passkeys/passkeys.controller.ts:134-233` |
| POST `/v1/auth/passkey/options`, POST `/v1/auth/passkey` | public sign-in | 200 | 401 | `passkeys/passkeys.controller.ts:280-290` |
| POST `/v1/sessions/refresh` | `@Public` (refresh cookie, `SameSite=Strict`, path-scoped) | 200 `{csrfToken, expiresAt}` | **401 `unauthenticated` + cleared cookies** for every `RefreshRejectedError` | `session.controller.ts:105-139` |
| DELETE `/v1/sessions/current` | `@NoTenant` | 204, idempotent | — | `:143-160` |
| GET `/v1/sessions/current` | `@NoTenant` | 200 `{account:{email,displayName}}` | 401 | `:169-185` |
| GET `/v1/sessions/current/devices` | `@NoTenant` | 200 | — | `:187` |
| DELETE `/v1/sessions` · `/v1/sessions/:id` | `@NoTenant` | 204 | 404 | `:227-229`, `:257-259` |
| GET `/v1/me/sessions/:id/trail.csv` | `@NoTenant` | 200 CSV | 404 | `:347-356` |
| POST `/v1/dev/sessions` | `@Public`, **not registered in production** | 201 | — | `:387-393` |
| POST `/v1/password-resets` · `/completions` | `@Public @NoTenant` | 202 · 204 | 400 | `password-reset.controller.ts:65-84` |
| POST `/v1/email-confirmations` · `/completions` | public | 202 · 204 | 400 | `email-confirmation.controller.ts:43-63` |
| GET `/v1/organizations/:slug/admin/sessions`, GET `…/:id/trail.csv`, POST `…/:id/revoke` | `org.manage` | 200 | 403/404 | `admin-sessions.controller.ts:88-126` |
| GET/PUT `/v1/organizations/:slug/security/sign-in-policy` | `org.security.manage` (PUT also reads the session) | 200 | 403 | `sign-in-policy.controller.ts:37-52` |

**Contracts (AR-10).** `e2e/contracts/api-web-shapes.ts` pairs `CurrentSessionView` (`:2983`),
`FactorsView` (`:3062`), `EstablishedSessionView` (`:111`), `SessionAccountView` (`:297`),
`ActiveSessionView` (`:493`) with the web types in `apps/web/src/lib/api/session.ts` /
`auth.ts` / `admin-sessions.ts` using `Assert<Exact<…>>`.

**Exported services.** `SESSION_SERVICE` (`SessionService`), `AUTHENTICATION_SERVICE`,
`PASSWORD_RESET_SERVICE`, `EMAIL_CONFIRMATION_SERVICE`, `SIGN_IN_POLICY_SERVICE`, `IP_INTELLIGENCE`
(`identity.module.ts:22-51`). Pure exports other modules may import: `reauthenticationNeedsAuthenticatorCode`,
`PASSWORD_MIN_LENGTH`/`MAX` (`password.ts:89-90`, aliases of `PASSWORD_POLICY`).

**Events.** No outbox events published. Credential-change mails go through the
`credential_change_notices` table (declared on every identity unit of work,
`authentication.service.ts:141-153`), consumed by `apps/worker/src/consumers/credential-change-mail.ts`.

## Data: tables and migrations

| Table | Created | Later changes | Keys that matter | Retention |
| --- | --- | --- | --- | --- |
| `users` | `0001_tenancy.sql` | `0247_users_disabled_two_step.sql` | PK id; `uq_users_email` | account lifetime; erasure via privacy |
| `sessions` | `0001_tenancy.sql` | `0003_session_rotation.sql`, `0247`, `0271_session_idle_limit.sql:15` (`idle_limit_minutes SMALLINT UNSIGNED NULL`), `0280_security_ip_intelligence.sql` (IP stamps) | `uq_sessions_refresh_token_hash`, `ix_sessions_user_expiry` | expired rows: **no purge found in this module** (ST-6, §11) |
| `session_refresh_tokens` | `0003_session_rotation.sql` | — | `uq_session_refresh_tokens_hash (token_hash)` (`:70`) | grows with every rotation (ST-6) |
| `user_passwords`, `user_mfa_factors`, `user_recovery_codes`, `authentication_events` | `0004_credentials.sql` | — | `uq_user_recovery_codes_hash` (`:146`) | `authentication_events`: append log, used for lockout window |
| `credential_change_notices` | `0020_credential_change_notices.sql` | — | — | delivered by worker |
| `password_reset_tokens` | `0204_password_reset_tokens.sql` | — | `uq_password_reset_tokens_hash` (`:32`) | short TTL |
| `email_confirmation_reminders` | `0416_email_confirmation_reminders.sql` | — | PK `(user_id, reminder_day)`: the claim that stops a second send | three rows per person at most; erased with the account |
| `user_passkeys` | `0329_user_passkeys.sql` | — | `uq_user_passkeys_credential (credential_id_hash)` (`:44`) | until removed |
| `user_mfa_email_codes` | `0360_mfa_email_codes.sql` | — | PK id (`:42`) | TTL 10 min |
| `ip_lookups` | `0280_security_ip_intelligence.sql` | — | — | cache, swept by `apps/worker/.../ip-lookup-sweeper-store.ts` |
| `network_block_lists`, `network_block_ranges`, `network_access_allowlist` | `0405_network_access_policy.sql` | — | PK `(list_key, version, range_start)`; `uq_network_access_allowlist_value` | ranges: old versions deleted by the worker refresh; allowlist until removed |
| `network_access_blocklist` | `0406_network_access_blocklist_and_source_labels.sql` | — | `uq_network_access_blocklist_value (value)` | until a platform admin removes it |

**Read but not owned** (owner = tenancy): `org_policies`, `memberships`, `client_memberships`;
(owner = google-auth/sso): `user_identities` — all from `sign-in-policy.repository.ts`.

**Expand/contract.** All changes listed are additive (nullable columns, new tables), so DA-6 holds.
Grants for every table above must be in `scripts/db/users.sql` (DA-9; checked by
`apps/api/src/common/database/grants.test.ts`).

## Permissions and tenant rules

**Guard chain** (SE-1), registered globally in order at `apps/api/src/app.module.ts:1264-1270`:
`DurableThrottleGuard → SessionAuthGuard → CsrfGuard → TenantContextGuard → TwoStepRequirementGuard
→ CapabilityGuard`. Identity routes are mostly `@NoTenant` (they act on the person, not a
workspace): tenant scope does not apply and the user id **always comes from `@CurrentSession()`**,
never the body (DA-12 spirit).

| Decision | Single owner | Consumers |
| --- | --- | --- |
| Session valid? | `SessionService.refresh` / `SessionAuthGuard` | web `lib/session-check.ts`, `apps/server/platform-gate.mjs` |
| Re-auth needs TOTP code? | `reauthentication-code.ts:23-27` | `authentication.controller.ts:753`, `platform-admin.service.ts:168` → web `platform-kit.tsx:173`, `TwoStepSignInScreen.tsx:208` |
| Step-up for sensitive changes | `x-reauth-token` header (D05) issued by `POST /v1/auth/reauth`, TTL 300 s | factor, password, recovery-code routes |
| Org sign-in policy | `SignInPolicyService` (+ SSO enforcement gate) | `sign-in-policy.controller.ts:38,47` (`org.security.manage`) |
| Admin session revoke | `AdminSessionsService` | `org.manage` (`admin-sessions.controller.ts:89,106,127`) |
| Password policy | `PASSWORD_POLICY` in `@tmanage/domain`, read by `password.ts` and every web form (`363cdfac`) | one decision (AR-8) |

Trust zones: identity serves both staff and client principals; it does **not** today return an
audience (staff | client) on `GET /v1/sessions/current` (`session.service.ts:233-235`), see DC-6 §11.

## Runtime, background work and failure modes

**Owned background work.** Credential-change mail (`apps/worker/src/consumers/credential-change-mail.ts`
reading `credential_change_notices`); IP lookup sweep (`apps/worker/src/common/database/ip-lookup-sweeper-store.ts`);
Tor exit list refresh (in-process timer, `geo/tor-exit-list.ts:10-22`). RESENDVERIFY: the hourly
"Confirm your e-mail" reminders, 1/3/7 days after a password sign-up (in-process under
`WORKER_INPROCESS=1`, `email-confirmation-reminders.ts`; claim-before-send on
`email_confirmation_reminders`, AS-2; stopped by the platform "Tips and reminders" switch).

| Failure | Behaviour today | Pattern / rule | Verdict |
| --- | --- | --- | --- |
| DB down during refresh | not a `RefreshRejectedError` → propagates as 5xx; web treats as `unknown` | HT-1, HT-3, SE-2 | correct |
| DB error in automation signal | `.catch(() => 0)` treats "count failed" as "no recent attempts" (`authentication.controller.ts:299-304`) | HT-3 | advisory score only; acceptable, but log it (§11) |
| Two processes (DC-3) | per-user lockout counts DB rows (`authentication.service.ts:630,850`) → shared. **Source abuse control, e-mail send budget and the reset admission are in-memory** (`rate-limiter.ts:82` `new Map`, `identity.module.ts:108,121,177`) → limits multiply by instance count | RT-2 | gap (P2): document as "per instance, harmless when duplicated" or move to `DurableThrottleGuard` storage |
| Tor list fetch hangs | `fetch(target)` with **no timeout** (`geo/tor-exit-list.ts:16`) | ST-1 | gap (P1) |
| Mailer down | notices queued in DB, worker retries | AS-1, AS-6 | correct pattern (own queue table, not `outbox_events`) |
| Concurrent refresh in two tabs | web coalesces + cross-tab lock; server rotation conditional (`rotation_lost`) | DA-1 (lost update → conditional rotate) | correct; lost tab gets 401 only if its token was rotated away → **reuse revocation** risk is mitigated by the web lock only |
| Shed load | anonymous throttle first in the chain | ST-8 | correct |

## UX rules for its screens

n/a — API module; its screens (sign-in, two-step, security, sessions) are owned by the web parts
(`apps/web/src/app/sign-in`, auth group) and `web-shared/session`. The API's obligation to them is
AR-9: every decision a screen needs is a **required** field (`reauthNeedsAuthenticatorCode`,
`stepUpNeedsAuthenticatorCode`), never a fact to re-derive.

## Standards that apply

| Rule | Today | Target |
| --- | --- | --- |
| SE-1 guard chain | order matches at `app.module.ts:1264-1270` | keep; route census includes every identity route |
| SE-2 tri-state session, one owner | API side correct: only `RefreshRejectedError` → 401 (`session.controller.ts:130-138`) | add `audience` to the session answer (DC-6) |
| SE-3 step-up decided in identity | decision in `reauthentication-code.ts`, exposed as required field | factors offered should also include e-mail code + send (SE-3 text); today only TOTP yes/no |
| SE-4 lifetimes vs NIST 800-63B-4 §5.2 (AAL2: overall ≤ 24 h, inactivity ≤ 1 h) | absolute 14 days (`env.ts:343`); inactivity only if an org sets a limit (`0271`, nullable) | **ADR required** stating the deviation (none in `docs/adr/`), or defaults that meet AAL2; config test (FITNESS-FUNCTIONS SE-4) |
| SE-5 CSRF signed double submit | refresh verifies inside the tx (`session.service.ts:412-414`) per ADR-0004 | keep |
| SE-6 STRIDE row per boundary | passkey, e-mail code, SSO gate rows: not verified here | add rows in `docs/security/threat-model.md` before new factors |
| AR-5 / AR-7 contexts via services | **breach**: raw SQL on tenancy tables `sign-in-policy.repository.ts:45-124` | tenancy publishes a membership/policy read service; identity calls it |
| AR-6 controllers import services only | **breach**: `authentication.controller.ts:38,299-304` calls `countRecentAttemptsByIp` with a DB handle; `passkeys.controller.ts:32,345` builds a repository (composition-root use) | move the count into `AuthenticationService`; move wiring into `identity.module.ts` |
| AR-8 one decision one place | re-auth rule shared; password policy shared from `@tmanage/domain` (`363cdfac`) | AR-8 lint on `MIN_PASSWORD` / `PASSWORD_MIN` identifiers in `apps/web` (not built yet) |
| AR-9 decisions required, never defaulted | API side required; web defaults `?? false` (`PreferencesScreen.tsx:562`, `SignInSecurityScreen.tsx:329`) | fix in web; AR-9 lint |
| AR-10 paired shapes | `Assert<Exact>` pairs present (§3) | keep for every new view |
| AR-12 exact types | no `any` found in non-test files (grep) | keep |
| HT-1 statuses | 200/201/202/204 chosen deliberately; 401 only for credentials | keep |
| HT-3 no silent collapse | one advisory `.catch(() => 0)` (§6) | log at warn |
| HT-4 idempotency | sign-out idempotent (`:142`); TOTP/e-mail enrolment 409 on repeat | keep |
| DA-1 anomaly named | refresh: conditional rotate (`rotation_lost`) prevents lost update | keep |
| DA-3 bound params | repositories use bound params / Drizzle | keep |
| DA-10 UTC, bound dates | idle = `timestampdiff(second, coalesce(rotated_at, created_at), now(3))` (`sessions.repository.ts:112`): correct only if the identity pool session time zone is UTC | assert the pool `time_zone` in a db test |
| AS-1 / AS-2 side effects | credential mail via DB queue + worker | dedupe key on notices: not verified (P2) |
| ST-1 timeouts | Tor fetch has none | `AbortSignal.timeout` |
| ST-8 shed load first | throttle guard first | keep |
| RT-2 per-instance state | in-memory limiters (§6) | DB-backed or declared harmless |
| QM-2 priority | security first: unknown-email Argon2 verify kept for flat timing (`sign-in-abuse-control.ts:16-18`) | keep |

## How to change this part

- **New auth route:** controller method in the matching `*.controller.ts`; mark `@Public()` only for
  pre-session flows and `@NoTenant()` for person-scoped flows; logic in the service, SQL in a
  `*.repository.ts` (AR-4, AR-6). Add the route to the route census and permission map in the same
  commit (SE-1); add the API/web pair to `e2e/contracts/api-web-shapes.ts` (AR-10).
- **New decision a screen needs** (e.g. "needs e-mail code"): a pure function next to
  `reauthentication-code.ts`, used by both the enforcing service and the read view, returned as a
  **required** field (AR-8, AR-9). Never ship the raw fact alone.
- **New table/column:** forward-only, MariaDB-safe migration in `apps/api/migrations/` (DA-4, DA-5),
  additive first (DA-6); add to the right `IDENTITY_TABLES` list (`authentication.service.ts:141`,
  `session.service.ts:60`) and grant in `scripts/db/users.sql` (DA-9).
- **New mail side effect:** write a notice row in the same transaction; worker consumer delivers (AS-1).
- **New factor kind:** STRIDE row first (SE-6); update `reauthenticationCodeFactors` deliberately.
- Checks before commit: `pnpm --filter @tmanage/api typecheck` (it includes `test/`), the module's
  unit tests, then the db suites listed in §10.

## Tests and fitness checks

- Unit (co-located): `password.test.ts`, `totp.test.ts`, `session-token.test.ts`,
  `challenge-token.test.ts`, `reauth-token.test.ts`, `reauthentication-code.test.ts`,
  `recovery-codes.test.ts`, `email-code.test.ts`, `sign-in-abuse-control.test.ts`,
  `sign-in-policy.service.test.ts`, `authentication.*.test.ts` (account-disabled, automation,
  credential-change-record, email-code, enrolment-reauth, session-revoke),
  `session-revoke.controller.test.ts`, `session.controller.support-signout.test.ts`,
  `sessions.ip-stamping.test.ts`, `password-reset.service.test.ts`, `seed-cipher.test.ts`,
  `passkeys/webauthn.test.ts`, `geo/*.test.ts`.
- DB (`apps/api/test`): `sessions.db.test.ts`, `id-002-auth-http.db.test.ts`,
  `id-002-session-revoke.db.test.ts`, `http-pipeline.db.test.ts` (dev route absent in production),
  `acc-02-password-reset.db.test.ts`, `plat-012-support-session.db.test.ts`.
- E2E: `e2e/tests/session-journeys.spec.ts` (D01 cross-tab sign-out `:86`, D04 refresh `:140`,
  D04 refused refresh `:182`, E2 signed-in `/sign-in` `:209`).
- Contract: `e2e/contracts/api-web-shapes.ts` (`:2983`, `:3062`).
- Fitness (FITNESS-FUNCTIONS): SE-1 route/permission census; SE-3 `reauthentication-code.test.ts`
  (exists) + e2e "no TOTP → no code field" (to build); SE-4 lifetime config test (to build); SE-5
  `common/http/csrf.test.ts`.
- Idle limit: `apps/api/src/common/http/guards/r3-idle-signout.test.ts`.
- **Missing:** an AR-6 import check for controllers; a db test that the idle revoke commits with the refusal.

## Open defects, decisions and risks

| Id | Class | Finding (verified at 3b7e4fa7) | Pri | Exit |
| --- | --- | --- | --- | --- |
| ID-1 | DC-2 | **Fixed `363cdfac`:** one `PASSWORD_POLICY` (15 / 256) in `@tmanage/domain`; web literals 12 and 8 removed; copy uses `{min}` in all 8 catalogs | closed | — |
| ID-2 | DC-2 / AR-9 | `?? false` on `reauthNeedsAuthenticatorCode` remains at `PreferencesScreen.tsx:562`, `SignInSecurityScreen.tsx:329` (web side of this decision) | P0 | render pending/unknown until loaded |
| ID-3 | DC-6 | `CurrentSessionView` has no `audience` (`session.service.ts:233-235`); layouts cannot branch on staff vs client from the server answer | P1 | add required `audience: 'staff' \| 'client'` |
| ID-4 | AR-5/AR-7 | `sign-in-policy.repository.ts:45-124` reads `org_policies`, `memberships`, `client_memberships`, `user_identities` directly | P1 | tenancy read service |
| ID-5 | AR-6 | controller-level DB read `authentication.controller.ts:299-304` | P2 | move into service |
| ID-6 | SE-4 | 14-day absolute session, no default inactivity limit, no ADR | P1 | ADR or AAL2 defaults + config test |
| ID-7 | ST-1 | Tor exit list `fetch` without timeout (`geo/tor-exit-list.ts:16`) | P1 | `AbortSignal.timeout` |
| ID-8 | RT-2 / DC-3 | in-memory abuse/send/reset limiters per instance | P2 | DB-backed or documented |
| ID-9 | ST-6 | no purge of expired `sessions` / `session_refresh_tokens` found in this module | P2 | add to purge sweep (owner: identity) |
| ID-10 | doc | `reauth-token.ts:39` comment says "the CHALLENGE_TTL_SECONDS convention" (5 min) while `CHALLENGE_TTL_SECONDS = 600` (`challenge-token.ts:52`) | P2 | correct the comment |

ADRs: ADR-0004 (CSRF), ADR-0009 (tri-state session, **Proposed**), ADR-0010 (overlapping instances).

## Glossary

| Term | Meaning |
| --- | --- |
| Step-up / re-authentication | proving identity again before a sensitive change; yields `x-reauth-token` |
| Second step / two-step sign-in | TOTP, e-mail code, recovery code or passkey after the password |
| Reuse detection | a rotated-away refresh token presented again → session revoked |
| Idle limit | company's "sign out after inactivity", stamped on the session |
