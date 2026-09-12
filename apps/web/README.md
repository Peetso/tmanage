# `@tmanage/web` — the team application and the client portal

WEB-001 in `docs/planning/28-SPRINT-TICKETS-AND-ESTIMATES.md`: the identity and onboarding
screens, and the Next.js application they live in.

```bash
pnpm --filter @tmanage/web dev     # http://localhost:3000
pnpm --filter @tmanage/web test
pnpm --filter @tmanage/web build
```

The API must be running separately on `NEXT_PUBLIC_API_BASE_URL` (default
`http://localhost:3001` in development) for the screens that talk to it.

## Where the API is, and why it matters

`src/lib/public-config.ts` holds the rules; `next.config.ts` runs them at build time and
`src/lib/api/browser-client.ts` at run time. A production build (`next build`) **refuses** to
proceed with `NEXT_PUBLIC_API_BASE_URL` absent, plain-http, or pointing at a loopback address
(review finding D19, 2026-09-05 — it used to compile `localhost:3001` into the bundle and
ship).

| Topology                         | `NEXT_PUBLIC_API_BASE_URL` | Also                                               | When                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | -------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Same-origin** (production)     | `same-origin`              | `API_PROXY_TARGET` = the API's origin, server-side | `50-BOOTSTRAP` §3 deploys the web app and the API as two Node applications, which on the target host is two hostnames. Next rewrites `/v1/*` to the API; the browser sees one origin. The target may be plain http only when it is loopback (the API on the same machine); another host must be https |
| Split origin, same host name     | `http://localhost:3101`    | —                                                  | Development and the e2e stack: two ports on `localhost`. Cookies ignore the port, so the API's readable CSRF cookie is readable here                                                                                                                                                                  |
| Split origin, sibling subdomains | —                          | —                                                  | **Not supported.** The API's cookies are host-only; the page's script cannot read the CSRF cookie and cannot refresh after a reload (review finding D03). Use same-origin                                                                                                                             |

The rewrite keeps the path identical (`/v1/:path*` to `/v1/:path*`), because the API scopes
its refresh cookie to `Path=/v1/sessions/refresh`; a prefix on the browser side would leave
the browser holding a cookie for a path it never requests.

`NEXT_PUBLIC_SESSION_COOKIE_NAME` must equal the API's `SESSION_COOKIE_NAME`; both default to
`tmanage_session` (review finding D02 — the browser used to default to a different name, and
the readable CSRF cookie was never found). `tests/public-config.test.ts` imports both defaults
and holds them equal.

## The session in the browser

Three things happen at the client that no screen has to remember:

- **A change of principal is a boundary** (`src/lib/auth-boundary.ts`, review finding D01).
  Sign-in, sign-out and a session the API ended are announced; `AuthBoundaryProvider` cancels
  every in-flight query, clears the query and mutation caches, and sends the tab to sign-in
  when it has no session left. Other tabs hear it over a same-origin `BroadcastChannel`
  carrying the event name and nothing else.
- **An expired access token is refreshed, once, and the refused request replayed, once**
  (`src/lib/api/client.ts`, review finding D04) — coalesced within the tab and serialised
  across tabs with `navigator.locks`, because two tabs presenting one refresh token at once
  is exactly what the API's reuse detection revokes a session for. A refresh the API refuses
  ends the session cleanly; a refresh that never reaches the API ends nothing.
- **The CSRF token the API returned is kept in memory** and preferred over the cookie, so a
  tab that signed in can mutate even where the cookie is not readable. It dies with the tab.

## What is in here

| Path                      | What it is                                                               |
| ------------------------- | ------------------------------------------------------------------------ |
| `src/app/`                | Routes. Every page is thin — it resolves params and renders a screen     |
| `src/components/shell/`   | The four shells: internal app, client portal, identity, onboarding       |
| `src/components/screens/` | The nine screens, each a client component so it can be mounted in a test |
| `src/lib/api/`            | The one way this application talks to the API                            |
| `src/lib/`                | Pure logic the screens use — slugs, invitation checks, fixtures          |
| `src/fonts/`              | Manrope and its OFL licence (ADR-0005)                                   |
| `tests/`                  | The screen harness — behaviour, axe, and the contrast arithmetic         |

## The screens, and how much of each one is real

`22-SCREEN-BY-SCREEN-SPEC.md` §3 is the specification. Nine screens are built. Most of them
have no server behind them yet, and **every one of those says so on the screen**, naming the
ticket that will close it — see `src/components/screens/BackendPending.tsx`.

