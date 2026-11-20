---
part: web-shared/session
kind: web-shared
context: identity-and-access
owner: implementation-lead
lifecycle: production
depends_on: [api/identity, web-shared/api-client, package/ui]
provides_api: []
consumes_api:
  [
    'GET /v1/sessions/current',
    'POST /v1/sessions/refresh',
    'DELETE /v1/sessions/current',
    'GET /v1/organizations (via workspaceDestination)',
  ]
tables_owned: []
rules:
  [SE-2, HT-2, HT-3, AR-8, AR-9, AR-3, AR-10, AR-12, ST-1, RT-4, PR-1, PR-3, IP-9, IP-10, IP-13]
ux_rules: [UX-3, UX-4, UX-8, UX-9, UX-10, UX-14, UX-15, UX-17, UX-23, UX-24]
last_verified_commit: 954d80b32e5fbe6379a1c4e71bb45a616aa9ce65
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane G)
---

# web-shared/session

Read this before changing `apps/web/src/lib/session-check.ts` or any file in
`apps/web/src/components/session/`. Rule IDs: `docs/architecture/ENGINEERING-STANDARD.md`,
`IMPLEMENTATION-PATTERNS.md` (IP), `UI-UX-DESIGN-STANDARD.md` (UX). All `file:line` checked at
`3b7e4fa7` (AUTHSTATE landed in `db5484b4`, the last commit touching these files). Paths are
relative to `apps/web/src/` unless stated.

## Purpose and bounded context

**What it is for.** This part is the web's **one answer** to "who is signed in here?" (SE-2,
ADR-0009 _Proposed_). It turns the API's answer into a tri-state value and renders the area only
when the answer is _signed-in_. It exists because of **DC-1** (2026-11-20: a valid session was
shown the sign-in form during a deploy restart): "no answer" must never fall into "no".

**Files.**

