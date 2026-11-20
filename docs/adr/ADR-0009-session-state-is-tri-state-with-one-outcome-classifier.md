# ADR-0009 — Session state is tri-state, and one shared classifier maps every HTTP answer to an outcome

- **Status:** Proposed (lane B, 2026-11-20)
- **Date:** 2026-11-20
- **Deciders:** Implementation lead; design review Fable 5.2
- **Rules affected:** HT-2, HT-3, SE-2, AR-9; **bends a rule:** no
- **Quality scenarios:** QA-AV-1, QA-AU-1
- **Evidence:** DC-1, 2026-11-20 (a valid session was shown the sign-in form during a deploy restart). Before AUTHSTATE, the committed sign-in page treated "any failure — 401, a network error, a 5xx" as "not signed in" (`git diff apps/web/src/lib/signed-in-destination.ts`). Working-tree fix: `apps/web/src/lib/session-check.ts:24-55`, `apps/server/platform-gate.mjs:70-75`.

## Context

RFC 9110 gives each status class a meaning. 401 means credentials are missing or invalid (§15.5.2). 5xx means the server failed (§15.6). 503 means a temporary condition, optionally with Retry-After (§15.6.4, §10.2.3). A 5xx or a network error therefore says nothing about identity.

The web asked a yes/no question ("is there a session?"), so "no answer" was reported as "no". The AUTHSTATE work introduces `signed-in | signed-out | unknown`, but the classification of a status now lives in two places: `session-check.ts:35` (TypeScript, web) and `platform-gate.mjs:73` (ESM, server). That is the rule-decided-twice class (DC-2) inside the fix for DC-1.

## Decision

1. One module, `packages/contracts/src/http-outcome.ts`, built to ESM so `apps/server/*.mjs`, `apps/web`, `apps/desktop` and `apps/mcp-server` can all import it. It exports `classify(statusOrError) → 'answer' | 'signed-out-candidate' | 'denied' | 'not-found' | 'unknown'`, following the table in ENGINEERING-STANDARD §4.
2. The session check is the only place that turns `signed-out-candidate` into `signed-out`, and only after one refresh (`session-check.ts:46-55`).
3. `unknown` never clears cookies, never renders the sign-in form, an empty state or "denied". It renders "Can't reach TManage, retrying" and retries, honouring `Retry-After`.
4. Decision fields from the API are required. Clients never default them (`?? false`).

## Alternatives considered

| Option                                          | Pros                       | Cons                                         | Why not chosen       |
| ----------------------------------------------- | -------------------------- | -------------------------------------------- | -------------------- |
| Keep two classifiers with a shared test fixture | no build change for `.mjs` | still two implementations                    | DC-2                 |
| Treat every non-2xx as unknown                  | never a false sign-out     | an expired session would never reach sign-in | breaks 401 semantics |

## Consequences

- Good: a deploy restart can no longer sign anyone out, and nobody can add a new collapse site without the lint failing.
- Cost: build `packages/contracts` to ESM for `apps/server`, add the lint rules, and migrate the sites listed in ARCH-REVIEW-AUTH-RUNTIME §DC-1.

## Fitness functions

| Rule | Check                                                                    | Exists / to build |
| ---- | ------------------------------------------------------------------------ | ----------------- |
| HT-2 | `http-outcome.test.ts`: table-driven over every row of the standard's §4 | to build          |
| HT-3 | ESLint catch-collapse selectors                                          | to build          |
| SE-2 | `session-check.test.ts` + e2e "API 503 for 20 s"                         | to build          |
| AR-9 | ESLint `??`-on-decision selector                                         | to build          |