| Screen                      | Route                      | Backed by                                                                   |
| --------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| ID-01 Sign in               | `/sign-in`                 | The development-only sign-in route. Passwords, passkeys and SSO are ID-002  |
| ID-02 MFA challenge         | `/sign-in/verify`          | Nothing. ID-002                                                             |
| ID-03 Invitation acceptance | `/invitations/[token]`     | Nothing. TEN-003                                                            |
| ID-04 Organization selector | `/organizations`           | Nothing. TEN-001's unbuilt half                                             |
| ID-05 Sessions and devices  | `/sessions`                | **Real.** `GET /v1/sessions/current/devices`, `DELETE /v1/sessions/current` |
| ID-05 Recovery              | `/recover`                 | Nothing. ID-002. Request state only — see below                             |
| ON-01 Create organization   | `/onboarding/organization` | Nothing. TEN-001                                                            |
| ON-02 Operating template    | `/onboarding/template`     | Nothing. TEN-001                                                            |
| ON-03 First project         | `/onboarding/project`      | Nothing. PROJ-001                                                           |
| ON-04 Invite team           | `/onboarding/team`         | Nothing. TEN-003                                                            |

`/recover` takes no query parameters. Every URL renders the request state; there is no
`?state=` to set. `RecoveryScreen` still holds all four states as a component API —
`41-WHOLE-APP-SCREEN-AND-STATE-MATRIX.md` line 36 approves them for ID-05, and the design
has to stay reviewable — but `sent` and `completed` assert that an email went out, that
other sessions were ended and that an audit row was written, so no URL may select them: a
query string is not a result (D15). Only a caller holding a real one may ask for those
states, and there is no such caller until ID-002 builds the operation that produces one.

`/sign-in/verify` takes no query parameters either, for the same reason. It used to read
`?state=rate-limited` and pass it to `MfaChallengeScreen`, which says "The attempt was recorded
in the audit log" — a URL cannot refuse an attempt or append a row. `41` line 33 approves "rate
limit" as an ID-02 state so the `rateLimited` prop stays, and unlike ID-05's outcome states the
claim is one the API can substantiate: `POST /v1/auth/mfa` answers a flooded attempt with 429
`rate_limited` and writes the refusal to the audit log first. Only a caller holding that 429 may
ask for the state; the screen does not yet turn a 429 into one, which is sign-in work.

The screen ids are the **specification's**. The design export numbers its onboarding
artboards differently — it opens with a "what do you deliver" step and inserts a milestones
step, so its `ON-04` is the specification's `ON-03`. `docs/implementation-status.md` carries
the mapping.

Nothing on these screens simulates a server. A control whose endpoint does not exist is
`disabled`; a list that has no endpoint is passed in from `src/lib/fixtures.ts`, which exists
so that the extent of what is not connected is countable in one file.

## The two shells

`22-SCREEN-BY-SCREEN` §1 defines an internal shell and a client shell. They are two
components, not one component with a flag, because a client sees a _different_ space rather
than a reduced one. `CLIENT_NAVIGATION` is the only list `ClientPortalShell` can render, so
no future internal destination can leak into the portal through a forgotten filter —
`tests/shells.test.tsx` asserts exactly that.

## Talking to the API

`src/lib/api/client.ts` is the only place a request is built. Three things happen on every
request because they are not parameters:

- `credentials: 'include'`, so the session cookies reach the API's origin;
- the CSRF token echoed in `x-csrf-token` on every unsafe method, read from the readable
  cookie the API sets (see ADR-0004 for why that cookie is safe to read);
- a correlation id in `x-correlation-id`, so a refusal can be traced.

The client takes `fetch`, the cookie reader and the id source as parameters, so
`tests/api-client.test.ts` asserts on the request that was actually built rather than on a
mock of the module that builds it.

The API's error envelope is re-declared by hand in `src/lib/api/errors.ts`. That is a lint
boundary: `apps/web` may not import `@tmanage/api`. When `packages/contracts` is generated
from `contracts/openapi.yaml` those declarations are replaced by the generated ones.

## Accessibility

`A11Y-01` in `27-TEST-CATALOG.md` is satisfied structurally: the shells own the skip link,
the `<main>` landmark and the single `<h1>`, so a screen cannot omit one. `tests/screens.test.tsx`
runs axe over every screen and asserts all three.

Two limits are worth stating rather than implying:

- axe runs in **jsdom**, which does not lay out or paint, so its `color-contrast` rule is
  disabled — it would report "incomplete" and a green run would have checked nothing. The
  palette is checked arithmetically in `tests/contrast.test.ts` instead.
- Arithmetic on token values cannot prove what a browser renders. A gradient, an overlay or
  an inherited colour can still ruin a pairing, and only a real browser and a real screen
  reader can say. Those checks are recorded as open in `docs/implementation-status.md`.

`tests/contrast.test.ts` also holds `globals.css` to two structural rules: it contains no
colour literal at all — every colour is a token, so it inherits `packages/ui`'s drift check
against the immutable export — and every breakpoint is in `rem` rather than `px`, so 200%
zoom actually reaches it.