| File | Role |
| --- | --- |
| `lib/session-check.ts` | pure-ish core: `checkSession`, `isTransientFailure`, `SessionCheck` type |
| `components/session/useSessionCheck.ts` | React hook: `checking` + retry schedule + cross-tab re-check |
| `components/session/SignedInGate.tsx` | gate for every signed-in area |
| `components/session/EntrySessionGate.tsx` | gate for the entry pages (sign-in, sign-up) |
| `components/session/SessionCards.tsx` | the status card (checking / can't reach) and the "You're signed in" card |

**Who uses it.** `SignedInGate`: `app/[orgSlug]/layout.tsx:31`, `app/platform/layout.tsx:18`,
`app/sessions/layout.tsx:20`, `app/organizations/layout.tsx:10`, `app/onboarding/layout.tsx:10`.
`EntrySessionGate`: `app/sign-in/SignInPageClient.tsx:27` (also serves `/ar/sign-in`, which
re-exports the English page), `app/sign-up/page.tsx:30`, `app/ar/sign-up/page.tsx:19`.
`isTransientFailure`: `components/platform/PlatformAccessGate.tsx:9,39` (retry predicate).

**Context map.** Downstream (conformist) of **api/identity**, which owns the session decision.
Upstream partners: `lib/api/client.ts` (refresh + cross-tab lock, `resumeSession` `:270`),
`lib/auth-boundary` (cross-tab notices), `lib/workspace-gate.ts` + `lib/workspace-gate-request.ts`
(server-side cookie hint and 404/sign-in redirects), `apps/server/platform-gate.mjs` (the
Node-side gate for `/platform`, which keeps its **own copy** of the classifier, §11).

## Domain model and invariants

```ts
// lib/session-check.ts:21-24
type SessionCheck =
  { state: 'signed-in'; account: SessionAccount } | { state: 'signed-out' } | { state: 'unknown' };
// components/session/useSessionCheck.ts:15
type SessionView = { state: 'checking' } | SessionCheck;
```

**State machine** (`checkSession`, `session-check.ts:48-62`):

1. No readable CSRF cookie (`mayHaveSession === false`) → `signed-out` without a request (`:52`).
2. Ask `GET /v1/sessions/current` (timeout 10 s, `lib/api/session.ts:95,118`). 200 → `signed-in`;
   401 → step 3; anything else → `unknown` (`:44`).
3. `client.resumeSession()`: `ended` → `signed-out`; `unreachable` → `unknown`; `kept` → ask again;
   a second 401 → `signed-out` (`:56-61`).

Hook (`useSessionCheck.ts:40-66`): starts `checking`; on `unknown` retries after 1, 2, 4, 8, then
every 15 s (`:17-22`, `:53-55`); `retryNow` re-runs at once; a remote auth-boundary notice
(sign-in/out in another tab) re-runs it (`:69-75`).

**Invariants**

| # | Invariant | Where | Proof |
| --- | --- | --- | --- |
| S-1 | Only a definite 401 (refused refresh, or 401 straight after a good refresh) yields `signed-out`. | `session-check.ts:44,57,61` | `tests/session-check.test.tsx:57-66` |
| S-2 | 5xx, 429, 408, timeout, network error → `unknown`; cookies are not cleared and `onSessionEnded` is not called. | `session-check.ts:35-38,44`; `lib/api/client.ts:352-363` | `tests/session-check.test.tsx:44-55`; `tests/session-recovery.test.ts:229,243` |
| S-3 | A signed-in area renders **no** chrome (rail, menu, brand colour, skeleton) before `signed-in`. | `SignedInGate.tsx:159-165`; brand style inside the gate `app/[orgSlug]/layout.tsx:31-34` | **no SignedInGate test found** (§10) |
| S-4 | `unknown` is never final: it re-checks with capped back-off. | `useSessionCheck.ts:17-22,53-55` | **no test of `retryDelay` / re-run found** |
| S-5 | A signed-in visitor on `/sign-in` or `/sign-up` sees "You're signed in as …" with Continue and Sign out, never the empty form. | `EntrySessionGate.tsx` (render branch for `signed-in`) | `tests/session-check.test.tsx:69`; e2e `e2e/tests/session-journeys.spec.ts:209` |
| S-6 | A second-factor return (`?google=mfa`, `?microsoft=mfa`, `?sso=mfa`) skips the check and shows the form that finishes it. | `EntrySessionGate.tsx:40,46` | no unit found |
| S-7 | The signed-out redirect keeps only an allowed return path (HT-5), and a workspace answers as its server gate does (portal → portal sign-in). | `SignedInGate.tsx:121-130` via `workspaceGate`, `signInPathFor` | covered by workspace-gate tests (not in this folder) |

## Public API and contracts

**Exports (the only public surface):**

| Export | File:line | Contract |
| --- | --- | --- |
| `type SessionCheck` | `lib/session-check.ts:21` | tri-state; add a state only with an ADR-0009 change |
| `checkSession(client, {mayHaveSession})` | `lib/session-check.ts:48` | never throws for HTTP outcomes |
| `isTransientFailure(error)` | `lib/session-check.ts:35` | true for non-`ApiRequestError`, `>= 500`, 429, 408 |
| `useSessionCheck({client, mayHaveSession, enabled?, boundary?})` → `{view, retryNow}` | `useSessionCheck.ts:34-39` | |
| `retryDelay(attempt)` | `useSessionCheck.ts:20` | |
| `SignedInGate`, `signedOutLocation` | `SignedInGate.tsx:121,132` | props `:105-118` (test seams: `client`, `boundary`, `mayHaveSession`, `navigate`) |
| `EntrySessionGate`, `isSecondStepReturn` | `EntrySessionGate.tsx:51,46` | prop `sessionHint` from `requestSessionHint()` (`lib/workspace-gate-request.ts:23`) |
| `SessionStatusCard`, `accountLabel`, `SignedInCard` | `SessionCards.tsx:20,51,62` | |

**API calls.** `GET /v1/sessions/current` → `{account:{email, displayName}}`
(`lib/api/session.ts:114-121`; API `apps/api/src/modules/identity/session.controller.ts:169-185`).
`POST /v1/sessions/refresh` through `ApiClient.resume` (`lib/api/client.ts:330-370`).
`DELETE /v1/sessions/current` from `SignedInCard` (sign out).

**Shape pairing (AR-10).** `e2e/contracts/api-web-shapes.ts:2983`
`Assert<Exact<ApiCurrentSessionView, WebCurrentSession>>`; `EstablishedSession` and
`SessionAccount` pairs imported at `:915-918`.

## Data: tables and migrations

n/a — a web part owns no tables. It reads only cookies: the readable CSRF cookie
(`browserMayHaveSession`, `lib/api/browser-client.ts:47-51`) and, on the server, the cookie hint
(`requestSessionHint`, `lib/workspace-gate-request.ts:23-27`). It never writes or clears a cookie;
the API does that on refresh refusal and sign-out.

## Permissions and tenant rules

- This part decides **only** "is there a session". **Membership, capabilities and audience stay the
  API's answer on every read** (`SignedInGate.tsx:100-103`), per AR-8.
- Trust zone: staff vs client is **not** in the session answer (`CurrentSessionView` has only
  `account`), so this gate cannot choose staff vs portal chrome from the server's answer. Today the
  workspace layout relies on `requestWorkspaceGate` (`app/[orgSlug]/layout.tsx:27-29`) and on
  `workspaceGate` path rules (`SignedInGate.tsx:127`). **DC-6 stays open** (§11).
- Platform admin: `SignedInGate` confirms the session; `PlatformAccessGate` then asks
  `/v1/platform/me` and keeps `unknown` as its own state (`components/platform/PlatformAccessGate.tsx:39`).

## Runtime, background work and failure modes

| Situation | Behaviour | Rule / pattern |
| --- | --- | --- |
| API restarting (503 with or without `Retry-After`) | `unknown` → "Can't reach TManage right now", retries 1/2/4/8/15 s | SE-2, HT-3, Release It! Timeouts + bounded retry |
| API hangs | `/v1/sessions/current` aborted after 10 s (`lib/api/session.ts:118`) → `unknown` | ST-1 |
| Refresh hangs | **no timeout on the refresh request** (`lib/api/client.ts:338-341` sends without `signal`) → the gate stays `checking` until the browser gives up | ST-1 gap (§11) |
| Refresh answered 403 | treated as `ended` (`lib/api/client.ts:353`) although HT-1 says 403 is a refusal, not missing credentials; the API's refresh only sends 401 | HT-1 (P2, §11) |
| Two tabs refresh at once | coalesced + cross-tab lock (`recovery.lock`), so only one rotation | DA-1 (lost update / reuse revocation avoided) |
| Second process on host (DC-3) | irrelevant here; the outcome only depends on the HTTP answer | RT-2 |
| Server render | no `location` on the server: second-step detection runs after hydration (`EntrySessionGate.tsx` `useEffect`) to keep SSR and first client render equal | IP-9 |

Retry is unbounded in count but bounded in rate (one request per 15 s per tab), which is the
intended "never final" behaviour; there is no jitter (P2).

## UX rules for its screens

**Screens / states.** No dedicated Figma frame is recorded for the session cards; they render
inside the identity shell of the sign-in screen (Figma `428:10174`, cited at
`app/ar/sign-in/page.tsx:7`). Persona journey: _a signed-in staff member during a deploy restart_
must see "Can't reach TManage right now", never a sign-in form, and land back in the workspace
without action (DC-1; e2e to build, §10).

| State (UX-23) | Render | Copy keys (all 10 present in all 8 catalogs: en, ar, de, es, fr, pt-BR, ur, zh-CN) |
| --- | --- | --- |
| loading = `checking` | `<p role="status">` in `IdentityShell` (`SessionCards.tsx:32-33`) | `SessionGate.checking` "Checking your sign-in…" (`messages/en.json:21041`) |
| error = `unknown` | `InlineAlert tone="warning" live` + "Try now" `Button tone="outline"` (`SessionCards.tsx:36-41`) | `SessionGate.unreachableTitle`, `.unreachableBody`, `.retryNow` (`en.json:21042-21044`) |
| signed-in on entry page | title, "You're signed in as {account}", Continue, Sign out (`SessionCards.tsx:98-130`) | `SessionGate.signedInTitle`, `.signedInAs`, `.continue`, `.signOut`, `.signingOut`, `.signOutFailed` (`en.json:21045-21050`) |
| signed-out | redirect (area) or the page's own form (entry) | — |
| empty | n/a — a session answer has no empty state | — |

Rules applied: **UX-23** (the four states above; the error is near its source and offers the next
step "Try now"). **UX-3** (feedback: `role="status"` for checking, live alert for unreachable).
**UX-14** (RTL: the account label is isolated with `<bdi>`, `SessionCards.tsx:57,103`, so a Latin
e-mail reads correctly in Arabic/Urdu). **UX-15/UX-24** (all copy from catalogs, sentence case,
plain words). **UX-8** (accessible authentication: the gate never blocks paste or password managers;
the entry gate shows the form at once when there is no cookie hint, so it never delays sign-in).
**UX-9** (native `<p>`, `Button`, no custom ARIA). **UX-10** (a signed-in visitor is not asked to
sign in again). **UX-17** ("checking" appears in the first HTML when the hint is set, so there is
no blank wait). **UX-4** (axe on these cards: not found in `tests/session-check.test.tsx`; gap).

## Standards that apply

| Rule | Today | Target |
| --- | --- | --- |
| SE-2 tri-state, one owner | implemented (`session-check.ts:21-62`) and used by every signed-in layout (§1) | ADR-0009 accepted; audience added (DC-6) |
| HT-2 one outcome classifier | **two copies**: `session-check.ts:35-38` and `apps/server/platform-gate.mjs:72-73` | one ESM classifier in `packages/contracts` (ADR-0009), both import it; lint bans ad-hoc `status >= 500` |
| HT-3 no silent collapse | non-401 → `unknown`, never `signed-out`; the sign-in provider probes follow it since `d1b06266` (`lib/api/provider-availability.ts`: only 404 or `available:false` hides a button; unknown keeps it and re-probes on `retryDelay`; a failed start is classified by `isTransientFailure`) | keep |
| HT-1 | refresh 403 → `ended` (`client.ts:353`) | treat 403 as `unknown` or prove the API never sends it for refresh |
| AR-8 / AR-9 | the gate reads the server's answer; no policy derived | keep; never default a decision with `??` here |
| AR-3 | reaches the API only over HTTP via `ApiClient` | keep |
| AR-10 | `CurrentSession` pair asserted (`e2e/contracts/api-web-shapes.ts:2983`) | keep |
| AR-12 | exact union types, no casts | keep |
| ST-1 | session read 10 s timeout; **refresh none** | `AbortSignal.timeout` on refresh |
| RT-4 | the web cannot fix readiness, but tolerates it (unknown + retry) | server side: ready after API + web only (app/server part) |
| PR-1 | tests for S-1, S-2 exist; S-3, S-4, S-6 have none | add §10 tests with revert proofs |
| IP-9 / IP-10 | client components at the leaves; effects only for real external sync (fetch, timers, boundary) | keep |
| IP-13 | unit + one e2e journey per state | add the 503 journey |
| UX-23, UX-14, UX-15 | met (§7) | add axe check (UX-4) |

## How to change this part

- **Never** add a fourth `SessionCheck` state or change what maps to `signed-out` without changing
  ADR-0009 and the tests in `tests/session-check.test.tsx`.
- A **new signed-in area**: wrap its `layout.tsx` in `<SignedInGate>` (pass `workspaceSlug` for
  `[orgSlug]` routes). Render nothing of the area outside it.
- A **new entry page**: wrap the form in `<EntrySessionGate sessionHint={await requestSessionHint()}>`.
- A **new status code meaning**: change the shared classifier only (today `isTransientFailure`;
  target `packages/contracts`) and `platform-gate.mjs` in the same commit until they are one.
- **Copy**: add keys under `SessionGate.*` in all 8 catalogs (`lib/i18n/messages/*.json`).
- Files that change together: `lib/session-check.ts` ↔ `apps/server/platform-gate.mjs` ↔
  `lib/api/client.ts` (`resume`) ↔ `tests/session-check.test.tsx`, `tests/session-recovery.test.ts`.
- Checks: web typecheck, `tests/session-*.test.*`, `e2e/tests/session-journeys.spec.ts`.

## Tests and fitness checks

- Unit: `apps/web/tests/session-check.test.tsx` — `:44` unknown for 503 / no answer; `:57`
  signed-out only for 401 with refused refresh; `:69` entry gate shows the signed-in card.
- Unit: `apps/web/tests/session-recovery.test.ts` — refresh coalescing `:130`, cross-tab lock `:144`,
  unreachable refresh does not end the session `:229`, API-faulted refresh does not end it `:243`.
- Unit: `apps/web/tests/session-flow.test.tsx` (sign-in/out boundary notices).
- E2E: `e2e/tests/session-journeys.spec.ts:86,140,182,209`.
- Contract: `e2e/contracts/api-web-shapes.ts:2983`.
- Fitness (FITNESS-FUNCTIONS SE-2): the doc names `apps/web/src/lib/session-check.test.ts`; the real
  file is `apps/web/tests/session-check.test.tsx`, with **2 of the §4 rows**. **To build:** one case
  per row incl. 429, 408, "401 → refresh unreachable → unknown", "401 → refresh ok → 401 → signed-out";
  `SignedInGate` renders no children before `signed-in`; `retryDelay` table; e2e "API 503 for 20 s →
  'Can't reach', cookies unchanged → recovers signed-in"; axe on both cards. Revert proof: change
  `session-check.ts:44` to return signed-out → `:44` test must fail.

## Open defects, decisions and risks

| Id | Class | Finding (verified at 3b7e4fa7) | Pri | Exit |
| --- | --- | --- | --- | --- |
| SS-1 | DC-2 inside DC-1 / HT-2 | classifier duplicated: `lib/session-check.ts:35-38` and `apps/server/platform-gate.mjs:72-73` | P1 | shared ESM classifier (ADR-0009) |
| SS-2 | DC-6 | session answer lacks `audience`; layouts cannot branch on the server's staff/client answer | P1 | API adds required `audience`; gate exposes it; e2e "client on staff URL → portal or 404" |
| SS-3 | ST-1 | refresh request has no timeout (`lib/api/client.ts:338-341`) | P1 | `AbortSignal.timeout` |
| SS-4 | HT-1 | refresh 403 → `ended` (`lib/api/client.ts:353`) | P2 | map 403 to `unknown` |
| SS-5 | PR-1 | missing tests for S-3, S-4, S-6, 429/408 rows and the 503 e2e journey; FITNESS-FUNCTIONS names a wrong path | P0 (e2e), P1 | §10 |
| SS-6 | DC-2 (neighbour) | **Fixed `fe4db511`:** both screens read `stepUpDecision()` (`lib/step-up-decision.ts`: known / loading / unknown) and cannot submit until known; `StepUpDecisionNotice` shows checking or cannot-reach-retry. Test: `tests/sign-in-security.test.tsx` (factors 503 → unknown, no `/v1/auth/reauth`). Sweep of `?? false` / `?? true` in `apps/web/src`: no other hit defaults a security decision open | closed | — |
| SS-7 | risk | retries have no jitter: after a restart every open tab re-checks on the same 1/2/4/8 s ticks | P2 | add ± jitter |

ADR-0009 (tri-state + one classifier) is **Proposed**; ADR-0010 (overlapping instances) is the
runtime side.

## Glossary

| Term | Meaning |
| --- | --- |
| signed-in / signed-out / unknown | the three answers of the session check; _unknown_ = the API gave no answer about the session |
| checking | the hook's state before the first answer |
| session hint | the server's reading of the readable CSRF cookie, used to choose the first HTML |
| entry page | `/sign-in`, `/sign-up` and their `/ar/` twins |
